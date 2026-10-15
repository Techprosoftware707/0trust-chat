#!/usr/bin/env bash
# Calls x WireGuard x firewall x ICE/TURN, on an installed Lumen host with
# WIREGUARD_ENABLED=true and CALLS_ENABLED=true (run as root).
#
#   sudo bash tests/calls/wg_calls.sh
#
# A client namespace gets a real WireGuard profile from the host agent (like an
# operator laptop). Real WebRTC participants (LiveKit's load tester binary, run
# inside the namespace) then join an SFU room in three network situations:
#   1. the profile as issued (split tunnel: only the server's WireGuard address):
#      calls must keep working with the VPN up — ICE picks whatever path works;
#   2. a full-tunnel style profile that also routes the SFU's address through
#      WireGuard: media must flow inside the tunnel (firewall on wg0 included);
# Each scenario passes only if the subscriber received audio and video.
# (TCP fallback with all UDP blocked is covered by the browser tests in this
# directory: LiveKit's Go load tester does not attempt ICE/TCP or TURN/TLS.)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NS=lumenwgcall; PASS=0; FAILS=0
CA=/etc/lumen/ca/bundle.crt
# shellcheck disable=SC1091
set -a; source /etc/lumen/rendered/compose.env; source "$REPO/deploy/versions.env"; set +a
RTC="$LUMEN_RTC_DOMAIN"
NODE_IP="$(grep -E '^CALLS_PUBLIC_IP=' /etc/lumen/lumen.conf | cut -d= -f2)"
[[ -n "$NODE_IP" ]] || { echo "set CALLS_PUBLIC_IP for this lab test"; exit 2; }
LK="${LK_BIN:-/tmp/lk-$$}"
check() { if eval "$2"; then echo "PASS $1"; PASS=$((PASS + 1)); else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi; }
cleanup() {
  ip netns exec $NS wg-quick down /tmp/$NS/wgt0.conf >/dev/null 2>&1 || true
  ip netns del $NS 2>/dev/null || true; ip link del vlwc0 2>/dev/null || true
  rm -rf /tmp/$NS /etc/netns/$NS; [[ -z "${LK_BIN:-}" ]] && rm -f "$LK"
  [[ -n "${PUB:-}" ]] && "$REPO/lumenctl" wireguard remove-peer "$PUB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup; mkdir -p /tmp/$NS /etc/netns/$NS; chmod 700 /tmp/$NS
if [[ -z "${LK_BIN:-}" ]]; then cid="$(docker create "$LIVEKIT_CLI_IMAGE")"; docker cp "$cid:/lk" "$LK" >/dev/null; docker rm "$cid" >/dev/null; fi
KEY="$(cut -d: -f1 /etc/lumen/secrets/livekit_keys)"; SECRET="$(cut -d: -f2 /etc/lumen/secrets/livekit_keys | tr -d ' \n')"

"$REPO/lumenctl" wireguard add-peer "callnet-$$" >/tmp/$NS/peer.json
python3 -c "import json; d=json.load(open('/tmp/$NS/peer.json')); open('/tmp/$NS/wgt0.conf','w').write(d['config'])"
PUB="$(python3 -c "import json; print(json.load(open('/tmp/$NS/peer.json'))['public_key'])")"
ip netns add $NS; ip link add vlwc0 type veth peer name vlwc1; ip link set vlwc1 netns $NS
ip addr add 192.168.79.1/24 dev vlwc0; ip link set vlwc0 up
ip netns exec $NS ip addr add 192.168.79.2/24 dev vlwc1; ip netns exec $NS ip link set vlwc1 up; ip netns exec $NS ip link set lo up
sed -i 's/^Endpoint = .*/Endpoint = 192.168.79.1:51820/' /tmp/$NS/wgt0.conf; chmod 600 /tmp/$NS/wgt0.conf
up_wg() { ip netns exec $NS env WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go wg-quick up /tmp/$NS/wgt0.conf >/dev/null 2>&1; }
up_wg
WG_IP="$(grep -E '^Address' /tmp/$NS/wgt0.conf | awk '{print $3}' | cut -d/ -f1)"
SERVER_WG_IP="$(python3 -c "import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))" "$(grep -E '^WG_SUBNET=' /etc/lumen/lumen.conf | cut -d= -f2 || echo 10.77.0.0/24)")"
# Inside the namespace the server's hostnames resolve to the SFU's advertised address.
printf '%s %s\n' "$NODE_IP" "$RTC" >/etc/netns/$NS/hosts

