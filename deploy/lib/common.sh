#!/usr/bin/env bash
# Shared helpers for install.sh, update.sh, backup.sh, restore.sh, ...
# Sourced, never executed directly.
# shellcheck disable=SC2034

set -o errexit -o nounset -o pipefail

LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LUMEN_CONFIG_DIR="${LUMEN_CONFIG_DIR:-/etc/lumen}"
LUMEN_CONF="${LUMEN_CONF:-$LUMEN_CONFIG_DIR/lumen.conf}"
LUMEN_SECRETS_DIR="$LUMEN_CONFIG_DIR/secrets"
LUMEN_RENDERED_DIR="$LUMEN_CONFIG_DIR/rendered"
LUMEN_BRANDING_DIR="$LUMEN_CONFIG_DIR/branding"
LUMEN_STATE_FILE="$LUMEN_CONFIG_DIR/state.json"
LUMEN_LOG_DIR="${LUMEN_LOG_DIR:-/var/log/lumen}"
LUMEN_LOCK_FILE="${LUMEN_LOCK_FILE:-/run/lumen-deploy.lock}"

# Container identities (must match deploy/lib/render.py)
UID_APP=10001
UID_CADDY=10200
GID_SECRETS=10100
GID_SOCKETS=10300
UID_SYNAPSE=991
UID_LIVEKIT=10400
UID_LKJWT=10401
UID_SYGNAL=10500
UID_POSTGRES=70

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'; C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

