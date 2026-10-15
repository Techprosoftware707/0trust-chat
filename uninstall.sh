#!/usr/bin/env bash
# Remove Lumen from this server — explicitly, never silently.
#
#   sudo ./uninstall.sh                 # stop + remove containers/units, KEEP data, config and backups
#   sudo ./uninstall.sh --purge-data    # additionally delete databases, media, config and secrets
#   sudo ./uninstall.sh --remove-images # also remove Lumen's container images
#
# Backups in BACKUP_DIR are never deleted by this script. A final encrypted
# backup is offered (and taken by default) before anything is removed.

set -o errexit -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"

PURGE=0; RM_IMAGES=0; FINAL_BACKUP=1; ASSUME_YES=0; CONFIRM=""
while (($#)); do
  case "$1" in
    --purge-data) PURGE=1; shift ;;
    --remove-images) RM_IMAGES=1; shift ;;
    --no-final-backup) FINAL_BACKUP=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --confirm) CONFIRM="$2"; shift 2 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
require_root
[[ -f "$LUMEN_CONF" ]] || die "No Lumen installation found ($LUMEN_CONF missing)."
log_init uninstall
domain="$(conf_get LUMEN_PRIMARY_DOMAIN)"
data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
backups="$(conf_get BACKUP_DIR /var/backups/lumen)"

cat <<EOF
${C_BOLD}This will remove Lumen for $domain:${C_RESET}
  • stop and remove all Lumen containers and networks
  • remove systemd units (lumen-agent, backup and health timers) and the docker drop-in
  • remove Lumen's firewall rules (ufw) — SSH rules are kept
  • stop WireGuard wg0 if Lumen enabled it
EOF
if ((PURGE)); then
  cat <<EOF
  ${C_RED}• PERMANENTLY DELETE all data: $data (databases, media, homeserver signing key, TLS state)
  • PERMANENTLY DELETE configuration and secrets: $LUMEN_CONFIG_DIR${C_RESET}
EOF
else
  echo "  • KEEP data ($data), configuration and secrets ($LUMEN_CONFIG_DIR)"
fi
echo "  • KEEP all backups in $backups (delete them yourself if you really want to)"
((RM_IMAGES)) && echo "  • remove Lumen's container images"
echo

if ((ASSUME_YES)); then
  [[ "$CONFIRM" == "$domain" ]] || die "--yes requires --confirm $domain"
else
  read -r -p "Type the domain ($domain) to confirm: " ans </dev/tty
  [[ "$ans" == "$domain" ]] || die "confirmation did not match; nothing was removed"
  if ((PURGE)); then
    read -r -p "Type DELETE to confirm permanent deletion of all data: " ans2 </dev/tty
    [[ "$ans2" == DELETE ]] || die "not confirmed; nothing was removed"
  fi
fi

if ((FINAL_BACKUP)); then
  step "Final encrypted backup"
  if "$LUMEN_REPO_DIR/backup.sh" --quiet --tag final >>"$_log_file" 2>&1; then
    ok "final backup written to $backups (decrypt it with $LUMEN_CONFIG_DIR/backup/identity.txt — copy that key off the server now)"
    if ((PURGE)); then
      install -m 0600 "$LUMEN_CONFIG_DIR/backup/identity.txt" "$backups/backup-identity-KEEP-SAFE.txt"
      warn "the backup key was copied to $backups/backup-identity-KEEP-SAFE.txt because $LUMEN_CONFIG_DIR is being deleted; move it off this server"
    fi
  else
    ((PURGE)) && die "final backup failed; refusing to purge data (use --no-final-backup to override)"
    warn "final backup failed; continuing because data is kept"
  fi
fi

step "Stopping and removing containers"
if [[ -f "$LUMEN_RENDERED_DIR/compose.env" ]]; then
  run docker compose --project-directory "$LUMEN_REPO_DIR" --env-file "$LUMEN_RENDERED_DIR/compose.env" \
    -f "$LUMEN_REPO_DIR/docker-compose.yml" --profile voip --profile tools down --remove-orphans || warn "compose down reported errors"
fi
ok "containers and networks removed"

if has_systemd; then
  step "Removing systemd units"
  for u in lumen-agent.service lumen-backup.timer lumen-healthcheck.timer lumen-backup-verify.timer; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
  done
  rm -f /etc/systemd/system/lumen-*.service /etc/systemd/system/lumen-*.timer /etc/systemd/system/docker.service.d/lumen.conf
  rm -rf /etc/systemd/system/lumen-backup.timer.d
  systemctl daemon-reload
  ok "units removed"
fi
rm -rf /usr/local/lib/lumen /run/lumen-agent

if [[ "$(state_get wireguard)" == enabled ]]; then
  step "WireGuard"
  if has_systemd; then systemctl disable --now wg-quick@wg0 >/dev/null 2>&1 || true; else wg-quick down wg0 >/dev/null 2>&1 || true; fi
  ((PURGE)) && rm -f /etc/wireguard/wg0.conf
  ok "wg0 stopped$( ((PURGE)) && echo " and its configuration removed")"
fi

if command -v ufw >/dev/null 2>&1; then
  step "Firewall rules"
  # Delete only rules Lumen added (identified by their 'lumen:' comment), never SSH.
  while read -r num; do
    [[ -n "$num" ]] && yes | ufw delete "$num" >/dev/null 2>&1 || true
  done < <(ufw status numbered 2>/dev/null | grep "# lumen:" | grep -v "lumen: ssh" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn)
  ok "Lumen firewall rules removed (SSH rules and the UFW policy kept)"
fi

if ((RM_IMAGES)); then
  step "Removing images"
  set -a; source "$LUMEN_RENDERED_DIR/compose.env" 2>/dev/null || true; set +a
  for img in "${PORTAL_IMAGE:-}" "${SYNAPSE_IMAGE:-}" "${CADDY_IMAGE:-}" "${POSTGRES_IMAGE:-}" "${COTURN_IMAGE:-}"; do
    [[ -n "$img" ]] && docker image rm "$img" >/dev/null 2>&1 || true
  done
  ok "images removed"
fi

if ((PURGE)); then
  step "Deleting data and configuration"
  rm -rf "$data" "$LUMEN_CONFIG_DIR"
  ok "deleted $data and $LUMEN_CONFIG_DIR"
else
  state_set install_status uninstalled
fi
printf '\nLumen has been removed.%s Backups remain in %s.\n' "$( ((PURGE)) || echo " Data and configuration were kept; re-run install.sh to bring it back.")" "$backups"
