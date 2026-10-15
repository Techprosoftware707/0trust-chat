#!/usr/bin/env bash
# Lumen backup verification and restore.
#
#   sudo ./restore.sh --verify-only latest        # integrity + isolated test restore
#   sudo ./restore.sh --verify-only FILE.tar.age
#   sudo ./restore.sh FILE.tar.age|latest [--with-config] [--yes --confirm SERVER_NAME]
#
# --verify-only never touches production: it checks the checksum, decrypts into a
# root-only temp dir, checks every file against the manifest, restores both
# databases into a throw-away PostgreSQL container without network access and
# runs sanity queries.
#
# A full restore asks for typed confirmation, takes a safety backup first, and
# replaces the databases, media store and homeserver signing key.

set -o errexit -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"
source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"

VERIFY_ONLY=0; WITH_CONFIG=0; ASSUME_YES=0; CONFIRM=""; QUIET=0; SAFETY=1; ARCHIVE=""
IDENTITY="$LUMEN_CONFIG_DIR/backup/identity.txt"
while (($#)); do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --with-config) WITH_CONFIG=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --confirm) CONFIRM="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --no-safety-backup) SAFETY=0; shift ;;
    --quiet) QUIET=1; shift ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 64 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
require_root
((QUIET)) && exec 3>&1 1>/dev/null || exec 3>&1
log_init restore
[[ -n "$ARCHIVE" ]] || die "which backup? pass a file or 'latest'"

dest="$(conf_get BACKUP_DIR /var/backups/lumen)"
if [[ "$ARCHIVE" == latest ]]; then
  ARCHIVE="$(ls -1t "$dest"/lumen-*.tar.age 2>/dev/null | head -n1 || true)"
  [[ -n "$ARCHIVE" ]] || die "no backups found in $dest"
fi
[[ -f "$ARCHIVE" ]] || die "backup not found: $ARCHIVE"
[[ -s "$IDENTITY" ]] || die "backup identity $IDENTITY not found. Copy your offline backup key there (or pass --identity)."

exec 8>/run/lumen-backup.lock
flock -n 8 || die "another backup or restore is running"

work="$(mktemp -d /var/tmp/lumen-restore.XXXXXX)"
chmod 0700 "$work"
verify_container=""
cleanup() {
  [[ -n "$verify_container" ]] && docker rm -f "$verify_container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail_verify() {
  ((VERIFY_ONLY)) && write_status_json backup "last_verify_result=failed: $1" "last_verify_attempt_at=$(date -u +%FT%TZ)" "running="
  die "$1"
}

step "Checking archive integrity: $(basename "$ARCHIVE")"
if [[ -f "$ARCHIVE.sha256" ]]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c --quiet "$(basename "$ARCHIVE").sha256") >>"$_log_file" 2>&1 \
    || fail_verify "checksum mismatch: the archive is corrupted or was modified"
  ok "outer SHA-256 matches"
else
  warn "no .sha256 file next to the archive; relying on age's authenticated encryption"
fi
age --decrypt -i "$IDENTITY" "$ARCHIVE" 2>>"$_log_file" | tar -C "$work" -xf - 2>>"$_log_file" \
  || fail_verify "decryption failed: wrong identity key or damaged archive (age authenticates every chunk)"
