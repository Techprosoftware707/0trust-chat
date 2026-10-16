#!/usr/bin/env bash
# Lumen Secure — single-command installer for Ubuntu Server 24.04 LTS.
#
#   sudo bash install.sh                      # interactive
#   sudo bash install.sh --config lumen.conf  # unattended (see lumen.conf.example)
#   sudo bash install.sh --test               # test setup, no domain needed (see --help)
#
# Safe to re-run: every step is idempotent, existing data and secrets are kept,
# configuration is rendered to a staging directory and validated before use,
# and success is only reported after the public endpoints actually respond.

set -o errexit -o nounset -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${LUMEN_INSTALL_DIR:-/opt/lumen}"

usage() {
  cat <<EOF
Usage: sudo bash install.sh [options]

Options:
  --config FILE        Use FILE as /etc/lumen/lumen.conf (non-interactive install)
  --yes                Don't ask for confirmation before changing the system
  --skip-dns-check     Skip DNS verification (certificates will fail if DNS is wrong)
  --no-verify          Don't run the final public endpoint verification (not recommended)
  --install-dir DIR    Where the Lumen code lives (default /opt/lumen)
  --test               Test setup without a domain: host names under <server-ip>.sslip.io and a
                       private test CA that each test device must trust (the summary shows how),
                       or, with --test-host, a free DNS name (e.g. DuckDNS) with Let's Encrypt.
                       For testing only: a real domain later means a new installation.
  --test-ip ADDR       With --test: the address devices use (default: detected)
  --test-host NAME     With --test: your free DNS name for that address (e.g. mylumen.duckdns.org)
  --test-email ADDR    With --test-host: email for Let's Encrypt
  -h, --help           Show this help

Environment overrides for testing only: LUMEN_NO_SYSTEMD=1, LUMEN_ALLOW_UNSUPPORTED_OS=1
EOF
}

CONFIG_SRC=""
TEST_MODE=0
ASSUME_YES=0
DO_VERIFY=1
while (($#)); do
  case "$1" in
    --config) CONFIG_SRC="$2"; shift 2 ;;
    --config=*) CONFIG_SRC="${1#*=}"; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --skip-dns-check) export LUMEN_SKIP_DNS_CHECK=1; shift ;;
    --no-verify) DO_VERIFY=0; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --test) TEST_MODE=1; shift ;;
    --test-ip) TEST_MODE=1; export LUMEN_TEST_IP="$2"; shift 2 ;;
    --test-host) TEST_MODE=1; export LUMEN_TEST_HOST="$2"; shift 2 ;;
    --test-email) TEST_MODE=1; export LUMEN_TEST_EMAIL="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "install.sh must run as root: sudo bash install.sh $*" >&2
  exit 1
fi

# 1. Put the code in its permanent location (keeps .git for update.sh).
if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude node_modules --exclude 'services/chat/dist' --exclude '__pycache__' "$SCRIPT_DIR/" "$INSTALL_DIR/"
  else
    cp -a "$SCRIPT_DIR/." "$INSTALL_DIR/"
  fi
  args=(--install-dir "$INSTALL_DIR")
  [[ -n "$CONFIG_SRC" ]] && args+=(--config "$(realpath "$CONFIG_SRC")")
  ((ASSUME_YES)) && args+=(--yes)
  ((TEST_MODE)) && args+=(--test)
  ((DO_VERIFY)) || args+=(--no-verify)
  exec bash "$INSTALL_DIR/install.sh" "${args[@]}"
fi

export LUMEN_REPO_DIR="$INSTALL_DIR"
# shellcheck source=deploy/lib/common.sh
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"
# shellcheck source=deploy/lib/preflight.sh
source "$LUMEN_REPO_DIR/deploy/lib/preflight.sh"
# shellcheck source=deploy/lib/configure.sh
source "$LUMEN_REPO_DIR/deploy/lib/configure.sh"
# shellcheck source=deploy/lib/host.sh
source "$LUMEN_REPO_DIR/deploy/lib/host.sh"
# shellcheck source=deploy/lib/stack.sh
source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"
# shellcheck source=deploy/lib/wireguard.sh
source "$LUMEN_REPO_DIR/deploy/lib/wireguard.sh"
# shellcheck source=deploy/lib/verify.sh
source "$LUMEN_REPO_DIR/deploy/lib/verify.sh"

