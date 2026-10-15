#!/usr/bin/env bash
# End-to-end WireGuard test on an installed Lumen host (WIREGUARD_ENABLED=true).
# Creates a peer through the host agent (server-generated keys), brings it up in
# a separate network namespace connected by a veth pair, verifies that the
# operator console is reachable only through the tunnel, then revokes the peer
# and verifies access is gone. Requires root; uses wireguard-go if the kernel
# module is unavailable.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CA="${LUMEN_TEST_CA:-/etc/lumen/ca/caddy-local-root.crt}"
OPS="$(grep -E '^LUMEN_OPS_DOMAIN=' /etc/lumen/lumen.conf | cut -d= -f2 || true)"; OPS="${OPS:-ops.$(grep -E '^LUMEN_PRIMARY_DOMAIN=' /etc/lumen/lumen.conf | cut -d= -f2)}"
PORT=8443; NS=lumenwgtest; PASS=0; FAILS=0
check() { if eval "$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
cleanup() { ip netns exec $NS wg-quick down /tmp/$NS/wgt0.conf >/dev/null 2>&1 || true; ip netns del $NS 2>/dev/null || true; ip link del vlwg0 2>/dev/null || true; rm -rf /tmp/$NS; }
trap cleanup EXIT
cleanup; mkdir -p /tmp/$NS; chmod 700 /tmp/$NS
"$REPO/lumenctl" wireguard add-peer "e2e-$$" >/tmp/$NS/peer.json
python3 -c "import json; d=json.load(open('/tmp/$NS/peer.json')); open('/tmp/$NS/wgt0.conf','w').write(d['config'])"
PUB="$(python3 -c "import json; print(json.load(open('/tmp/$NS/peer.json'))['public_key'])")"
check "generated profile contains a private key and a preshared key" "grep -q '^PrivateKey' /tmp/$NS/wgt0.conf && grep -q '^PresharedKey' /tmp/$NS/wgt0.conf"
check "server config does not contain the client private key" "! grep -qF \"\$(grep '^PrivateKey' /tmp/$NS/wgt0.conf | cut -d' ' -f3)\" /etc/wireguard/wg0.conf"
ip netns add $NS; ip link add vlwg0 type veth peer name vlwg1; ip link set vlwg1 netns $NS
ip addr add 192.168.78.1/24 dev vlwg0; ip link set vlwg0 up
ip netns exec $NS ip addr add 192.168.78.2/24 dev vlwg1; ip netns exec $NS ip link set vlwg1 up; ip netns exec $NS ip link set lo up
sed -i 's/^Endpoint = .*/Endpoint = 192.168.78.1:51820/' /tmp/$NS/wgt0.conf; chmod 600 /tmp/$NS/wgt0.conf
ip netns exec $NS env WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go wg-quick up /tmp/$NS/wgt0.conf >/dev/null 2>&1
code() { ip netns exec $NS curl -s --noproxy '*' --cacert "$CA" --max-time 6 --resolve "$OPS:$PORT:$1" -o /dev/null -w '%{http_code}' "https://$OPS:$PORT/accounts/login/" || true; }
check "console reachable through the tunnel" '[[ "$(code 10.77.0.1)" == 200 ]]'
check "console NOT reachable from a non-allow-listed network" '[[ "$(code 192.168.78.1)" == 000 ]]'
check "agent reports a recent handshake with PSK" "\"$REPO/lumenctl\" wireguard status | python3 -c \"import json,sys; d=json.load(sys.stdin); p=[x for x in d['peers'] if x['public_key']=='$PUB'][0]; sys.exit(0 if p['latest_handshake'] and p['preshared_key'] else 1)\""
"$REPO/lumenctl" wireguard remove-peer "$PUB" >/dev/null
sleep 1
check "access revoked after removing the peer" '[[ "$(code 10.77.0.1)" == 000 ]]'
check "peer removed from wg0.conf" "! grep -q '$PUB' /etc/wireguard/wg0.conf"
echo "wireguard e2e: $PASS passed, $FAILS failed"
exit $FAILS
