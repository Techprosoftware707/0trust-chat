#!/usr/bin/env bash
# shellcheck disable=SC2154,SC1090  # _log_file/colours come from common.sh; env files are generated
# Public-endpoint verification shared by install.sh, update.sh and healthcheck.sh.
# Requests go to this host (--resolve 127.0.0.1) but TLS is verified against the
# real hostname, so a pass means the certificate and routing are correct.

VERIFY_FAILURES=()
VERIFY_RESULTS=()

_vcurl() {
  local host="$1" port="$2"; shift 2
  local ca_args=()
  if [[ "$(conf_get TLS_MODE acme)" == internal && -s "$LUMEN_CONFIG_DIR/ca/caddy-local-root.crt" ]]; then
    ca_args=(--cacert "$LUMEN_CONFIG_DIR/ca/caddy-local-root.crt")
  fi
  curl -sS --noproxy '*' --max-time 15 --resolve "$host:$port:127.0.0.1" "${ca_args[@]}" "$@"
}

# _rtc_api HOST METHOD PATH [JSON] -> prints "<http code> <body>" for a homeserver
# request authenticated as the console's service account (root-only token file).
_rtc_api() {
  local tok; tok="$(cat "$LUMEN_SECRETS_DIR/synapse_admin_token" 2>/dev/null)"; [[ -n "$tok" ]] || return 1
  _vcurl "$1" 443 -X "$2" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    ${4:+-d "$4"} -w ' %{http_code}' "https://$1$3"
}
_calls_transport_ok() { # mx rtc
  local out; out="$(_rtc_api "$1" GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports)" || return 1
  [[ "$out" == *"\"url\":\"wss://$2\""* && "$out" == *" 200" ]]
}
_calls_membership_enforced() { # mx rtc server-name: token for a room we are not in -> 403
  local out body
  body="{\"url\":\"wss://$2\",\"server_name\":\"$3\",\"room_id\":\"!lumen-readiness-check:$3\",\"slot_id\":\"m.call#ROOM\",\"member_id\":\"readiness\"}"
  out="$(_rtc_api "$1" POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token "$body")" || return 1
  [[ "$out" == *M_FORBIDDEN*" 403" ]]
}
_calls_anonymous_refused() { # mx
  local code
  code="$(_vcurl "$1" 443 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
    "https://$1/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token")" || return 1
  [[ "$code" == 401 ]]
}
_listening() { # proto port
  local flag="-ltn"; [[ "$1" == udp ]] && flag="-lun"
  ss -H "$flag" "sport = :$2" 2>/dev/null | grep -q .
}

# _stun_ok PORT — a STUN Binding Request to the local TURN relay gets a matching response.
_stun_ok() {
  python3 - "$1" <<'PY'
import os, socket, struct, sys
txid = os.urandom(12)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(3)
    s.sendto(struct.pack("!HHI12s", 0x0001, 0, 0x2112A442, txid), ("127.0.0.1", int(sys.argv[1])))
    data, _ = s.recvfrom(2048)
sys.exit(0 if len(data) >= 20 and data[:2] == b"\x01\x01" and data[8:20] == txid else 1)
PY
}

vcheck() {
  # vcheck "description" command... — records pass/fail
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    VERIFY_RESULTS+=("ok|$desc"); ok "$desc"
  else
    VERIFY_RESULTS+=("fail|$desc"); VERIFY_FAILURES+=("$desc"); fail "$desc"
  fi
}

_expect_status() { # host port path status
  local code
  code="$(_vcurl "$1" "$2" -o /dev/null -w '%{http_code}' "https://$1:$2$3")" || return 1
  [[ "$code" == "$4" ]]
}

_expect_json() { # host port path python-expression-on-d
  local body
  body="$(_vcurl "$1" "$2" -f "https://$1:$2$3")" || return 1
  printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($4) else 1)"
}

_server_keys_valid() {
  local mx="$1" name="$2" body
  body="$(_vcurl "$mx" 443 -f "https://$mx/_matrix/key/v2/server")" || return 1
  printf '%s' "$body" | python3 "$LUMEN_REPO_DIR/deploy/lib/verify_keys.py" "$name"
}

_cert_days() { # host port -> days until expiry
  local host="$1" port="$2" end
  end="$(echo | openssl s_client -connect "127.0.0.1:$port" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [[ -n "$end" ]] || return 1
  echo $((($(date -d "$end" +%s) - $(date +%s)) / 86400))
}

_tls_ok() {
  # ACME certificates renew ~30 days before expiry, so <7 days left means renewal
  # is failing. Caddy's internal test CA issues 12-hour certificates.
  local min=$((7 * 86400))
  [[ "$(conf_get TLS_MODE acme)" == internal ]] && min=600
  local ca_args=()
  [[ "$(conf_get TLS_MODE acme)" == internal ]] && ca_args=(-CAfile "$LUMEN_CONFIG_DIR/ca/caddy-local-root.crt")
  echo | openssl s_client -connect "127.0.0.1:$2" -servername "$1" -verify_return_error "${ca_args[@]}" 2>/dev/null \
    | openssl x509 -noout -checkend "$min" >/dev/null 2>&1
}

_no_public_listener() { # port -> passes if nothing listens on a non-loopback address
  ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "(^|[^0-9])$1$" | grep -vqE '^(127\.|\[::1\]|::1)'
}

