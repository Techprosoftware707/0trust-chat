#!/usr/bin/env bash
# Call-test lab: separate network environments for real WebRTC calls on one host.
#
#   sudo bash tests/calls/lab.sh up        create bridge lumenlab (10.200.0.1/24) and
#                                         namespaces lab-a, lab-b, lab-c (10.200.0.11-13)
#   sudo bash tests/calls/lab.sh down      remove them
#   sudo bash tests/calls/lab.sh shape <ns> [netem args...]   e.g. shape lab-b rate 400kbit delay 40ms loss 5%
#   sudo bash tests/calls/lab.sh unshape <ns>
#   sudo bash tests/calls/lab.sh block-udp <ns> | unblock-udp <ns>   force TURN/TLS or ICE/TCP
#   sudo bash tests/calls/lab.sh link <ns> down|up                    simulate a network outage
#   sudo bash tests/calls/lab.sh block-port <ns> udp|tcp <port[:port]> drop outbound traffic to
#                                         those ports (e.g. udp 7882:7889 + tcp 7881 = no direct
#                                         media path, only TURN is left)
#   sudo bash tests/calls/lab.sh block-udp-except <ns> <port[,port]> drop all outbound UDP except
#                                         to those ports (3478 = only TURN/UDP is left)
#   sudo bash tests/calls/lab.sh unblock-all <ns>                    remove every block in <ns>
#   sudo bash tests/calls/lab.sh status
#
# Each namespace has its own interface, routing table, firewall and traffic shaping,
# so a browser started inside it (`ip netns exec lab-b chromium ...`) is a separate
# client on a separate network path. The Lumen server is reached at 10.200.0.1, which
# LiveKit advertises when CALLS_PUBLIC_IP=10.200.0.1 (test labs only).
set -euo pipefail
BR=lumenlab
NET=10.200.0
NSES=(lab-a lab-b lab-c)

up() {
  ip link show "$BR" >/dev/null 2>&1 || {
    ip link add "$BR" type bridge
    ip addr add "$NET.1/24" dev "$BR"
    ip link set "$BR" up
  }
  local i=11 ns
  for ns in "${NSES[@]}"; do
    # A host restart leaves the /run/netns entries behind without their namespaces
    # ("Invalid argument" on entry): remove such stale names so they are recreated.
    if ip netns list | grep -qw "$ns" && ! ip netns exec "$ns" true 2>/dev/null; then
      ip netns del "$ns" 2>/dev/null || rm -f "/run/netns/$ns"
    fi
    if ! ip netns list | grep -qw "$ns"; then
      ip netns add "$ns"
      ip link add "v-$ns" type veth peer name eth0 netns "$ns"
      ip link set "v-$ns" master "$BR" up
      ip -n "$ns" addr add "$NET.$i/24" dev eth0
      ip -n "$ns" link set eth0 up
      ip -n "$ns" link set lo up
      ip -n "$ns" route add default via "$NET.1"
    fi
    i=$((i + 1))
  done
  # Clients in the lab may reach the host, nothing beyond it.
  iptables -C FORWARD -i "$BR" -j DROP 2>/dev/null || iptables -I FORWARD -i "$BR" -j DROP
  echo "lab up: bridge $BR $NET.1/24, namespaces ${NSES[*]}"
}

down() {
  local ns
  for ns in "${NSES[@]}"; do ip netns del "$ns" 2>/dev/null || true; done
  ip link del "$BR" 2>/dev/null || true
  iptables -D FORWARD -i "$BR" -j DROP 2>/dev/null || true
  echo "lab down"
}

ns_ip() { ip -n "$1" -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1; }

