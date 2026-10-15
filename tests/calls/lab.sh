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

cmd="${1:-status}"; shift || true
case "$cmd" in
  up) up ;;
  down) down ;;
  shape) ns="$1"; shift; ip netns exec "$ns" tc qdisc replace dev eth0 root netem "$@"; echo "$ns: netem $*" ;;
  unshape) ip netns exec "$1" tc qdisc del dev eth0 root 2>/dev/null || true; echo "$1: unshaped" ;;
  block-udp)
    ip netns exec "$1" iptables -C OUTPUT -p udp -j DROP 2>/dev/null || ip netns exec "$1" iptables -A OUTPUT -p udp -j DROP
    echo "$1: all outbound UDP dropped" ;;
  unblock-udp) ip netns exec "$1" iptables -D OUTPUT -p udp -j DROP 2>/dev/null || true; echo "$1: UDP allowed" ;;
  link) ip netns exec "$1" ip link set eth0 "$2"; echo "$1: eth0 $2" ;;
  status)
    ip -br addr show "$BR" 2>/dev/null || echo "bridge $BR absent"
    for ns in "${NSES[@]}"; do
      ip netns list | grep -qw "$ns" && echo "$ns: $(ip -n "$ns" -br addr show eth0 | awk '{print $3}') qdisc: $(ip netns exec "$ns" tc qdisc show dev eth0 | head -n1)"
    done ;;
  *) sed -n '2,16p' "$0"; exit 64 ;;
esac
