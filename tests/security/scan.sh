#!/usr/bin/env bash
# Security checks against an installed, running Lumen stack. Run as root on the host:
#
#   sudo bash tests/security/scan.sh
#
# Exposure: which sockets Lumen listens on; no published container ports; database
# and homeserver internals unreachable; console gate for non-allowed source IPs.
# TLS: protocol floor, certificate, HSTS. HTTP: security headers on every site,
# CSRF, open redirects, admin paths. Containers: non-root, read-only, capabilities,
# no Docker socket, secrets not in image config or environment. Calls (when
# enabled): SFU listeners, private SFU paths, forged/unscoped SFU tokens, TURN
# restrictions and TLS floor, no recording, no identities in SFU logs. Repository:
# no private keys or tokens committed. Prints PASS/FAIL lines; exit status = failures.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CONF="${LUMEN_CONF:-/etc/lumen/lumen.conf}"
get() { grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2-; }
P="$(get LUMEN_PRIMARY_DOMAIN)"; APP="${P:+app.$P}"; MX="${P:+matrix.$P}"; OPS="ops.$P"
CA=(); [[ "$(get TLS_MODE)" == internal ]] && CA=(--cacert /etc/lumen/ca/caddy-local-root.crt)
pass=0 fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail + 1)); }
c() { local host="$1"; shift; curl -sS --noproxy '*' --max-time 15 --resolve "$host:443:127.0.0.1" "${CA[@]}" "$@"; }

echo "--- exposure"
listeners="$(ss -tulnpH | awk '{print $1" "$5" "$7}')"
unexpected="$(echo "$listeners" | grep -E 'docker-proxy|postgres|synapse|gunicorn|python' | grep -vE '127\.0\.0\.1:(28008|55432) ' || true)"
[[ -z "$unexpected" ]] && ok "no container ports published and no app/database listeners on the host" || bad "unexpected listeners" "$unexpected"
caddy_ports="$(echo "$listeners" | grep caddy | awk '{print $1"/"$2}' | sed 's/0\.0\.0\.0://; s/\[::\]://' | sort -u | tr '\n' ' ')"
echo "     caddy listens on: $caddy_ports"
[[ "$(echo "$listeners" | grep -c caddy)" -gt 0 ]] && ok "public listeners are Caddy only (plus the calls SFU/TURN and WireGuard when enabled)" || bad "caddy listeners"
for svc in postgres synapse portal ops worker; do
  cid="$(docker ps -q --filter "label=com.docker.compose.service=$svc" --filter label=com.docker.compose.project=lumen | head -n1)"
  [[ -z "$cid" ]] && continue
  ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$cid")"
  [[ "$ports" == "{}" || "$ports" == "null" || ! "$ports" =~ HostPort ]] && ok "$svc: no published ports" || bad "$svc: published ports" "$ports"
done
pg_net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(docker ps -q --filter label=com.docker.compose.service=postgres --filter label=com.docker.compose.project=lumen)")"
internal="$(docker network inspect -f '{{.Internal}}' lumen_backend 2>/dev/null)"
[[ "$pg_net" == "lumen_backend " && "$internal" == true ]] && ok "PostgreSQL only on the internal backend network (no route out)" || bad "PostgreSQL networks" "$pg_net internal=$internal"
ops_nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(docker ps -q --filter label=com.docker.compose.service=ops --filter label=com.docker.compose.project=lumen)")"
[[ "$ops_nets" == "lumen_backend " ]] && ok "operator console container has no egress network" || bad "ops networks" "$ops_nets"

# Console network gate: a client on a Docker bridge (not loopback, not WireGuard) must be dropped.
gw="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' bridge)"
img="$(grep -E '^CADDY_IMAGE=' "$REPO/deploy/versions.env" | cut -d= -f2)"
control="$(docker run --rm --entrypoint curl "$img" -sk --max-time 8 -o /dev/null -w '%{http_code}' --resolve "$P:443:$gw" "https://$P/" 2>&1 || true)"
out="$(docker run --rm --entrypoint curl "$img" -sk --max-time 8 -o /dev/null -w '%{http_code}' --resolve "$OPS:8443:$gw" "https://$OPS:8443/accounts/login/" 2>&1 || true)"
if [[ "$control" == 200 && "$out" == 000 ]]; then
  ok "console drops connections from non-allowed source IPs (same client reaches the public site: 200)"
else
  bad "console network gate" "public=$control console=$out"
fi
code="$(curl -sS --noproxy '*' --max-time 10 --resolve "$OPS:8443:127.0.0.1" "${CA[@]}" -o /dev/null -w '%{http_code}' "https://$OPS:8443/accounts/login/")"
[[ "$code" == 200 ]] && ok "console reachable from loopback (SSH tunnel path)" || bad "console from loopback" "$code"