ok "decrypted with $(basename "$IDENTITY") (authenticated)"
python3 - "$work" <<'PY' >>"$_log_file" 2>&1 || fail_verify "manifest check failed: a file inside the archive does not match its recorded SHA-256"
import hashlib, json, os, sys
work = sys.argv[1]
m = json.load(open(os.path.join(work, "manifest.json")))
for rel, meta in m["files"].items():
    h = hashlib.sha256()
    with open(os.path.join(work, rel), "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != meta["sha256"]:
        print("MISMATCH", rel); sys.exit(1)
print("manifest ok", len(m["files"]))
PY
manifest_get() { python3 -c "import json,sys; print(json.load(open('$work/manifest.json')).get('$1',''))"; }
ok "all $(python3 -c "import json; print(len(json.load(open('$work/manifest.json'))['files']))") files match the manifest"
info "backup of server '$(manifest_get server_name)', created $(manifest_get created_at), Lumen $(manifest_get lumen_version)"
key_id="$(awk '{print $1":"$2}' "$work/synapse/signing.key")"
[[ "$key_id" == "$(manifest_get signing_key_id)" ]] || fail_verify "signing key id mismatch"
ok "homeserver signing key present ($key_id)"

source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"
set -a; source "$LUMEN_RENDERED_DIR/compose.env"; set +a

restore_into() {
  # restore_into <psql-runner...> — create DBs and pg_restore both dumps
  "$@" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q -c "CREATE ROLE lumen_app LOGIN" 2>/dev/null || true
  "$@" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q -c "CREATE ROLE synapse LOGIN" 2>/dev/null || true
  "$@" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q -c "CREATE DATABASE lumen OWNER lumen_app ENCODING 'UTF8' TEMPLATE template0" \
    || return 1
  "$@" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q -c "CREATE DATABASE synapse OWNER synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0" \
    || return 1
  "$@" pg_restore -U postgres -d lumen --no-owner --role=lumen_app --exit-on-error <"$work/db/lumen.dump" || return 1
  "$@" pg_restore -U postgres -d synapse --no-owner --role=synapse --exit-on-error <"$work/db/synapse.dump" || return 1
}

if ((VERIFY_ONLY)); then
  write_status_json backup "running=verify"
  step "Test restore into an isolated, temporary PostgreSQL (no network)"
  verify_container="lumen-restore-verify-$$"
  docker run -d --name "$verify_container" --network none --user 70:70 \
    -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" -e PGDATA=/tmp/pgdata --tmpfs /tmp:size=4g \
    --tmpfs /var/run/postgresql:uid=70,gid=70 "$POSTGRES_IMAGE" >>"$_log_file" 2>&1 \
    || fail_verify "could not start the temporary database"
  for _ in $(seq 1 60); do
    docker exec "$verify_container" pg_isready -U postgres >/dev/null 2>&1 && sleep 2 && break
    sleep 1
  done
  restore_into docker exec -i "$verify_container" >>"$_log_file" 2>&1 || fail_verify "pg_restore failed in the isolated database"
  ok "both databases restored"
  q() { docker exec -i "$verify_container" psql -U postgres -d "$1" -tAc "$2"; }
  users="$(q synapse 'SELECT count(*) FROM users')"
  rooms="$(q synapse 'SELECT count(*) FROM rooms')"
  events="$(q synapse 'SELECT count(*) FROM events')"
  enc="$(q synapse "SELECT count(*) FROM events WHERE type = 'm.room.encrypted'")"
  schema="$(q synapse 'SELECT version FROM schema_version')"
  portal_users="$(q lumen 'SELECT count(*) FROM accounts_user')"
  migrations="$(q lumen 'SELECT count(*) FROM django_migrations')"
  audit_rows="$(q lumen 'SELECT count(*) FROM core_auditevent')"
  ok "homeserver: $users users, $rooms rooms, $events events ($enc encrypted), schema v$schema"
  ok "portal: $portal_users accounts, $migrations migrations applied, $audit_rows audit events"
  if [[ -f "$work/synapse/media.tar" ]]; then
    n="$(tar -tf "$work/synapse/media.tar" | grep -vc '/$' || true)"
    ok "media archive readable ($n files)"
  fi
  write_status_json backup "running=" "last_verified_at=$(date -u +%FT%TZ)" \
    "last_verify_result=ok: $(basename "$ARCHIVE") — $users users, $rooms rooms, $events events, $portal_users accounts" \
    "last_verified_name=$(basename "$ARCHIVE")"
  printf 'verify ok: %s\n' "$(basename "$ARCHIVE")" >&3
  exit 0
fi

# ------------------------------- full restore ----------------------------------------
server_name="$(conf_get MATRIX_SERVER_NAME "$(conf_get LUMEN_PRIMARY_DOMAIN)")"
backup_server="$(manifest_get server_name)"
if [[ "$backup_server" != "$server_name" ]]; then
  warn "this backup belongs to '$backup_server' but this server is configured as '$server_name'."
  warn "Matrix server names cannot change; restore with --with-config on a server set up for '$backup_server'."
  ((WITH_CONFIG)) || die "server name mismatch"
fi
cat >&3 <<EOF

${C_BOLD}What a restore brings back${C_RESET}
  • Accounts, rooms, room membership and the full (encrypted) message history up to the backup time
  • Device lists, public device and cross-signing keys, and users' encrypted key backups
  • The homeserver signing key, so other servers keep recognising this server
  • Portal accounts, workspaces, plans, subscriptions and the audit log

${C_BOLD}What it cannot bring back${C_RESET}
  • Anything sent or uploaded after $(manifest_get created_at)
  • Message keys: they never existed on the server. Users decrypt history with their existing
    devices or by entering their recovery key (secure backup). Users without either cannot
    read old encrypted messages — this is by design.
  • Devices may need to sign in again if they registered after the backup.

This replaces the CURRENT databases and media of '$server_name'.
EOF
if ((ASSUME_YES)); then
  [[ "$CONFIRM" == "$server_name" ]] || die "--yes requires --confirm $server_name"
else
  read -r -p "Type the server name ($server_name) to continue: " ans </dev/tty
  [[ "$ans" == "$server_name" ]] || die "confirmation did not match; nothing changed"
fi

if ((SAFETY)); then
  step "Safety backup of the current state"
  flock -u 8
  "$LUMEN_REPO_DIR/backup.sh" --quiet --tag pre-restore --no-remote >>"$_log_file" 2>&1 \
    && ok "current state saved (tag pre-restore)" \
    || die "safety backup failed; refusing to overwrite production"
  exec 8>/run/lumen-backup.lock; flock -n 8 || die "lock lost"
fi

data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
step "Stopping services"
run compose stop caddy portal ops worker synapse livekit lkjwt || true
run compose up -d postgres
wait_health postgres healthy 120 || die "PostgreSQL not healthy"

if ((WITH_CONFIG)); then
  step "Restoring configuration and secrets"
  cp -p "$work/config/lumen.conf" "$LUMEN_CONF"
  rm -rf "$LUMEN_SECRETS_DIR.pre-restore"; cp -rp "$LUMEN_SECRETS_DIR" "$LUMEN_SECRETS_DIR.pre-restore"
  cp -rp "$work/config/secrets/." "$LUMEN_SECRETS_DIR/"
  [[ -d "$work/config/branding" ]] && cp -rp "$work/config/branding/." "$LUMEN_BRANDING_DIR/"
  [[ -d "$work/config/wireguard" ]] && { install -d -m 0700 "$LUMEN_CONFIG_DIR/wireguard"; cp -rp "$work/config/wireguard/." "$LUMEN_CONFIG_DIR/wireguard/"; }
  ensure_secrets
  ok "configuration restored (previous secrets kept in $LUMEN_SECRETS_DIR.pre-restore)"
fi

step "Restoring databases"
run compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS lumen WITH (FORCE)" \
  && run compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS synapse WITH (FORCE)" \
  || die "could not drop the current databases"
restore_into compose exec -T postgres >>"$_log_file" 2>&1 || die "pg_restore failed; the safety backup is in $dest (tag pre-restore)"
reconcile_db_roles
ok "databases restored"

step "Restoring homeserver identity and media"
ts="$(date +%s)"
if [[ -f "$data/synapse/signing.key" ]] && ! cmp -s "$data/synapse/signing.key" "$work/synapse/signing.key"; then
  cp -p "$data/synapse/signing.key" "$data/synapse/signing.key.pre-restore-$ts"
  warn "the signing key differs from the current one; restoring the backed-up key (old key kept)"
fi
install -m 0600 -o "$UID_SYNAPSE" -g "$UID_SYNAPSE" "$work/synapse/signing.key" "$data/synapse/signing.key"
if [[ -f "$work/synapse/media.tar" ]]; then
  [[ -d "$data/synapse/media_store" ]] && mv "$data/synapse/media_store" "$data/synapse/media_store.pre-restore-$ts"
  tar -C "$data/synapse" -xf "$work/synapse/media.tar"
  chown -R "$UID_SYNAPSE:$UID_SYNAPSE" "$data/synapse/media_store"
  ok "media restored (previous media kept in media_store.pre-restore-$ts until you delete it)"
fi
if [[ -f "$work/caddy/data.tar" && ! -d "$data/caddy/data/caddy/certificates" ]]; then
  tar -C "$data/caddy" -xf "$work/caddy/data.tar" && chown -R "$UID_CADDY:$UID_CADDY" "$data/caddy/data"
fi

step "Starting services"
ensure_ca_bundle_file
render_staging; validate_staging; promote_staging
run compose run --rm migrate || die "migrations after restore failed"
start_services
printf '\nRestore complete. Run sudo ./healthcheck.sh and check the console. Safety backup: %s (tag pre-restore).\n' "$dest" >&3
