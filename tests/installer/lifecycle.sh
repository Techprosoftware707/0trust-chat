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
# after every lifecycle step. With WireGuard on (the default) it checks wg0, the
# installer's first device profile (file modes, a real tunnel from another network
# namespace, show-profile, forget-profile), that no re-install, update or restore
# adds a device or changes a key, and that no WireGuard key reaches any log; and DNS
# inside the tunnel (lumen-wg-dns on the tunnel address only, UFW 53 on wg0 only, the
# console's name resolved through the tunnel with no hosts entry, add-device profiles)
# after every step, also when the first device's profile predates the DNS line.
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
# WireGuard is on unless the configuration turns it off (the installer's default).
wg_on() { ! grep -qE '^WIREGUARD_ENABLED=(false|no|0|off)$' /etc/lumen/lumen.conf; }
WGD=/etc/lumen/wireguard; PROFILE=$WGD/first-device.conf
# Server key, preshared keys and the peer registry (not the stored profile, which forget-profile deletes).
wg_keys_hash() { { cat $WGD/server.key $WGD/peers.json; find $WGD/psk -type f -print0 | sort -z | xargs -0 cat; } 2>/dev/null | sha256sum | cut -c1-16; }
wg_endpoint() { grep -E '^WG_ENDPOINT=' /etc/lumen/lumen.conf | tail -n1 | cut -d= -f2; }
wg_peer_count() { python3 -c "import json; print(len(json.load(open('$WGD/peers.json'))))" 2>/dev/null || echo 0; }
wg_up() { ip link show wg0 >/dev/null 2>&1 && [[ "$(./lumenctl wireguard status 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["up"])')" == True ]]; }
mode_of() { stat -c '%a %U:%G' "$1"; }
wg_srv() { python3 -c "import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))" "$(grep -E '^WG_SUBNET=' /etc/lumen/lumen.conf | tail -n1 | cut -d= -f2 || echo 10.77.0.0/24)"; }
# DNS inside the tunnel: the unit runs with wg0 (enabled through its .wants), the state says so,
# and a real query on the tunnel address gets the console's name answered with that address.
wg_dns_ok() {
  systemctl is-active --quiet lumen-wg-dns.service && systemctl is-enabled --quiet lumen-wg-dns.service \
    && [[ -L /etc/systemd/system/wg-quick@wg0.service.wants/lumen-wg-dns.service ]] \
    && [[ "$(python3 -c "import json; print(json.load(open('/etc/lumen/state.json')).get('wireguard_dns',''))")" == enabled ]] \
    && LUMEN_CONF=/etc/lumen/lumen.conf LUMEN_STATE=/etc/lumen/state.json python3 deploy/host-agent/lumen_agent.py wg-dns-check --wait 15
}
# UFW: exactly Lumen's two DNS rules, both on wg0 to the tunnel address; no other rule for port 53.
wg_dns_ufw_ok() {
  local st; st="$(ufw status)"
  [[ "$(grep -cF '# lumen: wireguard dns' <<<"$st")" == 2 ]] \
    && grep -F '# lumen: wireguard dns' <<<"$st" | grep -qE "^$(wg_srv) 53/udp on wg0 +ALLOW" \
    && grep -F '# lumen: wireguard dns' <<<"$st" | grep -qE "^$(wg_srv) 53/tcp on wg0 +ALLOW" \
    && ! grep -E '(^|[ :])53(/(udp|tcp))?( |$)' <<<"$st" | grep -vqF '# lumen: wireguard dns'
}
# Key values to look for in logs, kept in a root-only file and never printed.
KEYS=/root/.lifecycle-wg-keys; : >"$KEYS"; chmod 600 "$KEYS"
collect_wg_keys() {
  { cat $WGD/server.key; cat $WGD/psk/*.psk; grep -hE '^(PrivateKey|PresharedKey)' $PROFILE | sed -E 's/^[A-Za-z]+ *= *//'; } 2>/dev/null \
    | grep -E '^[A-Za-z0-9+/]{43}=$' >>"$KEYS" || true
  sort -u -o "$KEYS" "$KEYS"
}

s0="$(secrets_hash)"; k0="$(signing_hash)"
make_user lcmarker-a
check "marker account A created" user_exists lcmarker-a
if wg_on; then
  collect_wg_keys
  w0="$(wg_keys_hash)"; p0="$(sha256sum $PROFILE 2>/dev/null | cut -c1-16)"; n0="$(wg_peer_count)"; e0="$(wg_endpoint)"
fi

echo "--- idempotent re-install"
check "install.sh re-run succeeds" bash install.sh --config "$CONF" --yes
[[ "$(secrets_hash)" == "$s0" ]] && ok "secrets unchanged by re-install" || bad "secrets unchanged by re-install"
[[ "$(signing_hash)" == "$k0" ]] && ok "homeserver signing key unchanged by re-install" || bad "homeserver signing key unchanged by re-install"
check "data kept across re-install (marker A)" user_exists lcmarker-a

if wg_on; then
  echo "--- WireGuard (on by default)"
  check "wg0 is up and reported up by the host agent" wg_up
  [[ "$(python3 -c "import json; print(json.load(open('/etc/lumen/state.json')).get('wireguard',''))")" == enabled ]] && ok "installer state: wireguard enabled" || bad "installer state: wireguard enabled"
  [[ "$(mode_of $PROFILE)" == "600 root:root" ]] && ok "first device profile is 0600 root:root" || bad "first device profile is 0600 root:root" "$(mode_of $PROFILE 2>&1)"
  [[ "$(mode_of $WGD)" == "700 root:root" ]] && ok "its directory is 0700 root:root" || bad "its directory is 0700 root:root" "$(mode_of $WGD 2>&1)"
  [[ "$n0" == 1 && "$(wg_peer_count)" == 1 ]] && ok "re-install added no second device (1 peer)" || bad "re-install added no second device" "$n0 -> $(wg_peer_count)"
  [[ "$(wg_keys_hash)" == "$w0" && "$(sha256sum $PROFILE | cut -c1-16)" == "$p0" ]] && ok "re-install changed no WireGuard key and left the profile as it was" || bad "re-install changed no WireGuard key"
  # The re-install copied $CONF (without WG_ENDPOINT) over lumen.conf again: the endpoint in
  # the devices' profiles must be kept, not detected anew.
  [[ -n "$e0" && "$(wg_endpoint)" == "$e0" ]] && ok "WG_ENDPOINT kept across the --config re-install ($e0)" || bad "WG_ENDPOINT kept across the --config re-install" "$e0 -> $(wg_endpoint)"
  check "DNS in the tunnel: lumen-wg-dns active, started with wg0, answers the console's name" wg_dns_ok
  check "UFW: 53/udp and 53/tcp allowed only on wg0, to the tunnel address" wg_dns_ufw_ok
  if grep -q '^DNS = ' "$PROFILE"; then echo "INFO first device profile sets $(grep '^DNS = ' "$PROFILE")"; else echo "INFO first device profile has no DNS line (made before DNS in the tunnel; kept as it was)"; fi
  check "the generated profile works from another network namespace: console only through the tunnel, by name with no hosts entry" bash tests/integration/wireguard_e2e.sh --profile "$PROFILE"
  check "a device added later works (by name, through the tunnel DNS) and can be revoked" bash tests/integration/wireguard_e2e.sh
  # A phone profile from the command line: stored root-only, shown as a QR code, then forgotten.
  APROF=$WGD/profiles/lc-phone.conf
  ./lumenctl wireguard add-device lc-phone >/root/add-device.out 2>&1; rc=$?
  { grep -hE '^(PrivateKey|PresharedKey)' "$APROF" | sed -E 's/^[A-Za-z]+ *= *//'; cat $WGD/psk/*.psk; } 2>/dev/null | grep -E '^[A-Za-z0-9+/]{43}=$' >>"$KEYS" || true
  if ((rc == 0)) && [[ "$(mode_of "$APROF")" == "600 root:root" && "$(mode_of $WGD/profiles)" == "700 root:root" ]] \
    && grep -qx "DNS = $(wg_srv)" "$APROF" && grep -qx "AllowedIPs = $(wg_srv)/32" "$APROF" && ! grep -qF -f "$KEYS" /root/add-device.out; then
    ok "add-device stores a root-only profile (0600 in 0700) with DNS = $(wg_srv), split tunnel kept; prints no key"
  else
    bad "add-device stores a root-only profile with the DNS line" "exit $rc"
  fi
  ./lumenctl wireguard show-profile lc-phone >/root/show-profile.out 2>&1; rc=$?
  if ((rc == 0)) && grep -q "$APROF" /root/show-profile.out && grep -q '█' /root/show-profile.out && ! grep -qF -f "$KEYS" /root/show-profile.out \
    && grep -q 'forget-profile lc-phone' /root/show-profile.out; then
    ok "show-profile lc-phone prints the path and a QR code, no key as text"
  else
    bad "show-profile lc-phone prints the path and a QR code" "exit $rc"
  fi
  rm -f /root/show-profile.out /root/add-device.out
  check "the add-device profile works by name through the tunnel DNS" bash tests/integration/wireguard_e2e.sh --profile "$APROF"
  check "forget-profile lc-phone deletes it" ./lumenctl wireguard forget-profile lc-phone
  lcpub="$(python3 -c "import json; print([p['public_key'] for p in json.load(open('$WGD/peers.json')) if p['name']=='lc-phone'][0])" 2>/dev/null)"
  check "remove-peer revokes lc-phone" ./lumenctl wireguard remove-peer "$lcpub"
  [[ ! -e "$APROF" && "$(wg_peer_count)" == 1 ]] && ok "lc-phone gone again: no stored profile, 1 peer" || bad "lc-phone gone again" "$(wg_peer_count) peers"
  [[ "$(wg_keys_hash)" == "$w0" ]] && ok "the first device's keys and the registry are as before" || bad "the first device's keys and the registry are as before"
  ./lumenctl wireguard show-profile >/root/show-profile.out 2>&1; rc=$?
  if ((rc == 0)) && grep -q "$PROFILE" /root/show-profile.out && grep -q '█' /root/show-profile.out && ! grep -qF -f "$KEYS" /root/show-profile.out; then
    ok "show-profile prints the path and a QR code, no key as text"
  else
    bad "show-profile prints the path and a QR code, no key as text" "exit $rc"
  fi
  rm -f /root/show-profile.out
  grep -q "AUDIT wireguard show-profile" /var/log/lumen/lumenctl-latest.log && ok "show-profile is logged (without the profile)" || bad "show-profile is logged"
  check "forget-profile deletes the stored profile" ./lumenctl wireguard forget-profile
  [[ ! -e $PROFILE ]] && ok "profile gone; the device stays registered ($(wg_peer_count) peer)" || bad "profile gone after forget-profile"
  check "forget-profile again is harmless" ./lumenctl wireguard forget-profile
  if ./lumenctl wireguard show-profile >/dev/null 2>&1; then bad "show-profile refuses once the profile is forgotten"; else ok "show-profile refuses once the profile is forgotten"; fi
  w1="$(wg_keys_hash)"
fi
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
if wg_on; then
  check "WireGuard: wg0 up after restore" wg_up
  check "WireGuard: DNS in the tunnel answers after restore" wg_dns_ok
  [[ "$(wg_keys_hash)" == "$w1" && ! -e $PROFILE ]] && ok "WireGuard: restore changed no key and re-created no profile" || bad "WireGuard: restore changed no key and re-created no profile"
fi

echo "--- update"
check "update.sh --no-pull succeeds" bash -c './update.sh --no-pull --yes >/root/update.out 2>&1'
check "healthy after update" healthy
check "data kept across update (marker A)" user_exists lcmarker-a
calls_on && check "calls: media flows after update" media_ok
if wg_on; then
  check "WireGuard: wg0 up after update" wg_up
  check "WireGuard: DNS in the tunnel answers after update" wg_dns_ok
  check "WireGuard: UFW DNS rules unchanged by update (wg0 only)" wg_dns_ufw_ok
  grep -q "^WireGuard: DNS in the tunnel on $(wg_srv)" /root/update.out && ok "update summary names DNS in the tunnel" || bad "update summary names DNS in the tunnel"
  check "WireGuard: a device added after the update (the console's path, through the agent) gets the DNS line and works by name" bash tests/integration/wireguard_e2e.sh
  [[ "$(wg_keys_hash)" == "$w1" && "$(wg_peer_count)" == 1 && ! -e $PROFILE ]] && ok "WireGuard: update added no device, changed no key, re-created no profile" || bad "WireGuard: update added no device, changed no key"
fi

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
if wg_on; then
  if systemctl is-active --quiet lumen-wg-dns.service || [[ -e /etc/systemd/system/lumen-wg-dns.service ]] || ss -Hlnu 'sport = :53' | grep -qF "$(wg_srv):53" \
    || ufw status | grep -qF 'lumen: wireguard dns'; then
    bad "uninstall stopped the tunnel DNS (unit removed, nothing on $(wg_srv):53, its UFW rules gone)"
  else
    ok "uninstall stopped the tunnel DNS (unit removed, nothing on $(wg_srv):53, its UFW rules gone)"
  fi
fi
check "re-install on kept data succeeds" bash install.sh --config "$CONF" --yes
check "kept data is live again (marker A)" user_exists lcmarker-a
[[ "$(signing_hash)" == "$k0" ]] && ok "same server identity after re-install" || bad "same server identity after re-install"
calls_on && check "calls: media flows after uninstall + re-install" media_ok
if wg_on; then
  check "WireGuard: wg0 up again after uninstall + re-install" wg_up
  check "WireGuard: DNS in the tunnel answers again after uninstall + re-install" wg_dns_ok
  check "WireGuard: UFW DNS rules back, wg0 only" wg_dns_ufw_ok
  [[ "$(wg_keys_hash)" == "$w1" && "$(wg_peer_count)" == 1 && ! -e $PROFILE ]] && ok "WireGuard: same keys and devices after uninstall + re-install, no new profile" || bad "WireGuard: same keys and devices after uninstall + re-install"
  [[ "$(wg_endpoint)" == "$e0" ]] && ok "WireGuard: WG_ENDPOINT unchanged through every re-install, restore and update" || bad "WireGuard: WG_ENDPOINT unchanged" "$e0 -> $(wg_endpoint)"
fi

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
if wg_on; then
  # Every WireGuard key value this test saw (server, preshared, the first device's private key),
  # and any "PrivateKey = <key>" / "PresharedKey = <key>" line, in the logs and in every
  # installer output of this run (the summaries included).
  scan=(/var/log/lumen /root/diagnose.out "$LOG")
  for f in /root/install-*.log; do [[ -e "$f" ]] && scan+=("$f"); done
  wgleaks="$(grep -rlF -f "$KEYS" "${scan[@]}" 2>/dev/null | wc -l)"
  wglines="$(grep -rlE '(PrivateKey|PresharedKey) *= *[A-Za-z0-9+/]{43}=' "${scan[@]}" 2>/dev/null | wc -l)"
  ((wgleaks == 0 && wglines == 0 && $(wc -l <"$KEYS") >= 3)) && ok "no WireGuard key in any log or installer summary ($(wc -l <"$KEYS") key values checked)" \
    || bad "no WireGuard key in logs or summaries" "$wgleaks file(s) with a key value, $wglines with a key line"
fi
rm -f "$KEYS"

echo "lifecycle: $pass passed, $fail failed"
exit "$fail"
