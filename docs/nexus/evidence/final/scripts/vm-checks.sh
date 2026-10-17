#!/usr/bin/env bash
# Post-install Nexus checks, run INSIDE the test server after install.sh (TLS verified against the
# installer's internal test CA; never -k). The API token is never printed.
set -uo pipefail
cd /opt/lumen || exit 1
CA=/etc/lumen/ca/caddy-local-root.crt
D=https://lumen-it.test
P=0; F=0
ok() { echo "PASS $*"; P=$((P+1)); }
ko() { echo "FAIL $*"; F=$((F+1)); }
c() { curl -sS --cacert "$CA" "$@"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

echo "### 1. images built from this branch"
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | sort
docker image inspect lumen/portal:1.0.0 >/dev/null 2>&1 && ok "portal image lumen/portal:1.0.0 exists" || ko "portal image missing"
code=$(c -o /tmp/app.html -w '%{http_code}' https://app.lumen-it.test/)
[[ "$code" == 200 ]] && grep -q 'id="root"' /tmp/app.html && ok "chat app (built by the installer) served at https://app.lumen-it.test/ ($code)" || ko "chat app: $code"
cfg=$(c https://app.lumen-it.test/config.json)
echo "$cfg" | j 'print("config.json: environment =", d.get("environment"), "| workspace block keys =", sorted((d.get("workspace") or {}).keys()))'
echo "$cfg" | j 'assert d.get("environment") == "test" and d.get("workspace")' && ok "chat config.json carries environment=test and the workspace block" || ko "chat config.json"

echo "### 2. migrations"
./lumenctl manage showmigrations workspaces crm automation integrations assistant mcp 2>&1 | grep -vE "^\s*$|Creating|Container" 
if ./lumenctl manage migrate --check >/dev/null 2>&1; then ok "migrate --check: every migration applied"; else ko "unapplied migrations"; fi

echo "### 3. services"
docker ps --format '{{.Names}}  {{.Status}}' | sort
hdr=$(c -sI $D/)
echo "$hdr" | grep -i '^x-nexus-environment' && ok "portal answers with X-Nexus-Environment: test" || ko "no X-Nexus-Environment header"
home=$(c $D/); grep -o 'Test environment[^<]*' <<<"$home" | head -1; grep -q "Test environment" <<<"$home" && ok "website shows the test-environment banner" || ko "no banner"

echo "### 4. /api/v1/me without a token"
c -i $D/api/v1/me | sed -n '1,30p' | grep -iE '^HTTP|^www-authenticate|^content-type|^x-nexus|^cache-control|"code"'
[[ $(c -o /dev/null -w '%{http_code}' $D/api/v1/me) == 401 ]] && ok "/api/v1/me answers 401 without a token" || ko "/api/v1/me"

echo "### 5. OAuth metadata for the Claude connector"
prm=$(c $D/.well-known/oauth-protected-resource/mcp); echo "$prm" | python3 -m json.tool
echo "$prm" | j 'assert d["resource"] == "https://lumen-it.test/mcp", d; assert "https://lumen-it.test" in d["authorization_servers"]; assert {"mcp:read","mcp:write"} <= set(d["scopes_supported"])' \
  && ok "RFC 9728 protected-resource metadata: resource https://lumen-it.test/mcp, authorization server, MCP scopes" || ko "protected-resource metadata"
asm=$(c $D/.well-known/oauth-authorization-server); echo "$asm" | python3 -m json.tool
echo "$asm" | j 'assert d["issuer"] == "https://lumen-it.test"; assert d["code_challenge_methods_supported"] == ["S256"]; assert d["registration_endpoint"].startswith("https://lumen-it.test/"); assert "none" in d["token_endpoint_auth_methods_supported"]; assert {"mcp:read","mcp:write"} <= set(d["scopes_supported"]); assert d.get("authorization_response_iss_parameter_supported") is True' \
  && ok "RFC 8414 authorization-server metadata: issuer, S256 only, DCR endpoint, public clients, MCP scopes, iss" || ko "authorization-server metadata"

echo "### 6. /mcp without a token"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"nexus-qa","version":"1"}}}'
resp=$(c -i -X POST $D/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$init")
echo "$resp" | grep -iE '^HTTP|^www-authenticate'
echo "$resp" | head -1 | grep -q ' 401' && echo "$resp" | grep -i '^www-authenticate' | grep -q 'resource_metadata="https://lumen-it.test/.well-known/oauth-protected-resource/mcp"' \
  && ok "/mcp answers 401 with WWW-Authenticate resource_metadata" || ko "/mcp 401 header"

echo "### 7. a synthetic owner and business workspace (token not printed)"
out=$(./lumenctl manage shell -c "$(cat /root/vm-nexus-setup.py)" 2>&1)
WS=$(grep '^WS=' <<<"$out" | tail -1 | cut -d= -f2); TOKEN=$(grep '^TOKEN=' <<<"$out" | tail -1 | cut -d= -f2-)
[[ -n "$WS" && -n "$TOKEN" ]] && ok "synthetic workspace $WS and a nexus-web access token created" || { ko "setup: $(grep -v TOKEN <<<"$out" | tail -5)"; }
A=(-H "Authorization: Bearer $TOKEN")
c "${A[@]}" $D/api/v1/me | j 'print("/api/v1/me with the token:", d["data"]["user"]["username"])' && ok "/api/v1/me answers 200 with a nexus-web token" || ko "/api/v1/me with token"
[[ $(c -o /dev/null -w '%{http_code}' "${A[@]}" -X POST $D/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$init") == 401 ]] \
  && ok "the SPA's nexus-web token is refused at /mcp (separate audiences)" || ko "nexus-web token accepted at /mcp"

echo "### 8. integrations without credentials"
prov=$(c "${A[@]}" $D/api/v1/workspaces/$WS/integrations/providers)
python3 -c '
import json, sys
for p in json.load(sys.stdin)["data"]:
    env_set = [e["name"] for e in p["setup"]["env"] if e["set"]]
    print("%-12s configured=%-5s oauth_configured=%-5s methods=%s mock=%s can_connect=%s settings present=%s"
          % (p["label"], p["configured"], p["oauth_configured"], p["methods"], p["mock"], p["can_connect"], env_set))
' <<<"$prov"
j '
g = {p["id"]: p for p in d["data"]}
assert not any(p["oauth_configured"] for p in g.values()), "an OAuth client is configured"
assert not any(p["mock"] for p in g.values())
assert g["gmail"]["configured"] is False and g["slack"]["configured"] is False' <<<"$prov" \
  && ok "integrations: no provider OAuth client configured (Gmail, Slack not configured; HighLevel only offers a private integration token); mock mode off" || ko "integrations state"
c "${A[@]}" $D/api/v1/workspaces/$WS/crm/dashboard | j '
for s in d["data"]["connected_services"]:
    print("Home connected services:", s["label"], "->", s["status"], "/", s["status_label"])'

echo "### 9. secure document storage (deploy-wiring patch NOT applied: expected 503)"
APP=$(c "${A[@]}" -X POST -H 'Content-Type: application/json' -d '{"title":"QA synthetic application","apply_template":false}' $D/api/v1/workspaces/$WS/crm/lending/applications | j 'print(d["data"]["id"])')
[[ -n "$APP" ]] && ok "lending application created through the API ($APP)" || ko "lending application"
up=$(c -i "${A[@]}" -X POST -H 'Content-Type: application/pdf' -H 'X-Nexus-Filename: qa-synthetic.pdf' --data-binary $'%PDF-1.4\n% synthetic\n%%EOF\n' \
     $D/api/v1/workspaces/$WS/crm/lending/applications/$APP/documents)
echo "$up" | grep -E '^HTTP|"code"' ; echo "$up" | tail -1
echo "$up" | head -1 | grep -q ' 503' && echo "$up" | grep -q '"not_configured"' && ok "document upload answers 503 not_configured" || ko "document upload"

echo
echo "RESULT: $P passed, $F failed"
[[ $F == 0 ]]
