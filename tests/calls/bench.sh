#!/usr/bin/env bash
# SFU capacity benchmark on an installed Lumen server (run as root on the host).
#
#   sudo bash tests/calls/bench.sh [duration-seconds] > docs/test-results/calls-sfu-benchmark.txt
#
# For each scenario, LiveKit's load tester (livekit-cli, pinned in versions.env)
# connects real WebRTC participants from the internal rtc network: publishers send
# simulcast video (and/or Opus audio) through the SFU, subscribers receive every
# published track. We record what the SFU itself used (CPU and memory of the livekit
# container via `docker stats`, forwarded bytes via LiveKit's counters) and what the
# subscribers received (tracks, bitrate, packet loss as reported by the tester).
#
# Caveats (printed with the results): the load tester runs on the same host and
# competes for CPU; it does not run browser-side E2EE (encryption is done by the
# clients, so the SFU forwards the same number of bytes either way); LAN-speed
# links without loss; one LiveKit node.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DUR="${1:-30}"
# shellcheck disable=SC1091
set -a; source /etc/lumen/rendered/compose.env; source "$REPO/deploy/versions.env"; set +a
RTC="$LUMEN_RTC_DOMAIN"
envf="$(mktemp)"; chmod 600 "$envf"; trap 'rm -f "$envf"' EXIT
printf 'LIVEKIT_URL=https://%s\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$RTC" \
  "$(cut -d: -f1 /etc/lumen/secrets/livekit_keys)" "$(cut -d: -f2 /etc/lumen/secrets/livekit_keys | tr -d ' \n')" >"$envf"
ca=/etc/ssl/certs/ca-certificates.crt; [[ "$CA_BUNDLE_HOST_PATH" != /dev/null ]] && ca="$CA_BUNDLE_HOST_PATH"
lk() { docker run --rm --network "${COMPOSE_PROJECT_NAME}_rtc" --env-file "$envf" --add-host "$RTC:$RTC_GATEWAY_IP" \
  -v "$ca:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt "$LIVEKIT_CLI_IMAGE" "$@"; }
metric() { curl -s http://127.0.0.1:6789/metrics | awk -v m="$1" -v d="$2" '$1 ~ "^"m && $0 ~ d {s+=$2} END {printf "%.0f", s}'; }

echo "Lumen SFU benchmark — $(date -u +%FT%TZ)"
echo "Host: $(nproc) vCPU, $(free -g | awk '/Mem/{print $2}') GB RAM, $(uname -r); LiveKit $(docker inspect -f '{{.Config.Image}}' lumen-livekit-1 | sed 's/@.*//')"
echo "Duration per scenario: ${DUR}s"
echo

run_scenario() { # name, load-test args...
  local name="$1"; shift
  local room statsf; room="bench-$(openssl rand -hex 3)"; statsf="$(mktemp)"
  lk room create "$room" >/dev/null 2>&1 || { echo "!! $name: could not create room"; return; }
  local in0 out0; in0="$(metric livekit_packet_bytes incoming)"; out0="$(metric livekit_packet_bytes outgoing)"
  ( for _ in $(seq 1 $((DUR + 20))); do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' lumen-livekit-1; sleep 1; done ) >"$statsf" 2>/dev/null &
  local sp=$!
  local t0 out; t0=$(date +%s)
  out="$(timeout $((DUR + 120)) docker run --rm --network "${COMPOSE_PROJECT_NAME}_rtc" --env-file "$envf" --add-host "$RTC:$RTC_GATEWAY_IP" \
    -v "$ca:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt "$LIVEKIT_CLI_IMAGE" load-test --url "wss://$RTC" --room "$room" \
    --duration "${DUR}s" "$@" 2>&1)"
  local t1; t1=$(date +%s)
  kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
  local in1 out1; in1="$(metric livekit_packet_bytes incoming)"; out1="$(metric livekit_packet_bytes outgoing)"
  lk room delete "$room" >/dev/null 2>&1
  local secs=$((t1 - t0))
  echo "=== $name  (load-test $*)"
  printf '%s\n' "$out" | grep -E '^│ Total|^│ Tester|^┌|^└|^├' | tail -n 5
  awk '{gsub("%","",$1); c+=$1; if ($1>m) m=$1; n++} END {if (n) printf "SFU CPU: avg %.0f%%  peak %.0f%% (100%% = one vCPU) over %d samples\n", c/n, m, n}' "$statsf"
  awk '{print $2}' "$statsf" | sort -h | tail -n1 | sed 's/^/SFU memory peak: /'
  awk -v a="$in0" -v b="$in1" -v c="$out0" -v d="$out1" -v s="$secs" 'BEGIN {printf "SFU forwarded: in %.1f Mbit/s, out %.1f Mbit/s (averaged over %ds incl. ramp-up)\n", (b-a)*8/s/1e6, (d-c)*8/s/1e6, s}'
  echo
  rm -f "$statsf"
}

run_scenario "1:1 voice (2 participants, audio only)" --audio-publishers 2 --subscribers 2
run_scenario "1:1 video call (2 x 720p simulcast + audio)" --video-publishers 2 --audio-publishers 2 --subscribers 2 --video-resolution high
run_scenario "4-person video meeting (720p simulcast)" --video-publishers 4 --audio-publishers 4 --subscribers 4 --video-resolution high
run_scenario "8-person video meeting (720p simulcast)" --video-publishers 8 --audio-publishers 8 --subscribers 8 --video-resolution high
run_scenario "12-person video meeting (720p simulcast)" --video-publishers 12 --audio-publishers 12 --subscribers 12 --video-resolution high
run_scenario "25-person audio call" --audio-publishers 25 --subscribers 25
run_scenario "webinar: 2 speakers on video, 40 listeners" --video-publishers 2 --audio-publishers 2 --subscribers 40 --video-resolution high

cat <<'EOF'
Caveats: load-test participants run on the same host (they compete with the SFU for
CPU and memory); browser-side E2EE is not exercised (it does not change the SFU's
forwarding work); links are LAN-speed without loss; a single LiveKit node. Numbers are
what this host did in this run, not a guaranteed capacity — size real deployments by
outbound bandwidth first: each subscriber receives roughly one high layer per visible
video tile (~1.2-2.5 Mbit/s at 720p) plus ~30-50 kbit/s per speaking audio track.
EOF
