#!/usr/bin/env bash
# Installer lifecycle test. Run as root inside a disposable test server (see vm.sh)
# AFTER a successful `install.sh --config CONF --yes`:
#
#   bash /opt/lumen/tests/installer/lifecycle.sh /root/lumen-it.conf
#
# Exercises: idempotent re-install (secrets, signing key and data preserved),
# healthcheck, diagnose (no secrets in output), encrypted backup, full restore
# (data rolled back to the backup), update.sh, uninstall (data kept) and
# re-install on the kept data, and a secret-leak scan of all Lumen logs. With
# CALLS_ENABLED=true it also restarts the SFU and runs the real media self-test
# after every lifecycle step.
# Prints PASS/FAIL lines; exit status = number of failures.
set -uo pipefail
CONF="${1:?usage: lifecycle.sh /path/to/lumen.conf}"
cd /opt/lumen || exit 99
LOG=/root/lifecycle-detail.log
: >"$LOG"
pass=0 fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail + 1)); }
check() { local name="$1"; shift; if "$@" >>"$LOG" 2>&1; then ok "$name"; else bad "$name" "see $LOG"; fi; }

domain="$(grep -E '^LUMEN_PRIMARY_DOMAIN=' "$CONF" | cut -d= -f2)"
secrets_hash() { find /etc/lumen/secrets -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16; }
signing_hash() { sha256sum /var/lib/lumen/synapse/signing.key | cut -c1-16; }
shell() { ./lumenctl manage shell -c "$1" 2>>"$LOG" | tail -n1; }
user_exists() { [[ "$(shell "from apps.accounts.models import User; print(User.objects.filter(username='$1').exists())")" == True ]]; }
make_user() { shell "from apps.accounts.models import User; u=User(username='$1', email='$1@example.org'); u.set_unusable_password(); u.save(); print('ok')" >/dev/null; }
healthy() { ./healthcheck.sh >>"$LOG" 2>&1; local rc=$?; ((rc <= 1)); }   # 1 = warnings only
calls_on() { grep -qE '^CALLS_ENABLED=(true|yes|1)$' "$CONF"; }
media_ok() { ./lumenctl calls-selftest 15; }   # real WebRTC audio+video through the SFU

s0="$(secrets_hash)"; k0="$(signing_hash)"
make_user lcmarker-a
check "marker account A created" user_exists lcmarker-a

echo "--- idempotent re-install"
check "install.sh re-run succeeds" bash install.sh --config "$CONF" --yes
[[ "$(secrets_hash)" == "$s0" ]] && ok "secrets unchanged by re-install" || bad "secrets unchanged by re-install"
[[ "$(signing_hash)" == "$k0" ]] && ok "homeserver signing key unchanged by re-install" || bad "homeserver signing key unchanged by re-install"
check "data kept across re-install (marker A)" user_exists lcmarker-a
if calls_on; then
  check "calls: media flows through the SFU after re-install" media_ok
  echo "--- calls: media-service restart"
  lk0="$(sha256sum /etc/lumen/rendered/livekit/livekit.yaml | cut -c1-16)"
  check "lumenctl restart livekit lkjwt" ./lumenctl restart livekit lkjwt
  check "calls: media flows after the SFU restart" media_ok
  [[ "$(sha256sum /etc/lumen/rendered/livekit/livekit.yaml | cut -c1-16)" == "$lk0" ]] && ok "SFU configuration unchanged by restart" || bad "SFU configuration unchanged by restart"
  check "data untouched by the SFU restart (marker A)" user_exists lcmarker-a
  check "healthy after the SFU restart" healthy
fi

echo "--- crash recovery (no operator action)"
# A crash, OOM kill or hard reboot: the processes die without cleaning up. Docker's restart policy
# must bring every service back healthy by itself (a stale unix-socket lock once kept the
# homeserver down forever).
crash_recovers() { # service
  local pid; pid="$(docker inspect -f '{{.State.Pid}}' "lumen-$1-1")" || return 1
  kill -9 "$pid" || return 1
  for _ in $(seq 1 90); do
    sleep 2
    [[ "$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "lumen-$1-1" 2>/dev/null)" == "true healthy" ]] && return 0
  done
  return 1
}
for svc in synapse portal ops postgres; do
  check "$svc killed with SIGKILL comes back healthy on its own" crash_recovers "$svc"
done
# Right after PostgreSQL comes back, each of the homeserver's pooled database connections fails
# one transaction (HTTP 500) and is then replaced (Synapse's cp_reconnect); measured: about 15 s
# with light traffic. Required: healthy again on its own, with no operator action, within 2 min.
settles() { local t0=$SECONDS; until healthy; do ((SECONDS - t0 < 120)) || return 1; sleep 10; done; echo "healthy $((SECONDS - t0)) s after the last crash"; }
check "healthy again on its own within 2 min of the crashes" settles
check "data intact after the crashes (marker A)" user_exists lcmarker-a

echo "--- health and diagnostics"
check "healthcheck.sh reports healthy (warnings allowed)" healthy
./diagnose.sh --no-color >/root/diagnose.out 2>&1; rc=$?
# 0 = no problems, 1 = problems explained (e.g. an unsynchronised clock in a container).
if ((rc <= 1)) && grep -q "problem(s) found\|No problems found" /root/diagnose.out; then
  ok "diagnose.sh completes ($(grep -c '✘' /root/diagnose.out) problem(s) explained)"