with_lock
log_init install
VERSION="$(grep -E '^LUMEN_VERSION=' "$LUMEN_REPO_DIR/deploy/versions.env" | cut -d= -f2)"
printf '%sLumen Secure installer%s %s — log: %s\n' "$C_BOLD" "$C_RESET" "$VERSION" "$_log_file"

phase() { step "$1"; [[ -d "$LUMEN_CONFIG_DIR" ]] && state_set phase "$1" 2>/dev/null || true; }

# 2. Configuration (nothing is changed on the system until preflight passes).
phase "Configuration"
TMP_CONF=""
if [[ -n "$CONFIG_SRC" ]]; then
  [[ -f "$CONFIG_SRC" ]] || die "Config file $CONFIG_SRC not found"
  TMP_CONF="$CONFIG_SRC"
  info "using configuration from $CONFIG_SRC"
elif [[ -f "$LUMEN_CONF" ]]; then
  TMP_CONF="$LUMEN_CONF"
  info "using existing configuration $LUMEN_CONF"
  ((TEST_MODE)) && info "--test ignored: this server already has a configuration"
elif ((TEST_MODE)); then
  TMP_CONF="$(mktemp /tmp/lumen.conf.XXXXXX)"
  test_configure "$TMP_CONF"
else
  TMP_CONF="$(mktemp /tmp/lumen.conf.XXXXXX)"
  # Secrets entered interactively are written under the real secrets dir.
  interactive_configure "$TMP_CONF"
fi
validate_conf_file "$TMP_CONF"
ok "configuration valid"
export LUMEN_CONF="$TMP_CONF"

# 3. Preflight (read-only).
phase "Preflight checks"
run_preflight
preflight_report

if ((ASSUME_YES == 0)) && [[ -t 0 ]]; then
  printf '\nThe installer will now install packages (Docker, UFW, age...), configure the firewall\n'
  printf 'additively, and start Lumen for %s%s%s. Existing data is preserved.\n' "$C_BOLD" "$(conf_get LUMEN_PRIMARY_DOMAIN)" "$C_RESET"
  read -r -p "Continue? [y/N] " answer </dev/tty
  [[ "${answer,,}" == y* ]] || die "Aborted by user; nothing was changed."
fi

# 4. Persist configuration.
install -d -m 0750 "$LUMEN_CONFIG_DIR"
if [[ "$(realpath "$TMP_CONF")" != "$(realpath -m "$LUMEN_CONFIG_DIR/lumen.conf")" ]]; then
  [[ -f "$LUMEN_CONFIG_DIR/lumen.conf" ]] && cp -p "$LUMEN_CONFIG_DIR/lumen.conf" "$LUMEN_CONFIG_DIR/lumen.conf.bak.$(date +%s)"
  install -m 0640 "$TMP_CONF" "$LUMEN_CONFIG_DIR/lumen.conf"
  [[ "$TMP_CONF" == /tmp/lumen.conf.* ]] && rm -f "$TMP_CONF"
fi
export LUMEN_CONF="$LUMEN_CONFIG_DIR/lumen.conf"
state_set repo_dir "$LUMEN_REPO_DIR"
state_set version "$VERSION"
[[ "$(state_get install_status)" == complete ]] || state_set install_status in_progress

phase "Host packages and Docker"
install_packages
install_docker
ensure_groups

phase "Secrets and directories"
ensure_dirs
ensure_secrets
ensure_backup_keys
ensure_ca_bundle_file
chgrp "$GID_SECRETS" "$LUMEN_CONFIG_DIR" && chmod 0750 "$LUMEN_CONFIG_DIR"
chgrp "$GID_SECRETS" "$LUMEN_CONF" && chmod 0640 "$LUMEN_CONF"
ok "secrets present in $LUMEN_SECRETS_DIR (generated once, never printed)"