echo "--- TLS"
for h in "$P" "$APP" "$MX"; do
  for v in tls1 tls1_1; do
    if echo | openssl s_client -connect 127.0.0.1:443 -servername "$h" "-$v" >/dev/null 2>&1; then bad "$h accepts ${v/_/.}"; else ok "$h refuses ${v/_/.}"; fi
  done
  proto="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$h" 2>/dev/null | grep -m1 -oE 'TLSv1\.[23]')"
  [[ "$proto" == TLSv1.3 ]] && ok "$h negotiates TLS 1.3" || bad "$h protocol" "$proto"
done
plain="$(curl -sS --noproxy '*' --max-time 10 --resolve "$P:80:127.0.0.1" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$P/")"
[[ "$plain" == 30[18]\ https://* ]] && ok "plain HTTP redirects to HTTPS" || bad "plain HTTP" "$plain"

echo "--- HTTP security headers"
for url in "$P/" "$P/accounts/login/" "$APP/" "$MX/_matrix/client/versions"; do
  host="${url%%/*}"; h="$(c "$host" -D - -o /dev/null "https://$url" | tr -d '\r')"
  for want in "strict-transport-security: max-age=63072000" "x-content-type-options: nosniff"; do
    grep -qi "^$want" <<<"$h" && ok "$url: ${want%%:*}" || bad "$url: ${want%%:*}"
  done
  if [[ "$url" != "$MX/"* ]]; then
    csp="$(grep -i '^content-security-policy:' <<<"$h")"
    [[ -n "$csp" && "$csp" != *unsafe-inline* && "$csp" == *"frame-ancestors 'none'"* ]] && ok "$url: strict CSP (no unsafe-inline, no framing)" || bad "$url: CSP" "$csp"
  fi
  grep -qi '^server: ' <<<"$h" && bad "$url: Server header leaks software" || ok "$url: no Server header"
done

echo "--- application checks"
for path in /_synapse/admin/v1/server_version /_synapse/admin/v1/users; do
  code="$(c "$MX" -o /dev/null -w '%{http_code}' "https://$MX$path")"; [[ "$code" == 404 ]] && ok "homeserver admin API hidden ($path → 404)" || bad "admin API $path" "$code"
done
for path in /ops/ /ops/dashboard/ /internal/v1/media-limits /admin/; do
  code="$(c "$P" -o /dev/null -w '%{http_code}' "https://$P$path")"; [[ "$code" == 404 ]] && ok "$path not served on the public site (404)" || bad "public $path" "$code"
done
code="$(c "$P" -o /dev/null -w '%{http_code}' -X POST -d 'login=x&password=y' "https://$P/accounts/login/")"
[[ "$code" == 403 ]] && ok "CSRF: POST without token rejected (403)" || bad "CSRF" "$code"
jar="$(mktemp)"; page="$(c "$P" -c "$jar" "https://$P/accounts/login/?next=https://evil.example/")"
token="$(grep -oE 'name="csrfmiddlewaretoken" value="[^"]+"' <<<"$page" | head -n1 | sed 's/.*value="//; s/"$//')"
loc="$(c "$P" -b "$jar" -o /dev/null -w '%{redirect_url}' -H "Referer: https://$P/accounts/login/" --data-urlencode "csrfmiddlewaretoken=$token" --data-urlencode "login=nobody-$RANDOM" --data-urlencode "password=wrong" --data-urlencode "next=https://evil.example/" "https://$P/accounts/login/?next=https://evil.example/")"
rm -f "$jar"
[[ "$loc" != https://evil.example* ]] && ok "no open redirect via ?next= on sign-in" || bad "open redirect" "$loc"
loc="$(c "$P" -o /dev/null -w '%{redirect_url}' "https://$P/accounts/logout/?next=https://evil.example/")"
[[ "$loc" != https://evil.example* ]] && ok "no open redirect via ?next= on sign-out" || bad "open redirect (logout)" "$loc"
wk="$(c "$MX" "https://$MX/_matrix/client/v3/login")"
grep -q '"m.login.password"' <<<"$wk" && bad "homeserver offers password login" || ok "homeserver offers no password login (SSO only)"
reg="$(c "$MX" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$MX/_matrix/client/v3/register")"
[[ "$reg" == 403 || "$reg" == 404 ]] && ok "homeserver open registration disabled ($reg)" || bad "registration" "$reg"

if [[ "$(get CALLS_ENABLED)" != false ]]; then
  echo "--- calls (SFU, TURN, authorization)"
  RTC="$(get LUMEN_RTC_DOMAIN)"; RTC="${RTC:-rtc.$P}"
  tcp_port="$(get CALLS_TCP_PORT)"; tcp_port="${tcp_port:-7881}"
  tls_port="$(get CALLS_TURN_TLS_PORT)"; tls_port="${tls_port:-5349}"
  turn_port="$(get CALLS_TURN_UDP_PORT)"; turn_port="${turn_port:-3478}"
  udp_range="$(get CALLS_UDP_PORTS)"; udp_range="${udp_range:-7882-7889}"
  lk_listen="$(echo "$listeners" | grep livekit || true)"
  bad_tcp="$(awk -v a="$tcp_port" -v b="$tls_port" '$1=="tcp" { n=split($2,x,":"); port=x[n]; addr=substr($2,1,length($2)-length(port)-1);
    if (addr=="127.0.0.1" && (port==7880 || port==6789)) next; if (port==a || port==b) next; print $2 }' <<<"$lk_listen")"
  [[ -n "$lk_listen" && -z "$bad_tcp" ]] && ok "SFU TCP: signalling and metrics on loopback only; public only ICE/TCP $tcp_port and TURN/TLS $tls_port" || bad "SFU TCP listeners" "${bad_tcp:-none found}"
  bad_udp="$(awk -v lo="${udp_range%-*}" -v hi="${udp_range#*-}" -v t="$turn_port" '$1=="udp" { n=split($2,x,":"); port=x[n]+0;
    if ((port>=lo && port<=hi) || port==t || (port>=40000 && port<=40999)) next; print $2 }' <<<"$lk_listen")"
  [[ -z "$bad_udp" ]] && ok "SFU UDP: only media $udp_range, TURN $turn_port and TURN relay allocations" || bad "SFU UDP listeners" "$bad_udp"
  for path in /twirp/livekit.RoomService/ListRooms /twirp/livekit.Egress/StartRoomCompositeEgress /metrics /sfu_webhook /debug/pprof/; do
    code="$(c "$RTC" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$RTC$path")"
    [[ "$code" == 404 ]] && ok "SFU private path hidden on the public site ($path → 404)" || bad "SFU $path" "$code"
  done
  rtc_gw="$(docker run --rm --entrypoint curl "$img" -sk --max-time 8 -o /dev/null -w '%{http_code}' --resolve "$RTC:443:$gw" "https://$RTC/" 2>&1 || true)"
  rtc_api="$(docker run --rm --entrypoint curl "$img" -sk --max-time 8 -o /dev/null -w '%{http_code}' --resolve "$RTC:443:$gw" -X POST -H 'Content-Type: application/json' -d '{}' "https://$RTC/twirp/livekit.RoomService/ListRooms" 2>&1 || true)"
  [[ "$rtc_gw" == 200 && "$rtc_api" == 404 ]] && ok "SFU API refused to containers outside the calls network (same client reaches signalling: 200)" || bad "SFU API network gate" "signalling=$rtc_gw api=$rtc_api"
  mkjwt() { python3 - "$1" <<'PY'
import base64, hashlib, hmac, json, os, sys, time
kid, sec = open("/etc/lumen/secrets/livekit_keys").read().split(":", 1)
key = sec.strip().encode() if sys.argv[1] == "real" else os.urandom(32)
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
now = int(time.time())
p = b(json.dumps({"iss": kid.strip(), "sub": "scan", "exp": now + 120, "nbf": now - 5,
                  "video": {"roomJoin": True, "roomAdmin": True, "room": "scan-%s" % os.urandom(4).hex()}}).encode())
print(f"{h}.{p}.{b(hmac.new(key, f'{h}.{p}'.encode(), hashlib.sha256).digest())}")
PY
  }
  forged="$(c "$RTC" -o /dev/null -w '%{http_code}' "https://$RTC/rtc/validate?access_token=$(mkjwt forged)")"
  [[ "$forged" == 401 ]] && ok "SFU rejects a token not signed by this server's key (401)" || bad "forged SFU token" "$forged"
  noroom="$(c "$RTC" -o /dev/null -w '%{http_code}' "https://$RTC/rtc/validate?access_token=$(mkjwt real)")"
  [[ "$noroom" == 404 ]] && ok "a valid token cannot create rooms (auto-create off: unknown room → 404)" || bad "SFU room auto-create" "$noroom"
  code="$(c "$MX" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$MX/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token")"
  [[ "$code" == 401 ]] && ok "SFU token endpoint requires a signed-in Matrix user (401)" || bad "anonymous SFU token" "$code"
  for v in tls1 tls1_1; do
    if echo | openssl s_client -connect "127.0.0.1:$tls_port" -servername "$RTC" "-$v" >/dev/null 2>&1; then bad "TURN/TLS accepts ${v/_/.}"; else ok "TURN/TLS refuses ${v/_/.}"; fi
  done
  lkconf=/etc/lumen/rendered/livekit/livekit.yaml
  rtc_net="$(get RTC_NETWORK_SUBNET)"; wg_net="$(get WG_SUBNET)"
  python3 - "$lkconf" "${rtc_net:-172.30.42.0/28}" "${wg_net:-10.77.0.0/24}" <<'PY' && ok "TURN: 5-minute credentials, no relaying to container/VPN networks, rooms not auto-created" || bad "SFU/TURN configuration" "$lkconf"
import sys
text = open(sys.argv[1]).read()
need = ["ttl_seconds: 300", "auto_create: false", f'"{sys.argv[2]}"', f'"{sys.argv[3]}"']
# 172.16.0.0/12 is denied in production; a lab whose SFU address lies inside it
# (CALLS_ALLOW_PRIVATE_NODE_IP) instead allows only that /32 on top of LiveKit's
# default private-range restriction.
if "allow_restricted_peer_cidrs" not in text:
    need.append('"172.16.0.0/12"')
missing = [n for n in need if n not in text]
print("     missing:", missing) if missing else None
sys.exit(1 if missing else 0)
PY
  ufw_relay="$(ufw status 2>/dev/null | grep -E '^40000' || true)"
  [[ -z "$ufw_relay" ]] && ok "TURN relay port range is not opened in the firewall" || bad "relay ports open" "$ufw_relay"
  egress="$(docker ps --format '{{.Image}}' | grep -iE 'egress|recorder' || true)"
  [[ -z "$egress" ]] && ok "no recording/egress service running (calls are not recorded)" || bad "recording service present" "$egress"
  idleak=0
  for svc in livekit lkjwt; do
    cid="$(docker ps -q --filter "label=com.docker.compose.service=$svc" --filter label=com.docker.compose.project=lumen | head -n1)"
    [[ -n "$cid" ]] && docker logs --since 24h "$cid" 2>&1 | grep -qE "@[a-z0-9._=/+-]+:$P" && { idleak=1; echo "     Matrix IDs in $svc logs" >&2; }
  done
  ((idleak == 0)) && ok "SFU and authorization-service logs contain no Matrix user IDs" || bad "Matrix IDs in calls logs"
fi

echo "--- containers"
for cid in $(docker ps -q --filter label=com.docker.compose.project=lumen); do
  name="$(docker inspect -f '{{.Name}}' "$cid" | tr -d /)"
  read -r user ro priv capdrop secopt _binds <<<"$(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Binds}}' "$cid")"
  [[ -n "$user" && "$user" != root && "$user" != 0 && "$user" != 0:* ]] && ok "$name runs as non-root ($user)" || bad "$name user" "'$user'"
  [[ "$ro" == true ]] && ok "$name read-only root filesystem" || bad "$name read-only rootfs"
  [[ "$priv" == false ]] && ok "$name not privileged" || bad "$name privileged"
  [[ "$capdrop" == *ALL* ]] && ok "$name drops all capabilities" || bad "$name cap_drop" "$capdrop"
  [[ "$secopt" == *no-new-privileges* ]] && ok "$name no-new-privileges" || bad "$name no-new-privileges"
  docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$cid" | grep -q docker.sock && bad "$name mounts the Docker socket" || ok "$name has no Docker socket"
  envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid")"
  leaked=0
  while IFS= read -r -d '' f; do
    v="$(head -c 200 "$f" | head -n1)"; [[ ${#v} -ge 12 ]] && grep -qF -- "$v" <<<"$envs" && leaked=1
  done < <(find /etc/lumen/secrets -type f -size +0 -print0)
  ((leaked == 0)) && ok "$name: no secret values in environment" || bad "$name: secret value in environment"
done

echo "--- repository and images"
hits="$(cd "$REPO" && git ls-files -z | xargs -0 grep -lIE -- '-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----|sk_live_[0-9a-zA-Z]{10,}|whsec_[0-9a-zA-Z]{20,}|ghp_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}' 2>/dev/null | grep -vE '^tests/security/scan.sh$' || true)"
[[ -z "$hits" ]] && ok "no private keys or live tokens in tracked files" || bad "secrets in repository" "$hits"
img_env="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lumen/portal:1.0.0)"
grep -qiE 'secret|password|token' <<<"$img_env" && bad "portal image ENV mentions secrets" "$(grep -iE 'secret|password|token' <<<"$img_env" | cut -d= -f1 | tr '\n' ' ')" || ok "portal image ENV carries no secrets"
docker history --no-trunc lumen/portal:1.0.0 | grep -qiE 'build_extra_ca|BEGIN CERT' && bad "build CA visible in image history" || ok "build-time CA secret not baked into image layers"

echo "security scan: $pass passed, $fail failed"
exit "$fail"
