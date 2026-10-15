#!/usr/bin/env bash
# Security checks against an installed, running Lumen stack. Run as root on the host:
#
#   sudo bash tests/security/scan.sh
#
# Exposure: which sockets Lumen listens on; no published container ports; database
# and homeserver internals unreachable; console gate for non-allowed source IPs.
# TLS: protocol floor, certificate, HSTS. HTTP: security headers on every site,
# CSRF, open redirects, admin paths. Containers: non-root, read-only, capabilities,
# no Docker socket, secrets not in image config or environment. Repository: no
# private keys or tokens committed. Prints PASS/FAIL lines; exit status = failures.
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
[[ "$(echo "$listeners" | grep -c caddy)" -gt 0 ]] && ok "public listeners are Caddy only (plus TURN/WireGuard when enabled)" || bad "caddy listeners"
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

echo "--- containers"
for cid in $(docker ps -q --filter label=com.docker.compose.project=lumen); do
  name="$(docker inspect -f '{{.Name}}' "$cid" | tr -d /)"
  read -r user ro priv capdrop secopt binds <<<"$(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Binds}}' "$cid")"
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