else
  bad "diagnose.sh completes" "exit $rc"
fi

echo "--- backup and full restore"
check "backup.sh creates an encrypted archive" ./backup.sh --tag lifecycle --no-remote
archive="$(ls -1t /var/backups/lumen/*-lifecycle.tar.age 2>/dev/null | head -n1)"
[[ -n "$archive" && "$(head -c 21 "$archive")" == "age-encryption.org/v1" ]] && ok "archive is age-encrypted" || bad "archive is age-encrypted" "$archive"
if [[ -n "$archive" ]] && ! tar -tf "$archive" >/dev/null 2>&1 && ! grep -aq "BEGIN PRIVATE KEY\|CREATE TABLE" "$archive"; then
  ok "archive contents are not readable without the key"
else
  bad "archive contents are not readable without the key"
fi
check "restore.sh --verify-only on the archive" ./restore.sh --verify-only "$archive"
make_user lcmarker-b
check "marker account B created after the backup" user_exists lcmarker-b
check "full restore of the archive" ./restore.sh "$archive" --yes --confirm "$domain"
check "restored data contains marker A" user_exists lcmarker-a
if user_exists lcmarker-b; then bad "restore rolled back to the backup (marker B gone)"; else ok "restore rolled back to the backup (marker B gone)"; fi
[[ "$(signing_hash)" == "$k0" ]] && ok "signing key intact after restore" || bad "signing key intact after restore"
check "healthy after restore" healthy
calls_on && check "calls: media flows after restore" media_ok

echo "--- update"
check "update.sh --no-pull succeeds" ./update.sh --no-pull --yes
check "healthy after update" healthy
check "data kept across update (marker A)" user_exists lcmarker-a
calls_on && check "calls: media flows after update" media_ok

if calls_on; then
  echo "--- calls: turn off, then on again"
  sed -i 's/^CALLS_ENABLED=.*/CALLS_ENABLED=false/' "$CONF"
  check "install.sh with CALLS_ENABLED=false" bash install.sh --config "$CONF" --yes
  [[ -z "$(docker ps -aq --filter label=com.docker.compose.project=lumen --filter label=com.docker.compose.service=livekit)$(docker ps -aq --filter label=com.docker.compose.project=lumen --filter label=com.docker.compose.service=lkjwt)" ]] \
    && ok "calls off: SFU and authorization service removed" || bad "calls off: SFU and authorization service removed"
  if ufw status | grep -q "lumen: calls"; then bad "calls off: Lumen's calls firewall rules closed"; else ok "calls off: Lumen's calls firewall rules closed"; fi
  if grep -q matrix_rtc /etc/lumen/rendered/synapse/homeserver.yaml; then bad "calls off: homeserver no longer advertises the SFU"; else ok "calls off: homeserver no longer advertises the SFU"; fi
  python3 -c "import json,sys; sys.exit(0 if json.load(open('/etc/lumen/rendered/chat/config.json'))['calls']['enabled'] is False else 1)" \
    && ok "calls off: chat app configured without calls" || bad "calls off: chat app configured without calls"
  check "data kept with calls off (marker A)" user_exists lcmarker-a
  sed -i 's/^CALLS_ENABLED=.*/CALLS_ENABLED=true/' "$CONF"
  check "install.sh with calls on again" bash install.sh --config "$CONF" --yes
  ufw status | grep -q "lumen: calls media" && ok "calls on: firewall rules back" || bad "calls on: firewall rules back"
  check "calls on: media flows again" media_ok
fi

echo "--- uninstall (keep data) and re-install"
check "uninstall.sh keeps data" ./uninstall.sh --yes --confirm "$domain"
running="$(docker ps --filter label=com.docker.compose.project=lumen -q | wc -l)"
((running == 0)) && ok "no Lumen containers left running" || bad "no Lumen containers left running" "$running running"
[[ -s /var/lib/lumen/synapse/signing.key && -d /var/lib/lumen/postgres ]] && ok "data directories kept" || bad "data directories kept"
ls /var/backups/lumen/*.tar.age >/dev/null 2>&1 && ok "backups kept" || bad "backups kept"
systemctl is-active --quiet lumen-agent && bad "host agent removed" || ok "host agent removed"
check "re-install on kept data succeeds" bash install.sh --config "$CONF" --yes
check "kept data is live again (marker A)" user_exists lcmarker-a
[[ "$(signing_hash)" == "$k0" ]] && ok "same server identity after re-install" || bad "same server identity after re-install"
calls_on && check "calls: media flows after uninstall + re-install" media_ok

echo "--- secret leak scan"
leaks=0
while IFS= read -r -d '' f; do
  val="$(head -c 4096 "$f")"
  [[ ${#val} -lt 12 ]] && continue
  first_line="$(printf '%s\n' "$val" | grep -v '^-----' | head -n1)"
  [[ ${#first_line} -lt 12 ]] && continue
  if grep -rqF -- "$first_line" /var/log/lumen /root/diagnose.out /root/install-*.log 2>/dev/null; then
    echo "  secret from $(basename "$f") found in logs" >>"$LOG"; leaks=$((leaks + 1))
  fi
done < <(find /etc/lumen/secrets -type f -size +0 -print0)
((leaks == 0)) && ok "no secret values in installer/ops logs or diagnose output" || bad "no secret values in logs" "$leaks secrets leaked"

echo "lifecycle: $pass passed, $fail failed"
exit "$fail"