phase "Rendering and validating configuration"
render_staging
validate_staging
promote_staging

phase "Firewall and automatic updates"
configure_firewall
configure_unattended_upgrades

phase "WireGuard"
if truthy "$(conf_get WIREGUARD_ENABLED false)"; then wireguard_enable; else info "disabled (WIREGUARD_ENABLED=false)"; fi

phase "Container images"
pull_images
build_portal
build_chat

phase "Database"
start_database
run_migrations

phase "Services"
start_services
refresh_internal_ca_bundle
bootstrap_synapse_admin

phase "Host agent and timers"
install_systemd_units

phase "Operator account"
OPERATOR="$(conf_get OPERATOR_USERNAME "")"
LINK_FILE="$LUMEN_CONFIG_DIR/operator-setup-link.txt"
if [[ -n "$OPERATOR" ]]; then
  if compose run --rm -T -e LUMEN_SURFACE=public migrate manage shell -c \
    "from apps.accounts.models import User; import sys; sys.exit(0 if User.objects.filter(username='$OPERATOR', staff_role__gt='').exists() else 1)" >/dev/null 2>&1; then
    ok "operator '$OPERATOR' already exists (new link: sudo ./lumenctl operator-link $OPERATOR)"
  else
    ops_url="https://$(conf_get LUMEN_OPS_DOMAIN "ops.$(conf_get LUMEN_PRIMARY_DOMAIN)"):$(conf_get LUMEN_OPS_PORT 8443)"
    compose run --rm -T migrate manage lumen_create_operator --username "$OPERATOR" --email "$(conf_get ADMIN_EMAIL)" \
      --role owner --hours 24 --base-url "$ops_url" >"$LINK_FILE.tmp" 2>>"$_log_file" \
      || die "Could not create the operator account. See $_log_file"
    install -m 0600 "$LINK_FILE.tmp" "$LINK_FILE"; rm -f "$LINK_FILE.tmp"
    ok "operator '$OPERATOR' created; one-time setup link stored in $LINK_FILE (root only, valid 24 h)"
  fi
else
  warn "no OPERATOR_USERNAME configured; create one with: sudo ./lumenctl create-operator <username> <email>"
fi

phase "Initial encrypted backup"
if "$LUMEN_REPO_DIR/backup.sh" --quiet >>"$_log_file" 2>&1; then
  ok "first backup created"
  if "$LUMEN_REPO_DIR/restore.sh" --verify-only latest --quiet >>"$_log_file" 2>&1; then
    ok "backup restore verified in an isolated database"
  else
    warn "backup restore verification failed; see $_log_file and run sudo ./restore.sh --verify-only latest"
  fi
else
  warn "initial backup failed; see $_log_file (installation continues)"
fi

