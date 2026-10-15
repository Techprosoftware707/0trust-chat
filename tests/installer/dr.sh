#!/usr/bin/env bash
# Disaster-recovery test: rebuild a lost server on a NEW machine from a backup.
# Run as root inside a fresh test server (see vm.sh), with the old server's
# backup archive and offline backup key copied in:
#
#   bash /opt/lumen/tests/installer/dr.sh CONF ARCHIVE IDENTITY EXPECTED_SIGNING_SHA16 [MARKER_USER]
#
# Steps (the procedure in docs/operations/disaster-recovery.md):
#   1. install.sh on the new machine with the same lumen.conf
#   2. restore.sh --verify-only with the offline key
#   3. restore.sh --with-config (databases, media, signing key, configuration, secrets)
#   4. checks: data, server identity, health, and that install.sh still converges
set -uo pipefail
CONF="$1" ARCHIVE="$2" IDENTITY="$3" WANT_KEY="$4" MARKER="${5:-lcmarker-a}"
LOG=/root/dr-detail.log; : >"$LOG"
pass=0 fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail + 1)); }
check() { local name="$1"; shift; if "$@" >>"$LOG" 2>&1; then ok "$name"; else bad "$name" "see $LOG"; fi; }
domain="$(grep -E '^LUMEN_PRIMARY_DOMAIN=' "$CONF" | cut -d= -f2)"

check "fresh install on the replacement server" bash -c "cd /root/lumen && bash install.sh --config '$CONF' --yes"
cd /opt/lumen || exit 99
new_key="$(sha256sum /var/lib/lumen/synapse/signing.key | cut -c1-16)"
[[ "$new_key" != "$WANT_KEY" ]] && ok "replacement server starts with its own (different) identity" || bad "identity differs before restore"
check "backup verifies with the offline key" ./restore.sh --verify-only "$ARCHIVE" --identity "$IDENTITY"
check "full restore with configuration and secrets" ./restore.sh "$ARCHIVE" --with-config --identity "$IDENTITY" --yes --confirm "$domain"
[[ "$(sha256sum /var/lib/lumen/synapse/signing.key | cut -c1-16)" == "$WANT_KEY" ]] && ok "server identity (signing key) restored" || bad "server identity restored"
user_ok="$(./lumenctl manage shell -c "from apps.accounts.models import User; print(User.objects.filter(username='$MARKER').exists())" 2>>"$LOG" | tail -n1)"
[[ "$user_ok" == True ]] && ok "accounts from the old server are present ($MARKER)" || bad "accounts restored" "$user_ok"
mx_ok="$(./lumenctl compose exec -T postgres psql -qAtU postgres -d synapse -c "SELECT count(*) FROM users" 2>>"$LOG")"
[[ "${mx_ok:-0}" -gt 0 ]] && ok "homeserver accounts restored ($mx_ok users)" || bad "homeserver accounts" "$mx_ok"
./healthcheck.sh >>"$LOG" 2>&1; rc=$?
((rc <= 1)) && ok "healthy after restore on the new server (exit $rc)" || bad "healthy after restore" "exit $rc"
check "install.sh converges on the restored configuration" bash install.sh --config /etc/lumen/lumen.conf --yes
./healthcheck.sh >>"$LOG" 2>&1; rc=$?
((rc <= 1)) && ok "healthy after re-running the installer (exit $rc)" || bad "healthy after installer re-run" "exit $rc"
echo "dr: $pass passed, $fail failed"
exit "$fail"