wg_bytes() { ip netns exec $NS cat /sys/class/net/wgt0/statistics/tx_bytes 2>/dev/null || echo 0; }
call() { # -> prints the load tester's "Total" row; exit 0 if 2/2 tracks were received
  local room out; room="wgcall-$(openssl rand -hex 3)"
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_rtc" -e LIVEKIT_URL="https://$RTC" -e LIVEKIT_API_KEY="$KEY" -e LIVEKIT_API_SECRET="$SECRET" \
    --add-host "$RTC:$RTC_GATEWAY_IP" -v "$CA:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt "$LIVEKIT_CLI_IMAGE" room create "$room" >/dev/null 2>&1 || return 1
  out="$(timeout 90 ip netns exec $NS env -i PATH=/usr/bin:/bin SSL_CERT_FILE="$CA" LIVEKIT_API_KEY="$KEY" LIVEKIT_API_SECRET="$SECRET" \
    "$LK" load-test --url "wss://$RTC" --room "$room" --audio-publishers 1 --video-publishers 1 --subscribers 1 --duration 12s 2>&1)"
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_rtc" -e LIVEKIT_URL="https://$RTC" -e LIVEKIT_API_KEY="$KEY" -e LIVEKIT_API_SECRET="$SECRET" \
    --add-host "$RTC:$RTC_GATEWAY_IP" -v "$CA:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt "$LIVEKIT_CLI_IMAGE" room delete "$room" >/dev/null 2>&1
  printf '%s\n' "$out" | grep -E '^│ Total +│' | head -n1
  printf '%s' "$out" | grep -Eq '^│ Total +│ 2/2 '
}

echo "--- 1. profile as issued (split tunnel), VPN up"
ip netns exec $NS ip route replace "$NODE_IP/32" via 192.168.79.1 dev vlwc1
b0="$(wg_bytes)"; r="$(call)"; rc=$?; b1="$(wg_bytes)"; echo "    $r"
echo "    ($(( (b1 - b0) / 1024 )) KiB left through wg0: ICE may also use the tunnel interface's address)"
check "call media flows with the operator VPN up" "[[ $rc -eq 0 ]]"

echo "--- 2. SFU address routed through WireGuard (AllowedIPs += $NODE_IP/32)"
SERVER_PUB="$(grep -E '^PublicKey' /tmp/$NS/wgt0.conf | awk '{print $3}')"
ip netns exec $NS wg set wgt0 peer "$SERVER_PUB" allowed-ips "$SERVER_WG_IP/32,$NODE_IP/32"
ip netns exec $NS ip route replace "$NODE_IP/32" dev wgt0
if [[ -n "${DEBUG:-}" ]]; then
  grep -E 'AllowedIPs|Address' /tmp/$NS/wgt0.conf; ip netns exec $NS ip route; ip netns exec $NS wg show | grep -vi key
  ip netns exec $NS env -i PATH=/usr/bin:/bin curl -s --cacert "$CA" --max-time 5 -o /dev/null -w "signalling via tunnel: %{http_code}\n" "https://$RTC/"
fi
b0="$(wg_bytes)"; r="$(call)"; rc=$?; b1="$(wg_bytes)"; echo "    $r"
check "call media flows through the tunnel" "[[ $rc -eq 0 ]]"
check "media really used the tunnel ($(( (b1 - b0) / 1024 )) KiB on wg0)" "[[ $((b1 - b0)) -gt 500000 ]]"
echo "    (server WG address $SERVER_WG_IP, client $WG_IP)"
echo "wireguard x calls: $PASS passed, $FAILS failed"
exit $FAILS
