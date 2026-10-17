#!/usr/bin/env bash
# End-to-end WireGuard test on an installed Lumen host (WireGuard on). Run as root.
#
#   bash tests/integration/wireguard_e2e.sh                     # a new peer from the host agent
#   bash tests/integration/wireguard_e2e.sh --profile FILE      # an existing profile, e.g. the
#                                                               # installer's first-device.conf
#
# Default: creates a peer through the host agent (server-generated keys), brings it up in a
# separate network namespace connected by a veth pair, verifies that the operator console is
# reachable only through the tunnel, then revokes the peer and verifies access is gone.
# --profile: the same checks with the given profile (copied; only its Endpoint is pointed at the
# veth address), without revoking it. Uses wireguard-go if the kernel module is unavailable.
# Never prints key material.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE=""
[[ "${1:-}" == --profile ]] && PROFILE="${2:?--profile FILE}"
CONF=/etc/lumen/lumen.conf
cget() { local v; v="$(grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2-)"; printf '%s' "${v:-$2}"; }
CA="${LUMEN_TEST_CA:-/etc/lumen/ca/caddy-local-root.crt}"
OPS="$(cget LUMEN_OPS_DOMAIN "ops.$(cget LUMEN_PRIMARY_DOMAIN "")")"
PORT="$(cget LUMEN_OPS_PORT 8443)"; WGPORT="$(cget WG_PORT 51820)"
SERVER_WG_IP="$(python3 -c "import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))" "$(cget WG_SUBNET 10.77.0.0/24)")"
NS=lumenwgtest; DIR=/tmp/$NS; PASS=0; FAILS=0
check() { if eval "$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
cleanup() { ip netns exec $NS wg-quick down $DIR/wgt0.conf >/dev/null 2>&1 || true; ip netns del $NS 2>/dev/null || true; ip link del vlwg0 2>/dev/null || true; rm -rf $DIR; }
trap cleanup EXIT
cleanup; mkdir -p $DIR; chmod 700 $DIR
if [[ -n "$PROFILE" ]]; then
  [[ -f "$PROFILE" ]] || { echo "FAIL profile $PROFILE exists"; exit 1; }
  install -m 0600 "$PROFILE" $DIR/wgt0.conf
  PUB="$(grep -E '^PrivateKey' $DIR/wgt0.conf | sed -E 's/^PrivateKey *= *//' | wg pubkey)"
else
  "$REPO/lumenctl" wireguard add-peer "e2e-$$" >$DIR/peer.json
  python3 -c "import json; d=json.load(open('$DIR/peer.json')); open('$DIR/wgt0.conf','w').write(d['config'])"
  PUB="$(python3 -c "import json; print(json.load(open('$DIR/peer.json'))['public_key'])")"
fi
check "profile contains a private key and a preshared key" "grep -q '^PrivateKey' $DIR/wgt0.conf && grep -q '^PresharedKey' $DIR/wgt0.conf"
check "server config does not contain the device's private key" "! grep -qF \"\$(grep '^PrivateKey' $DIR/wgt0.conf | sed -E 's/^PrivateKey *= *//')\" /etc/wireguard/wg0.conf"
check "server knows the device with its preshared key" "grep -A3 -F 'PublicKey = $PUB' /etc/wireguard/wg0.conf | grep -q '^PresharedKey'"
ip netns add $NS; ip link add vlwg0 type veth peer name vlwg1; ip link set vlwg1 netns $NS
ip addr add 192.168.78.1/24 dev vlwg0; ip link set vlwg0 up
ip netns exec $NS ip addr add 192.168.78.2/24 dev vlwg1; ip netns exec $NS ip link set vlwg1 up; ip netns exec $NS ip link set lo up
sed -i "s/^Endpoint = .*/Endpoint = 192.168.78.1:$WGPORT/" $DIR/wgt0.conf; chmod 600 $DIR/wgt0.conf
ip netns exec $NS env WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go wg-quick up $DIR/wgt0.conf >/dev/null 2>&1
code() { ip netns exec $NS curl -s --noproxy '*' --cacert "$CA" --max-time 6 --resolve "$OPS:$PORT:$1" -o /dev/null -w '%{http_code}' "https://$OPS:$PORT/accounts/login/" || true; }
check "console reachable through the tunnel ($SERVER_WG_IP)" '[[ "$(code "$SERVER_WG_IP")" == 200 ]]'
check "console NOT reachable from a non-tunnel address (192.168.78.2 -> 192.168.78.1)" '[[ "$(code 192.168.78.1)" == 000 ]]'
check "agent reports a recent handshake with PSK" "\"$REPO/lumenctl\" wireguard status | python3 -c \"import json,sys; d=json.load(sys.stdin); p=[x for x in d['peers'] if x['public_key']=='$PUB'][0]; sys.exit(0 if p['latest_handshake'] and p['preshared_key'] else 1)\""
if [[ -z "$PROFILE" ]]; then
  "$REPO/lumenctl" wireguard remove-peer "$PUB" >/dev/null
  sleep 1
  check "access revoked after removing the peer" '[[ "$(code "$SERVER_WG_IP")" == 000 ]]'
  check "peer removed from wg0.conf" "! grep -q '$PUB' /etc/wireguard/wg0.conf"
fi
echo "wireguard e2e: $PASS passed, $FAILS failed"
exit $FAILS