verify_endpoints() {
  VERIFY_FAILURES=(); VERIFY_RESULTS=()
  local p app mx ops ops_port sn
  p="$(conf_get LUMEN_PRIMARY_DOMAIN)"; app="$(conf_get LUMEN_APP_DOMAIN "app.$p")"
  mx="$(conf_get LUMEN_MATRIX_DOMAIN "matrix.$p")"; ops="$(conf_get LUMEN_OPS_DOMAIN "ops.$p")"
  ops_port="$(conf_get LUMEN_OPS_PORT 8443)"; sn="$(conf_get MATRIX_SERVER_NAME "$p")"
  vcheck "website: https://$p/healthz reports database OK" _expect_json "$p" 443 /healthz "d.get('db') is True"
  vcheck "TLS certificate valid and trusted for $p" _tls_ok "$p" 443
  vcheck "TLS certificate valid for $app" _tls_ok "$app" 443
  vcheck "TLS certificate valid for $mx" _tls_ok "$mx" 443
  vcheck "Matrix discovery: /.well-known/matrix/server → $mx:443" _expect_json "$sn" 443 /.well-known/matrix/server "d.get('m.server') == '$mx:443'"
  vcheck "Matrix discovery: /.well-known/matrix/client → https://$mx" _expect_json "$sn" 443 /.well-known/matrix/client "d['m.homeserver']['base_url'] == 'https://$mx'"
  vcheck "chat app: https://$app/ serves the web client" _expect_status "$app" 443 / 200
  vcheck "chat app: config.json points at this homeserver" _expect_json "$app" 443 /config.json "d['homeserver']['base_url'] == 'https://$mx'"
  vcheck "homeserver: client API responds" _expect_json "$mx" 443 /_matrix/client/versions "'v1.1' in d.get('versions', [])"
  vcheck "homeserver: single sign-on through the portal is offered" _expect_json "$mx" 443 /_matrix/client/v3/login "any(f.get('type') == 'm.login.sso' for f in d.get('flows', []))"
  vcheck "portal: OIDC discovery document" _expect_json "$p" 443 /.well-known/openid-configuration "d.get('issuer') == 'https://$p'"
  if [[ "$(conf_get FEDERATION_MODE open)" != closed ]]; then
    vcheck "federation: /_matrix/federation/v1/version" _expect_json "$mx" 443 /_matrix/federation/v1/version "'server' in d"
    vcheck "federation: signing keys are self-signed by $sn" _server_keys_valid "$mx" "$sn"
  fi
  vcheck "security: homeserver admin API is not public" _expect_status "$mx" 443 /_synapse/admin/v1/server_version 404
  vcheck "security: operator console paths are not public" _expect_status "$p" 443 /ops/ 404
  vcheck "security: internal API is not public" _expect_status "$p" 443 /internal/v1/healthz 404
  vcheck "operator console reachable on the private port ($ops:$ops_port via loopback)" _expect_status "$ops" "$ops_port" /accounts/login/ 200
  if calls_enabled; then
    local rtc udp; rtc="$(rtc_domain)"; udp="$(conf_get CALLS_UDP_PORTS 7882-7889)"
    vcheck "calls: TLS certificate valid for $rtc" _tls_ok "$rtc" 443
    vcheck "calls: SFU signalling answers on https://$rtc/" _expect_status "$rtc" 443 / 200
    vcheck "calls: homeserver advertises the SFU (MatrixRTC transports)" _calls_transport_ok "$mx" "$rtc"
    vcheck "calls: SFU tokens require sign-in (anonymous request refused)" _calls_anonymous_refused "$mx"
    vcheck "calls: SFU tokens only for room members (authorization service via homeserver)" _calls_membership_enforced "$mx" "$rtc" "$sn"
    vcheck "security: SFU admin API is not public" _expect_status "$rtc" 443 /twirp/livekit.RoomService/ListRooms 404
    vcheck "calls: WebRTC media listening on udp/${udp%-*}" _listening udp "${udp%-*}"
    vcheck "calls: ICE/TCP listening on tcp/$(conf_get CALLS_TCP_PORT 7881)" _listening tcp "$(conf_get CALLS_TCP_PORT 7881)"
    vcheck "calls: TURN answers STUN on udp/$(conf_get CALLS_TURN_UDP_PORT 3478)" _stun_ok "$(conf_get CALLS_TURN_UDP_PORT 3478)"
    if [[ "${LUMEN_VERIFY_MEDIA:-0}" == 1 ]]; then
      vcheck "calls: SFU forwarded real audio+video to test subscribers (self-test from this host)" calls_selftest 8
    fi
    if [[ -s "$(conf_get LUMEN_DATA_DIR /var/lib/lumen)/livekit/tls/tls.crt" ]]; then
      vcheck "calls: TURN/TLS certificate valid on tcp/$(conf_get CALLS_TURN_TLS_PORT 5349)" _tls_ok "$rtc" "$(conf_get CALLS_TURN_TLS_PORT 5349)"
    fi
  fi
  vcheck "security: PostgreSQL is not listening on a public address" _no_public_listener 5432
  vcheck "security: Synapse is not listening on a public address" _no_public_listener 8008
}
