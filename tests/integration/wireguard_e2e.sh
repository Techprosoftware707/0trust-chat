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
#
# DNS inside the tunnel: the peer has NO hosts entry for the console. Its resolver is the profile's
# DNS server (what the WireGuard app does with the DNS line; a profile issued before DNS in the
# tunnel existed gets it by hand, as the admin guide tells operators). The console's name must
# resolve to the tunnel address through the tunnel and load with a certificate valid for that
# name; another name must resolve through the server's forwarding (LUMEN_E2E_FORWARD_NAME,
# default example.com: a name this server's upstream resolver answers; skipped, with the reason,
# when that upstream answers nothing). The forwarder must answer on no other address.
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
FWD_NAME="${LUMEN_E2E_FORWARD_NAME:-example.com}"
NS=lumenwgtest; DIR=/tmp/$NS; NSETC=/etc/netns/$NS; PASS=0; FAILS=0
check() { if eval "$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
cleanup() { ip netns exec $NS wg-quick down $DIR/wgt0.conf >/dev/null 2>&1 || true; ip netns del $NS 2>/dev/null || true; ip link del vlwg0 2>/dev/null || true; rm -rf $DIR $NSETC; }
trap cleanup EXIT
cleanup; mkdir -p $DIR; chmod 700 $DIR
# dnsq SERVER NAME [TYPE] [tcp] -> "rcode addr,addr" (or "noanswer"), with the host agent's DNS
# client: on this server (dnsq) or from inside the peer's namespace (nsdnsq).
DNSQ_PY='
import sys
sys.path.insert(0, sys.argv[1])
import lumen_agent as a
server, name = sys.argv[2], sys.argv[3]
qtype = int(sys.argv[4]) if len(sys.argv) > 4 else 1
try:
    rcode, addrs = a.dns_query(server, name, qtype, timeout=2, tcp=len(sys.argv) > 5)
    print(rcode, ",".join(sorted(addrs)))
except (OSError, ValueError):
    print("noanswer")
'
dnsq() { python3 -c "$DNSQ_PY" "$REPO/deploy/host-agent" "$@"; }
nsdnsq() { ip netns exec $NS python3 -c "$DNSQ_PY" "$REPO/deploy/host-agent" "$@"; }
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
check "split tunnel: the profile routes only $SERVER_WG_IP/32 into the tunnel" "[[ \"\$(sed -nE 's/^AllowedIPs *= *//p' $DIR/wgt0.conf | tr -d ' ')\" == '$SERVER_WG_IP/32' ]]"
PDNS="$(sed -nE 's/^DNS *= *//p' $DIR/wgt0.conf | head -n1 | cut -d, -f1 | tr -d ' ')"
if [[ -n "$PDNS" || -z "$PROFILE" ]]; then
  # A profile the agent makes now must carry the DNS line; an older one may lack it.
  check "the profile sets DNS = $SERVER_WG_IP (the server's tunnel address)" "[[ '$PDNS' == '$SERVER_WG_IP' ]]"
  PDNS="${PDNS:-$SERVER_WG_IP}"
else
  echo "INFO the profile has no DNS line (issued before DNS in the tunnel): DNS server $SERVER_WG_IP set by hand, as the admin guide says for existing devices"
  PDNS="$SERVER_WG_IP"
fi
check "DNS in the tunnel is enabled on this server" "[[ \"\$(python3 -c \"import json; print(json.load(open('/etc/lumen/state.json')).get('wireguard_dns',''))\")\" == enabled ]]"
# wg-quick would hand the DNS line to resolvconf, i.e. change THIS host's resolver: the namespace
# gets its own resolv.conf instead (ip netns exec mounts /etc/netns/<ns>/* over /etc/*).
sed -i '/^DNS *=/d' $DIR/wgt0.conf
mkdir -p $NSETC
printf 'nameserver %s\noptions timeout:2 attempts:2\n' "$PDNS" >$NSETC/resolv.conf
printf '127.0.0.1 localhost\n::1 localhost ip6-localhost\n' >$NSETC/hosts
ip netns add $NS; ip link add vlwg0 type veth peer name vlwg1; ip link set vlwg1 netns $NS
ip addr add 192.168.78.1/24 dev vlwg0; ip link set vlwg0 up
ip netns exec $NS ip addr add 192.168.78.2/24 dev vlwg1; ip netns exec $NS ip link set vlwg1 up; ip netns exec $NS ip link set lo up
sed -i "s/^Endpoint = .*/Endpoint = 192.168.78.1:$WGPORT/" $DIR/wgt0.conf; chmod 600 $DIR/wgt0.conf
ip netns exec $NS env WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go wg-quick up $DIR/wgt0.conf >/dev/null 2>&1
cacert=(); [[ -f "$CA" ]] && cacert=(--cacert "$CA")
code() { ip netns exec $NS curl -s --noproxy '*' "${cacert[@]}" --max-time 6 --resolve "$OPS:$PORT:$1" -o /dev/null -w '%{http_code}' "https://$OPS:$PORT/accounts/login/" || true; }
check "console reachable through the tunnel ($SERVER_WG_IP)" '[[ "$(code "$SERVER_WG_IP")" == 200 ]]'
check "console NOT reachable from a non-tunnel address (192.168.78.2 -> 192.168.78.1)" '[[ "$(code 192.168.78.1)" == 000 ]]'
check "agent reports a recent handshake with PSK" "\"$REPO/lumenctl\" wireguard status | python3 -c \"import json,sys; d=json.load(sys.stdin); p=[x for x in d['peers'] if x['public_key']=='$PUB'][0]; sys.exit(0 if p['latest_handshake'] and p['preshared_key'] else 1)\""

echo "--- DNS inside the tunnel (the peer has no hosts entry for $OPS)"
check "the peer has no hosts entry for $OPS and uses $PDNS as its DNS server" '! ip netns exec $NS grep -qwF "$OPS" /etc/hosts && ip netns exec $NS grep -qx "nameserver $PDNS" /etc/resolv.conf'
resolved="$(ip netns exec $NS getent ahostsv4 "$OPS" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || true)"
echo "INFO $OPS on the peer: ${resolved:-<nothing>}"
check "$OPS resolves through the tunnel DNS to $SERVER_WG_IP" '[[ "$resolved" == "$SERVER_WG_IP" ]]'
check "the same answer over TCP" '[[ "$(nsdnsq "$PDNS" "$OPS" 1 tcp)" == "0 $SERVER_WG_IP" ]]'
check "no IPv6 (AAAA) or HTTPS record for $OPS: empty answers, so nothing can bypass the tunnel" '[[ "$(nsdnsq "$PDNS" "$OPS" 28)" == "0 " && "$(nsdnsq "$PDNS" "$OPS" 65)" == "0 " ]]'
named="$(ip netns exec $NS curl -s --noproxy '*' "${cacert[@]}" --max-time 8 -o /dev/null -w '%{http_code} %{remote_ip} %{ssl_verify_result}' "https://$OPS:$PORT/accounts/login/" || true)"
echo "INFO https://$OPS:$PORT/ by name from the peer: HTTP code, remote address, TLS verify result = $named"
check "the console loads by name through the tunnel, with a certificate valid for $OPS" '[[ "$named" == "200 $SERVER_WG_IP 0" ]]'
# Forwarding: what this server's own upstream resolver answers for FWD_NAME, asked directly.
upfile="$(sed -nE 's/^resolv-file=//p' /etc/lumen/wireguard/dnsmasq.conf 2>/dev/null || true)"
upstream="$(sed -nE 's/^nameserver +([^ ]+).*/\1/p' "${upfile:-/etc/resolv.conf}" 2>/dev/null | grep -vxF "$SERVER_WG_IP" | head -n1 || true)"
direct="$( [[ -n "$upstream" ]] && dnsq "$upstream" "$FWD_NAME" 1 || echo noanswer)"
if [[ "$direct" =~ ^0\ [0-9] ]]; then
  via="$(ip netns exec $NS getent ahostsv4 "$FWD_NAME" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || true)"
  echo "INFO $FWD_NAME: through the tunnel DNS ${via:-<nothing>}; from the upstream $upstream (read from $upfile) directly ${direct#0 }"
  # shellcheck disable=SC2034  # read by the check below (evaluated there)
  overlap="$(comm -12 <(tr ',' '\n' <<<"$via" | sort) <(tr ',' '\n' <<<"${direct#0 }" | sort) | head -n1)"
  check "other names are forwarded to the server's upstream resolver ($FWD_NAME)" '[[ -n "$overlap" && ",$via," != *",$SERVER_WG_IP,"* ]]'
else
  echo "SKIP forwarding of $FWD_NAME: this server's upstream resolver (${upstream:-none} from ${upfile:-?}) does not answer it here (no outside DNS); set LUMEN_E2E_FORWARD_NAME to a name it resolves"
fi
check "no DNS answer on the server's non-tunnel address 192.168.78.1 (from the peer)" '[[ "$(nsdnsq 192.168.78.1 "$OPS")" == noanswer ]]'
# On the server itself (no firewall in between): no address but the tunnel address answers.
others="$(ip -o addr show | awk '{split($4, a, "/"); print a[1]}' | grep -vxF "$SERVER_WG_IP" | grep -v '^fe80' | sort -u)"
leaks=""; n=0
for a in 127.0.0.1 $others; do
  n=$((n+1)); r="$(dnsq "$a" "$OPS")"
  [[ "$r" == *"$SERVER_WG_IP"* ]] && leaks+=" $a"
done
echo "INFO asked $n other addresses of this server (127.0.0.1 and every interface address) for $OPS:${leaks:- none answered with $SERVER_WG_IP}"
check "the forwarder answers on no other address of this server" '[[ -z "$leaks" && $n -ge 2 ]]'
dnspid="$(systemctl show -p MainPID --value lumen-wg-dns.service 2>/dev/null || cat /run/lumen-wg-dns.pid 2>/dev/null || true)"
socks="$(ss -Hlnup 'sport = :53' 2>/dev/null | grep "pid=$dnspid," | awk '{print "udp " $4}'; ss -Hlntp 'sport = :53' 2>/dev/null | grep "pid=$dnspid," | awk '{print "tcp " $4}')"
echo "INFO forwarder (pid $dnspid) sockets: $(paste -sd' ' - <<<"$socks")"
check "its only sockets are $SERVER_WG_IP:53 (udp and tcp)" '[[ "$(sort -u <<<"$socks" | paste -sd" " -)" == "tcp $SERVER_WG_IP:53 udp $SERVER_WG_IP:53" ]]'

if [[ -z "$PROFILE" ]]; then
  "$REPO/lumenctl" wireguard remove-peer "$PUB" >/dev/null
  sleep 1
  check "access revoked after removing the peer" '[[ "$(code "$SERVER_WG_IP")" == 000 ]]'
  check "the tunnel DNS is unreachable for the revoked peer" '[[ "$(nsdnsq "$PDNS" "$OPS")" == noanswer ]]'
  check "peer removed from wg0.conf" "! grep -q '$PUB' /etc/wireguard/wg0.conf"
fi
echo "wireguard e2e: $PASS passed, $FAILS failed"
exit $FAILS