VERIFY_OK=1
if ((DO_VERIFY)); then
  phase "Verifying public endpoints"
  LUMEN_VERIFY_MEDIA=1 verify_endpoints
  ((${#VERIFY_FAILURES[@]} == 0)) || VERIFY_OK=0
fi

state_set server_name "$(conf_get MATRIX_SERVER_NAME "$(conf_get LUMEN_PRIMARY_DOMAIN)")"
if ((VERIFY_OK)); then
  state_set install_status complete
  state_set installed_at "$(date -u +%FT%TZ)"
  state_set phase "done"
fi
write_status_json update "last_update_at=$(date -u +%FT%TZ)" "last_result=$( ((VERIFY_OK)) && echo installed || echo installed-with-failures)" "version=$VERSION"

# 5. Summary (no secrets).
p="$(conf_get LUMEN_PRIMARY_DOMAIN)"
printf '\n%s──────────────── Lumen deployment summary ────────────────%s\n' "$C_BOLD" "$C_RESET"
if ((VERIFY_OK)); then
  printf '%sResult:%s %sSUCCESS%s — all endpoint checks passed\n' "$C_BOLD" "$C_RESET" "$C_GREEN" "$C_RESET"
else
  printf '%sResult:%s %sINCOMPLETE%s — %d check(s) failed (see above). Run: sudo ./diagnose.sh\n' "$C_BOLD" "$C_RESET" "$C_RED" "$C_RESET" "${#VERIFY_FAILURES[@]}"
fi
cat <<EOF
Website & portal:   https://$p
Chat app:           https://$(conf_get LUMEN_APP_DOMAIN "app.$p")
Homeserver:         https://$(conf_get LUMEN_MATRIX_DOMAIN "matrix.$p")  (server name: $(conf_get MATRIX_SERVER_NAME "$p"))
Operator console:   https://$(conf_get LUMEN_OPS_DOMAIN "ops.$p"):$(conf_get LUMEN_OPS_PORT 8443)  (private: SSH tunnel or WireGuard)
TLS:                $( [[ "$(conf_get TLS_MODE acme)" == acme ]] && echo "Let's Encrypt certificates (automatic renewal)" || echo "INTERNAL TEST CA — not trusted by browsers or other servers")
Federation:         $(conf_get FEDERATION_MODE open)$( [[ "$(conf_get FEDERATION_MODE open)" == open ]] && echo " (external reachability is reported in the console after the first probe)")
Database:           $(container_health postgres)
Encryption:         end-to-end encryption on by default for all new rooms (Olm/Megolm, client-side)
Backups:            $(conf_get BACKUP_DIR /var/backups/lumen), daily at $(conf_get BACKUP_SCHEDULE 03:17), age-encrypted
                    Copy the backup key OFF this server: $LUMEN_CONFIG_DIR/backup/identity.txt
WireGuard:          $(truthy "$(conf_get WIREGUARD_ENABLED false)" && echo "enabled on wg0 (add devices in the console)" || echo disabled)
Voice/video:        $(calls_enabled && echo "enabled — SFU wss://$(rtc_domain), ports $(calls_ports_human)" || echo disabled)
Email:              $( [[ -n "$(conf_get SMTP_HOST)" ]] && echo "SMTP $(conf_get SMTP_HOST)" || echo "not configured — email verification and reset-by-email are off")
Payments:           $(conf_get BILLING_PROVIDER none)
EOF
if test_setup; then test_setup_summary; fi
cat <<EOF

Operator setup:
  1. On your computer:  ssh -L $(conf_get LUMEN_OPS_PORT 8443):127.0.0.1:$(conf_get LUMEN_OPS_PORT 8443) <you>@<this server>
     and add to your hosts file:  127.0.0.1 $(conf_get LUMEN_OPS_DOMAIN "ops.$p")
  2. On the server:  sudo cat $LINK_FILE   (one-time link, 24 h)
  3. Open the link, choose a password, then enrol two-factor authentication.

Remaining manual items:
EOF
remaining=0
if test_setup; then
  echo "  • this is a TEST setup: for production, install fresh on your real domain (accounts and rooms don't move over)"; remaining=1
elif [[ "$(conf_get TLS_MODE acme)" == internal ]]; then
  echo "  • switch TLS_MODE to acme with real DNS before production use"; remaining=1
fi
if [[ -z "$(conf_get SMTP_HOST)" ]]; then echo "  • optional: configure SMTP_* to enable email verification and password reset"; remaining=1; fi
if [[ "$(conf_get BILLING_PROVIDER none)" == stripe ]]; then echo "  • in Stripe, add webhook https://$p/billing/webhooks/stripe/ and set stripe price IDs in the console (Plans)"; remaining=1; fi
echo "  • store $LUMEN_CONFIG_DIR/backup/identity.txt offline; without it backups cannot be decrypted"
((remaining)) || true
printf '\nLog: %s\n' "$_log_file"
((VERIFY_OK)) || exit 3
