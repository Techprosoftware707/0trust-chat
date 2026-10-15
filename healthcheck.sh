#!/usr/bin/env bash
# Quick pass/fail health check of every Lumen component.
#
#   sudo ./healthcheck.sh            # human-readable
#   sudo ./healthcheck.sh --json     # machine-readable
#   sudo ./healthcheck.sh --quiet --record   # used by lumen-healthcheck.timer
#
# Exit code: 0 all healthy, 1 degraded (warnings), 2 failures.

set -o errexit -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"
source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"
source "$LUMEN_REPO_DIR/deploy/lib/verify.sh"

JSON=0; QUIET=0; RECORD=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    --record) RECORD=1 ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
  esac
done
require_root
((JSON || QUIET)) && exec 3>&1 1>/dev/null || exec 3>&1
[[ -f "$LUMEN_RENDERED_DIR/compose.env" ]] || { echo "Lumen is not installed (no $LUMEN_RENDERED_DIR)" >&3; exit 2; }

declare -a RESULTS=()
worst=0
add() { # status component message
  RESULTS+=("$1|$2|$3")
  case "$1" in warn) ((worst < 1)) && worst=1 ;; fail) worst=2 ;; esac
  case "$1" in ok) ok "$2: $3" ;; warn) warn "$2: $3" ;; fail) fail "$2: $3" ;; esac
}

step "Containers"
services=(postgres synapse portal ops worker caddy)
calls_enabled && services+=(lkjwt livekit)
push_enabled && services+=(sygnal)
for s in "${services[@]}"; do
  st="$(container_health "$s")"
  case "$st" in
    healthy) add ok "$s" "healthy" ;;
    running) [[ "$s" == caddy || "$s" == livekit ]] && add ok "$s" "running" || add warn "$s" "running (health check pending)" ;;
    starting) add warn "$s" "starting" ;;
    *) add fail "$s" "$st" ;;
  esac
done

step "Database"
if compose exec -T postgres pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
  size="$(compose exec -T postgres psql -U postgres -tAc "SELECT pg_size_pretty(sum(pg_database_size(datname))) FROM pg_database WHERE datname IN ('lumen','synapse')" 2>/dev/null | tr -d '[:space:]')"
  add ok database "accepting connections ($size)"
else
  add fail database "not accepting connections"
fi

step "Public endpoints"
verify_endpoints || true
for r in "${VERIFY_RESULTS[@]}"; do
  st="${r%%|*}"; msg="${r#*|}"
  [[ "$st" == ok ]] && RESULTS+=("ok|endpoint|$msg") || { RESULTS+=("fail|endpoint|$msg"); worst=2; }
done

step "Resources"
data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
pct="$(df -P "$data" | awk 'NR==2 {gsub("%","",$5); print $5}')"
if ((pct >= 90)); then add fail disk "${pct}% used on $data"; elif ((pct >= 80)); then add warn disk "${pct}% used on $data"; else add ok disk "${pct}% used"; fi
mem_avail=$(($(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024))
((mem_avail < 200)) && add warn memory "only ${mem_avail} MB available" || add ok memory "${mem_avail} MB available"

step "Backups"
bfile="$data/status/backup.json"
if [[ -f "$bfile" ]]; then
  last="$(python3 -c "import json; print(json.load(open('$bfile')).get('last_success_at',''))")"
  result="$(python3 -c "import json; print(json.load(open('$bfile')).get('last_result',''))")"
  verified="$(python3 -c "import json; print(json.load(open('$bfile')).get('last_verified_at',''))")"
  if [[ -z "$last" ]]; then add fail backups "no successful backup yet"
  else
    age_h=$((($(date +%s) - $(date -d "$last" +%s)) / 3600))
    if [[ "$result" == failed ]]; then add fail backups "last backup failed"
    elif ((age_h > 72)); then add fail backups "last successful backup ${age_h}h ago"
    elif ((age_h > 26)); then add warn backups "last successful backup ${age_h}h ago"
    else add ok backups "last backup ${age_h}h ago${verified:+, restore verified $verified}"; fi
  fi
else
  add fail backups "no backup has run"
fi

if has_systemd; then
  step "Host services"
  for unit in lumen-agent.service lumen-backup.timer; do
    systemctl is-active --quiet "$unit" && add ok "$unit" active || add warn "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
  done
  if truthy "$(conf_get WIREGUARD_ENABLED false)"; then
    ip link show wg0 >/dev/null 2>&1 && add ok wireguard "wg0 up" || add fail wireguard "wg0 down"
  fi
fi

summary="healthy"; ((worst == 1)) && summary="degraded"; ((worst == 2)) && summary="failed"
if ((RECORD)); then
  failed_list="$(printf '%s\n' "${RESULTS[@]}" | awk -F'|' '$1!="ok" {print $2": "$3}' | head -n 10 | paste -sd ';' -)"
  write_status_json health "checked_at=$(date -u +%FT%TZ)" "status=$summary" "problems=$failed_list"
fi
if ((JSON)); then
  printf '%s\n' "${RESULTS[@]}" | python3 -c '
import json, sys
rows = [l.rstrip("\n").split("|", 2) for l in sys.stdin if l.strip()]
print(json.dumps({"status": sys.argv[1], "checks": [{"status": s, "component": c, "message": m} for s, c, m in rows]}, indent=2))' "$summary" >&3
elif ((!QUIET)); then
  printf '\nOverall: %s\n' "$summary" >&3
fi
exit "$worst"
