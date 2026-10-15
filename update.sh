#!/usr/bin/env bash
# Update Lumen safely.
#
#   sudo ./update.sh [--no-pull] [--no-backup] [--yes]
#
# 1. takes an encrypted pre-update backup (tag pre-update)
# 2. fetches the new code (git pull --ff-only) unless --no-pull
# 3. renders and validates the new configuration in a staging directory
# 4. pulls pinned images, builds the portal image and the chat app
# 5. runs database migrations, recreates services, waits for health checks
# 6. verifies the public endpoints
# On failure it restores the previous configuration, images and chat build and
# restarts them. Database migrations cannot be undone automatically: if a
# migration ran, restore the pre-update backup with restore.sh (printed below).
# Configuration, data, secrets and the homeserver signing key are preserved.

set -o errexit -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"
source "$LUMEN_REPO_DIR/deploy/lib/host.sh"
source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"
source "$LUMEN_REPO_DIR/deploy/lib/verify.sh"
source "$LUMEN_REPO_DIR/deploy/lib/wireguard.sh"

PULL=1; BACKUP=1; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --no-pull) PULL=0 ;;
    --no-backup) BACKUP=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 64 ;;
  esac
done
require_root
[[ -f "$LUMEN_CONF" ]] || die "Lumen is not installed here (no $LUMEN_CONF). Run install.sh first."
with_lock
log_init update

old_version="$(state_get version)"
old_commit="$(git -C "$LUMEN_REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
write_status_json update "running=update" "started_at=$(date -u +%FT%TZ)"
fail_update() {
  write_status_json update "running=" "last_update_at=$(date -u +%FT%TZ)" "last_result=failed: $1"
  die "$1"
}

if ((BACKUP)); then
  step "Pre-update backup"
  "$LUMEN_REPO_DIR/backup.sh" --quiet --tag pre-update >>"$_log_file" 2>&1 || fail_update "pre-update backup failed; nothing was changed"
  pre_backup="$(ls -1t "$(conf_get BACKUP_DIR /var/backups/lumen)"/*-pre-update.tar.age | head -n1)"
  ok "saved $pre_backup"
fi

if ((PULL)) && [[ -d "$LUMEN_REPO_DIR/.git" ]]; then
  step "Fetching new code"
  if [[ -n "$(git -C "$LUMEN_REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
    fail_update "local modifications in $LUMEN_REPO_DIR; commit or stash them, or run with --no-pull"
  fi
  run git -C "$LUMEN_REPO_DIR" pull --ff-only || fail_update "git pull failed (diverged history?). Resolve it manually, then re-run."
  ok "code at $(git -C "$LUMEN_REPO_DIR" rev-parse --short HEAD) (was $old_commit)"
  # Re-exec so the rest runs with the updated scripts.
  if [[ "${LUMEN_UPDATE_REEXEC:-0}" != 1 ]]; then
    flock -u 9 || true
    reexec_args=(--no-pull --no-backup)
    ((ASSUME_YES)) && reexec_args+=(--yes)
    LUMEN_UPDATE_REEXEC=1 exec "$LUMEN_REPO_DIR/update.sh" "${reexec_args[@]}"
  fi
fi
new_version="$(grep -E '^LUMEN_VERSION=' "$LUMEN_REPO_DIR/deploy/versions.env" | cut -d= -f2)"
info "updating Lumen ${old_version:-?} → $new_version"

step "Validating new configuration"
ensure_dirs
ensure_secrets
ensure_ca_bundle_file
render_staging
validate_staging

step "Preparing images"
set -a; source "$LUMEN_CONFIG_DIR/rendered.staging/compose.env"; set +a
if docker image inspect "$PORTAL_IMAGE" >/dev/null 2>&1; then run docker tag "$PORTAL_IMAGE" lumen/portal:rollback; fi
chat_dist="$(conf_get CHAT_DIST_DIR "$(conf_get LUMEN_DATA_DIR /var/lib/lumen)/www/chat")"
promote_staging
pull_images
build_portal
build_chat

rollback() {
  warn "update failed — rolling back configuration, portal image and chat app"
  rollback_config || true
  docker image inspect lumen/portal:rollback >/dev/null 2>&1 && run docker tag lumen/portal:rollback "$PORTAL_IMAGE" || true
  [[ -d "$chat_dist.prev" ]] && { rm -rf "$chat_dist.failed"; mv "$chat_dist" "$chat_dist.failed"; mv "$chat_dist.prev" "$chat_dist"; } || true
  LUMEN_FORCE_RECREATE=1
  start_database || true
  start_services || true
  printf '\n%sIf the new version already migrated the database, restore the pre-update backup:%s\n  sudo ./restore.sh %s\n' \
    "$C_YELLOW" "$C_RESET" "${pre_backup:-<the newest *-pre-update.tar.age>}" >&2
}

step "Database migrations"
start_database
if ! compose run --rm migrate >>"$_log_file" 2>&1; then
  rollback; fail_update "database migration failed"
fi
ok "migrations applied"

step "Restarting services"
if ! (start_services) ; then rollback; fail_update "services did not become healthy"; fi
refresh_internal_ca_bundle
bootstrap_synapse_admin
if truthy "$(conf_get WIREGUARD_ENABLED false)"; then wireguard_enable; fi
configure_firewall
install_systemd_units

step "Verifying"
LUMEN_VERIFY_MEDIA=1 verify_endpoints
if ((${#VERIFY_FAILURES[@]})); then
  rollback
  fail_update "${#VERIFY_FAILURES[@]} endpoint check(s) failed after the update"
fi
state_set version "$new_version"
state_set updated_at "$(date -u +%FT%TZ)"
images="$(grep -E '_IMAGE=' "$LUMEN_RENDERED_DIR/compose.env" | sed 's/_IMAGE=/=/' | tr '\n' ';')"
write_status_json update "running=" "last_update_at=$(date -u +%FT%TZ)" "last_result=ok" "version=$new_version" \
  "previous_version=${old_version:-}" "commit=$(git -C "$LUMEN_REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo n/a)"
python3 - "$(conf_get LUMEN_DATA_DIR /var/lib/lumen)/status/update.json" "$images" <<'PY'
import json, sys
p, images = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["images"] = dict(kv.split("=", 1) for kv in images.split(";") if "=" in kv)
json.dump(d, open(p, "w"), indent=2)
PY
docker image rm lumen/portal:rollback >/dev/null 2>&1 || true
printf '\n%sUpdate complete:%s Lumen %s is running and all endpoint checks passed.\n' "$C_GREEN" "$C_RESET" "$new_version"
