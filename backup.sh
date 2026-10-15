#!/usr/bin/env bash
# Lumen encrypted backup.
#
#   sudo ./backup.sh [--quiet] [--tag NAME] [--no-media] [--no-remote]
#
# Produces BACKUP_DIR/lumen-<host>-<UTC timestamp>[-tag].tar.age (+ .sha256):
#   manifest.json        versions, server name, signing key id, per-file SHA-256
#   db/lumen.dump        pg_dump (custom format) of the portal database
#   db/synapse.dump      pg_dump (custom format) of the homeserver database
#   synapse/signing.key  homeserver federation signing key (server identity)
#   synapse/media.tar    uploaded media (ciphertext for encrypted rooms)
#   config/              lumen.conf, secrets/, branding/, wireguard/ (if any)
#   caddy/data.tar       TLS certificates and ACME account
# The archive is encrypted with age to the recipients in /etc/lumen/backup/
# recipients.txt. Plaintext never touches BACKUP_DIR: staging happens in a
# root-only temporary directory that is removed afterwards.

set -o errexit -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"

QUIET=0; TAG=""; MEDIA=1; REMOTE=1
while (($#)); do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --no-media) MEDIA=0; shift ;;
    --no-remote) REMOTE=0; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[[ "$TAG" =~ ^[a-z0-9-]*$ ]] || die "tag must be lowercase letters, digits and dashes"
require_root
((QUIET)) && exec 3>&1 1>/dev/null || exec 3>&1
log_init backup

BACKUP_LOCK=/run/lumen-backup.lock
exec 8>"$BACKUP_LOCK"
flock -n 8 || die "another backup or restore is running"

data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
dest="$(conf_get BACKUP_DIR /var/backups/lumen)"
recipients="$LUMEN_CONFIG_DIR/backup/recipients.txt"
[[ -s "$recipients" ]] || die "no backup recipients ($recipients); run install.sh"
install -d -m 0700 "$dest"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="lumen-$(hostname -s)-$stamp${TAG:+-$TAG}"
work="$(mktemp -d /var/tmp/lumen-backup.XXXXXX)"
chmod 0700 "$work"
cleanup() { rm -rf "$work" "$dest/.$name.partial"; }
trap cleanup EXIT

record_failure() {
  write_status_json backup "last_result=failed" "last_error=$1" "last_attempt_at=$(date -u +%FT%TZ)"
  die "$1"
}

write_status_json backup "last_attempt_at=$(date -u +%FT%TZ)" "running=backup"
step "Backing up databases"
mkdir -p "$work/db" "$work/synapse" "$work/config" "$work/caddy"
for db in lumen synapse; do
  compose exec -T postgres pg_dump -U postgres -d "$db" --format=custom --no-owner --compress=6 >"$work/db/$db.dump" 2>>"$_log_file" \
    || record_failure "pg_dump of $db failed"
  [[ -s "$work/db/$db.dump" ]] || record_failure "pg_dump of $db produced no data"
  ok "$db database ($(du -h "$work/db/$db.dump" | cut -f1))"
done

step "Backing up homeserver identity and media"
cp -p "$data/synapse/signing.key" "$work/synapse/signing.key" || record_failure "signing key missing"
if ((MEDIA)) && [[ -d "$data/synapse/media_store" ]]; then
  tar -C "$data/synapse" -cf "$work/synapse/media.tar" media_store 2>>"$_log_file" || record_failure "media archive failed"
  ok "media store ($(du -h "$work/synapse/media.tar" | cut -f1))"
fi

step "Backing up configuration and secrets"
cp -p "$LUMEN_CONF" "$work/config/lumen.conf"
cp -rp "$LUMEN_SECRETS_DIR" "$work/config/secrets"
[[ -d "$LUMEN_BRANDING_DIR" ]] && cp -rp "$LUMEN_BRANDING_DIR" "$work/config/branding"
[[ -d "$LUMEN_CONFIG_DIR/wireguard" ]] && cp -rp "$LUMEN_CONFIG_DIR/wireguard" "$work/config/wireguard"
[[ -d "$data/caddy/data" ]] && tar -C "$data/caddy" -cf "$work/caddy/data.tar" data 2>>"$_log_file"
ok "configuration, secrets, branding$( [[ -d "$LUMEN_CONFIG_DIR/wireguard" ]] && echo ", wireguard"), TLS state"

step "Writing manifest"
python3 - "$work" "$name" <<'PY'
import hashlib, json, os, sys, datetime, re
work, name = sys.argv[1:3]
files = {}
for root, _, fnames in os.walk(work):
    for f in fnames:
        p = os.path.join(root, f)
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        files[os.path.relpath(p, work)] = {"sha256": h.hexdigest(), "size": os.path.getsize(p)}
conf = {}
for line in open(os.path.join(work, "config/lumen.conf")):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.strip().split("=", 1); conf[k] = v
key = open(os.path.join(work, "synapse/signing.key")).read().split()
versions = dict(l.strip().split("=", 1) for l in open(os.environ.get("LUMEN_REPO_DIR", ".") + "/deploy/versions.env") if "=" in l and not l.startswith("#"))
manifest = {
    "format": 1,
    "name": name,
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "server_name": conf.get("MATRIX_SERVER_NAME") or conf.get("LUMEN_PRIMARY_DOMAIN"),
    "primary_domain": conf.get("LUMEN_PRIMARY_DOMAIN"),
    "signing_key_id": f"{key[0]}:{key[1]}" if len(key) >= 2 else "",
    "lumen_version": versions.get("LUMEN_VERSION"),
    "synapse_image": versions.get("SYNAPSE_IMAGE"),
    "postgres_image": versions.get("POSTGRES_IMAGE"),
    "files": files,
}
json.dump(manifest, open(os.path.join(work, "manifest.json"), "w"), indent=2)
PY
ok "manifest with SHA-256 of $(find "$work" -type f | wc -l) files"

step "Encrypting archive"
tar -C "$work" -cf - . | age --encrypt -R "$recipients" -o "$dest/.$name.partial" 2>>"$_log_file" \
  || record_failure "encryption failed"
mv "$dest/.$name.partial" "$dest/$name.tar.age"
chmod 0600 "$dest/$name.tar.age"
(cd "$dest" && sha256sum "$name.tar.age" >"$name.tar.age.sha256" && chmod 0600 "$name.tar.age.sha256")
size_h="$(du -h "$dest/$name.tar.age" | cut -f1)"
ok "$dest/$name.tar.age ($size_h, encrypted to $(wc -l <"$recipients") recipient(s))"

step "Applying retention"
keep_daily="$(conf_get BACKUP_KEEP_DAILY 7)"; keep_weekly="$(conf_get BACKUP_KEEP_WEEKLY 4)"
python3 - "$dest" "$keep_daily" "$keep_weekly" <<'PY' | while read -r f; do rm -f -- "$f" "$f.sha256"; echo "    removed $(basename "$f")"; done
import os, re, sys, datetime
dest, daily, weekly = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rx = re.compile(r"^lumen-.+-(\d{8}T\d{6}Z)(-[a-z0-9-]+)?\.tar\.age$")
items = []
for f in os.listdir(dest):
    m = rx.match(f)
    if m:
        items.append((datetime.datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ"), os.path.join(dest, f), m.group(2) or ""))
items.sort(reverse=True)
keep = set(p for _, p, _ in items[:daily])
weeks = {}
for ts, p, _ in items:
    wk = ts.isocalendar()[:2]
    if wk not in weeks:
        weeks[wk] = p
for wk in sorted(weeks, reverse=True)[:weekly]:
    keep.add(weeks[wk])
# Pre-update/pre-restore safety backups are kept for 30 days regardless.
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
for ts, p, tag in items:
    if tag and (now - ts).days < 30:
        keep.add(p)
for _, p, _ in items:
    if p not in keep:
        print(p)
PY

remote="$(conf_get BACKUP_REMOTE "")"
remote_note=""
if ((REMOTE)) && [[ -n "$remote" ]]; then
  step "Copying to off-site destination"
  ssh_key="$LUMEN_CONFIG_DIR/backup/ssh_key"
  rsync_args=(-a --partial)
  [[ -s "$ssh_key" ]] && rsync_args+=(-e "ssh -i $ssh_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
  if rsync "${rsync_args[@]}" "$dest/$name.tar.age" "$dest/$name.tar.age.sha256" "$remote/" >>"$_log_file" 2>&1; then
    ok "copied to $remote"; remote_note="$remote"
  else
    warn "off-site copy to $remote failed (local backup is fine)"; remote_note="failed"
  fi
fi

write_status_json backup "last_result=ok" "last_error=" "last_success_at=$(date -u +%FT%TZ)" \
  "last_name=$name.tar.age" "last_size_human=$size_h" "running=" "last_remote=$remote_note"
printf 'backup ok: %s/%s.tar.age (%s)\n' "$dest" "$name" "$size_h" >&3