# Removes the random-loss rules added by the netem-less `shape` fallback.
clear_loss() {
  local rules rule
  rules="$(iptables -S INPUT | grep -- "--comment lab-loss-$1" || true)"
  while read -r rule; do
    [[ -n "$rule" ]] && eval "iptables ${rule/-A /-D }"
  done <<<"$rules"
  return 0
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  up) up ;;
  down) down ;;
  shape)
    ns="$1"; shift
    if ip netns exec "$ns" tc qdisc replace dev eth0 root netem "$@" 2>/dev/null; then
      echo "$ns: netem $*"
    else
      # Kernels without sch_netem (e.g. some VMs): rate limit with tbf, random loss with
      # iptables' statistic match. Delay/jitter need netem and are skipped (reported).
      rate="" loss="" ignored=""
      while (($#)); do
        case "$1" in
          rate) rate="$2"; shift 2 ;;
          loss) loss="${2%\%}"; shift 2 ;;
          *) ignored="$ignored $1"; shift ;;
        esac
      done
      ip netns exec "$ns" tc qdisc del dev eth0 root 2>/dev/null || true
      clear_loss "$ns"
      [[ -n "$rate" ]] && ip netns exec "$ns" tc qdisc replace dev eth0 root tbf rate "$rate" burst 16kb latency 300ms
      if [[ -n "$loss" ]]; then
        # Dropped where the client's packets arrive (host INPUT), not in the client's own OUTPUT
        # chain: a local drop returns EPERM to the sender, which then just retries.
        p="$(awk -v l="$loss" 'BEGIN { printf "%.4f", l / 100 }')"
        iptables -I INPUT -s "$(ns_ip "$ns")" -m statistic --mode random --probability "$p" -m comment --comment "lab-loss-$ns" -j DROP
      fi
      echo "$ns: no netem in this kernel; tbf rate=${rate:-none}, iptables random loss=${loss:-0}%${ignored:+ (ignored:$ignored)}"
    fi ;;
  unshape)
    ip netns exec "$1" tc qdisc del dev eth0 root 2>/dev/null || true
    clear_loss "$1"
    echo "$1: unshaped" ;;
  block-udp)
    ip netns exec "$1" iptables -C OUTPUT -p udp -j DROP 2>/dev/null || ip netns exec "$1" iptables -A OUTPUT -p udp -j DROP
    echo "$1: all outbound UDP dropped" ;;
  unblock-udp) ip netns exec "$1" iptables -D OUTPUT -p udp -j DROP 2>/dev/null || true; echo "$1: UDP allowed" ;;
  link)
    ip netns exec "$1" ip link set eth0 "$2"
    # bringing the link back restores the connected route only; restore the default route too
    if [[ "$2" == up ]]; then ip -n "$1" route replace default via "$NET.1" 2>/dev/null || true; fi
    echo "$1: eth0 $2" ;;
  block-port)
    ns="$1" proto="$2" ports="$3"
    # any destination: the SFU also answers from its other host addresses (peer-reflexive)
    ip netns exec "$ns" iptables -C OUTPUT -p "$proto" --dport "$ports" -j DROP 2>/dev/null \
      || ip netns exec "$ns" iptables -A OUTPUT -p "$proto" --dport "$ports" -j DROP
    echo "$ns: outbound $proto to port $ports dropped" ;;
  block-udp-except)
    # every outbound UDP packet except to the given port(s) (e.g. 3478 = TURN/UDP only). Port
    # blocks alone aren't enough: an SFU that also sends from other host addresses can appear
    # behind the host's NAT on random ports (peer-reflexive candidates).
    ns="$1" ports="$2"
    ip netns exec "$ns" iptables -C OUTPUT -p udp -m multiport ! --dports "$ports" -j DROP 2>/dev/null \
      || ip netns exec "$ns" iptables -A OUTPUT -p udp -m multiport ! --dports "$ports" -j DROP
    echo "$ns: outbound udp dropped except to port(s) $ports" ;;
  unblock-all) ip netns exec "$1" iptables -F OUTPUT; echo "$1: all blocks removed" ;;
  status)
    ip -br addr show "$BR" 2>/dev/null || echo "bridge $BR absent"
    for ns in "${NSES[@]}"; do
      ip netns list | grep -qw "$ns" && echo "$ns: $(ip -n "$ns" -br addr show eth0 | awk '{print $3}') qdisc: $(ip netns exec "$ns" tc qdisc show dev eth0 | head -n1)"
    done ;;
  *) sed -n '2,22p' "$0"; exit 64 ;;
esac