_log_file=""
log_init() {
  local name="$1"
  mkdir -p "$LUMEN_LOG_DIR"
  chmod 750 "$LUMEN_LOG_DIR"
  _log_file="$LUMEN_LOG_DIR/${name}-$(date -u +%Y%m%dT%H%M%SZ).log"
  : >"$_log_file"
  chmod 640 "$_log_file"
  ln -sfn "$_log_file" "$LUMEN_LOG_DIR/${name}-latest.log"
}
_log() { [[ -n "$_log_file" ]] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$_log_file" || true; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; _log "STEP $*"; }
info() { printf '    %s\n' "$*"; _log "INFO $*"; }
ok() { printf '    %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; _log "OK   $*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; _log "WARN $*"; }
fail() { printf '    %s✘%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; _log "FAIL $*"; }
die() {
  printf '\n%sERROR:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2
  _log "DIE  $*"
  [[ -n "$_log_file" ]] && printf '%sDetails: %s%s\n' "$C_DIM" "$_log_file" "$C_RESET" >&2
  exit 1
}

# Run a command, logging its output to the log file only (never secrets: callers
# must not pass secrets on the command line).
run() {
  _log "RUN  $*"
  if [[ -n "$_log_file" ]]; then
    "$@" >>"$_log_file" 2>&1
  else
    "$@"
  fi
}

require_root() {
  [[ $EUID -eq 0 ]] || die "This command must run as root. Re-run with: sudo bash $0 $*"
}

with_lock() {
  exec 9>"$LUMEN_LOCK_FILE"
  if ! flock -n 9; then
    die "Another Lumen operation is already running (lock $LUMEN_LOCK_FILE). Wait for it to finish."
  fi
}

has_systemd() { [[ -d /run/systemd/system ]]; }

conf_get() {
  # conf_get KEY [default] — read a value from lumen.conf without sourcing it.
  local key="$1" default="${2:-}" line value
  if [[ -f "$LUMEN_CONF" ]]; then
    line="$(grep -E "^[[:space:]]*${key}=" "$LUMEN_CONF" | tail -n1 || true)"
    if [[ -n "$line" ]]; then
      value="${line#*=}"
      value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
      printf '%s' "$value"
      return 0
    fi
  fi
  printf '%s' "$default"
}

conf_set() {
  # conf_set KEY VALUE — replace or append KEY=VALUE in lumen.conf.
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$LUMEN_CONFIG_DIR/.lumen.conf.XXXXXX")"
  if [[ -f "$LUMEN_CONF" ]] && grep -qE "^[[:space:]]*${key}=" "$LUMEN_CONF"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $0 ~ "^[[:space:]]*"k"=" {print k"="v; next} {print}' "$LUMEN_CONF" >"$tmp"
  else
    [[ -f "$LUMEN_CONF" ]] && cat "$LUMEN_CONF" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 640 "$tmp"
  mv -f "$tmp" "$LUMEN_CONF"
}

truthy() { case "${1,,}" in 1 | true | yes | on) return 0 ;; *) return 1 ;; esac }

# Voice/video calling (LiveKit SFU + authorization service) is on unless disabled.
calls_enabled() { truthy "$(conf_get CALLS_ENABLED true)"; }
# WireGuard (private operator access) is on unless lumen.conf turns it off. wireguard_active:
# wanted AND brought up by Lumen (state "enabled"); "unavailable" when this host can't run it.
wireguard_wanted() { local v; v="$(conf_get WIREGUARD_ENABLED)"; [[ -z "$v" ]] || truthy "$v"; }
wireguard_active() { wireguard_wanted && [[ "$(state_get wireguard)" == enabled ]]; }
rtc_domain() { conf_get LUMEN_RTC_DOMAIN "rtc.$(conf_get LUMEN_PRIMARY_DOMAIN)"; }
push_enabled() { truthy "$(conf_get PUSH_ENABLED false)"; }
# push_active — push is enabled AND at least one platform has its credential. render.py writes
# sygnal.yaml only then: Sygnal refuses to start with no app or with an empty key file.
push_active() { push_enabled && [[ -s "$LUMEN_RENDERED_DIR/sygnal/sygnal.yaml" ]]; }

calls_ports_human() {
  printf '%s/udp (media), %s/tcp (ICE/TCP), %s/udp (TURN)' \
    "$(conf_get CALLS_UDP_PORTS 7882-7889)" "$(conf_get CALLS_TCP_PORT 7881)" \
    "$(conf_get CALLS_TURN_UDP_PORT 3478)"
}

compose_env_file() { printf '%s' "$LUMEN_RENDERED_DIR/compose.env"; }

compose() {
  local profiles=()
  if calls_enabled; then profiles+=(--profile calls); fi
  if push_enabled; then profiles+=(--profile push); fi
  docker compose --project-directory "$LUMEN_REPO_DIR" \
    --env-file "$(compose_env_file)" \
    -f "$LUMEN_REPO_DIR/docker-compose.yml" "${profiles[@]}" "$@"
}

state_set() {
  # state_set key value — record installer state (JSON) for partial-install detection.
  local key="$1" value="$2"
  python3 - "$LUMEN_STATE_FILE" "$key" "$value" <<'PY'
import json, sys, os, datetime
path, key, value = sys.argv[1:4]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data[key] = value
data["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2)
os.chmod(tmp, 0o640)
os.replace(tmp, path)
PY
}

state_get() {
  python3 - "$LUMEN_STATE_FILE" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
except Exception:
    print("")
PY
}

write_status_json() {
  # write_status_json name key=value... — status files read by the console/probes.
  local name="$1"; shift
  local dir; dir="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)/status"
  mkdir -p "$dir"
  python3 - "$dir/$name.json" "$@" <<'PY'
import json, sys, os
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    data = {}
for kv in sys.argv[2:]:
    k, _, v = kv.partition("=")
    if v == "__null__":
        data.pop(k, None)
    else:
        data[k] = v
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

wait_for() {
  # wait_for <seconds> <description> <command...>
  local timeout="$1" desc="$2"; shift 2
  local start; start=$(date +%s)
  until "$@" >/dev/null 2>&1; do
    if (($(date +%s) - start > timeout)); then
      return 1
    fi
    sleep 3
  done
  _log "READY $desc after $(($(date +%s) - start))s"
  return 0
}

container_health() {
  # container_health <service> -> healthy|unhealthy|starting|running|exited|missing
  local id
  id="$(compose ps -q "$1" 2>/dev/null | head -n1)"
  [[ -z "$id" ]] && { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

# lan_ipv4 — this host's source address on the default route (what other LAN devices reach).
lan_ipv4() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}'; }

# is_private_ipv4 ADDR — RFC 1918, carrier-grade NAT (100.64.0.0/10), loopback or link-local.
is_private_ipv4() {
  python3 -c 'import ipaddress, sys; a = ipaddress.ip_address(sys.argv[1]); sys.exit(0 if a.is_private or a in ipaddress.ip_network("100.64.0.0/10") else 1)' "$1" 2>/dev/null
}

# sslip_name ADDR — 203.0.113.5 → 203-0-113-5.sslip.io (public DNS answering with that address).
sslip_name() { printf '%s.sslip.io' "${1//./-}"; }

# test_setup — installed with install.sh --test (no domain; see test_configure).
test_setup() { truthy "$(conf_get LUMEN_TEST_SETUP false)"; }

public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')" && [[ "$ip" =~ ^[0-9.]+$ ]] && break
    ip=""
  done
  printf '%s' "$ip"
}
