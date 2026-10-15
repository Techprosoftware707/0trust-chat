#!/usr/bin/env bash
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
  echo | openssl s_client -connect "127.0.0.1:$2" -servername "$1" -verify_return_error \
      $( [[ "$(conf_get TLS_MODE acme)" == internal ]] && echo "-CAfile $LUMEN_CONFIG_DIR/ca/caddy-local-root.crt" ) 2>/dev/null \
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
  vcheck "security: PostgreSQL is not listening on a public address" _no_public_listener 5432
  vcheck "security: Synapse is not listening on a public address" _no_public_listener 8008
}
