#!/usr/bin/env bash
# The final verification pass at the fix commit: every check again, recorded in docs/nexus/evidence/final/.
set -u
Q=/tmp/claude-0/-home-user/e6bb18e2-ef15-525e-9375-04c4a4514dbf/scratchpad/qa
R="$Q/rec.sh"; E=/home/user/nexus/docs/nexus/evidence/final; N=/home/user/nexus
sum="$Q/final-pass-summary.txt"; : > "$sum"
step() { local f="$1"; shift; "$R" "$E/$f" "$@"; echo "$(date -u +%H:%M:%S) $f exit=$?" | tee -a "$sum"; }
stop_servers() {
  for p in $(pgrep -f "manage.py runserver 127.0.0.1:871[0]") $(pgrep -f "vite --port 571[0]"); do kill "$p" 2>/dev/null; done
  sleep 2
}

stop_servers
# 1. portal pytest, full, on a brand-new test database (every migration from empty)
docker exec nexus-pg psql -U lumen_app -d postgres -c "DROP DATABASE IF EXISTS test_nexus_final" >/dev/null
step portal-pytest-full.txt "$N/services/portal" "POSTGRES_PORT=55433 POSTGRES_DB=nexus_final /home/user/nexus-venv/bin/python -m pytest --create-db -p no:warnings 2>&1 | tail -40"
# 2. chat, deploy, CI, contrast, ruff
bash "$Q/static-checks.sh" > "$Q/static-final.out" 2>&1; echo "$(date -u +%H:%M:%S) static-checks done" | tee -a "$sum"; tail -14 "$Q/static-final.out" >> "$sum"
# 3. upgrade from the base Lumen schema on a real database
step migrations-from-base-lumen.txt "$N" "bash $Q/base-migrate.sh"
# 4. fresh slot-0 environment and dev servers
step dev-setup-fresh.txt "$N" "bash dev/nexus/setup.sh --fresh 2>&1 | tail -40 && . dev/nexus/env.sh && cd services/portal && \$NEXUS_VENV/bin/python manage.py showmigrations workspaces crm automation integrations assistant mcp"
(cd "$N" && NEXUS_MCP_ENABLED=1 nohup bash dev/nexus/run-portal.sh > "$Q/portal.log" 2>&1 &)
(cd "$N" && nohup bash dev/nexus/run-chat.sh > "$Q/chat.log" 2>&1 &)
for _ in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:8710/healthz && curl -s -o /dev/null http://127.0.0.1:5710/ && break; sleep 2; done
# 5. browser smokes (mock mode, development AI provider)
step smoke-shell.txt "$N" ". dev/nexus/env.sh && node tests/nexus/shell.smoke.mjs --no-shots"
step smoke-verticals.txt "$N" ". dev/nexus/env.sh && node tests/nexus/verticals.smoke.mjs --no-shots"
step smoke-integrations-mock.txt "$N" ". dev/nexus/env.sh && echo NEXUS_INTEGRATIONS_MOCK=\$NEXUS_INTEGRATIONS_MOCK && node tests/nexus/integrations.smoke.mjs --no-shots"
step smoke-assistant.txt "$N" ". dev/nexus/env.sh && (cd services/portal && \$NEXUS_VENV/bin/python manage.py shell -c \"from apps.assistant.models import AISettings; from apps.crm.models import OrgSettings; ws=OrgSettings.objects.get(is_demo=True).workspace; AISettings.objects.update_or_create(workspace=ws, defaults={'mcp_enabled': True}); print('demo workspace: Members may connect Claude = on')\" 2>&1 | tail -1) && NEXUS_PORTAL_URL=http://127.0.0.1:\$NEXUS_PORTAL_PORT NEXUS_APP_URL=http://127.0.0.1:\$NEXUS_CHAT_PORT node tests/nexus/assistant.smoke.mjs --no-shots"
# 6. MCP conformance with the official SDK in throwaway venvs (deleted afterwards)
python3 -m venv "$Q/mcp-sdk-2" && "$Q/mcp-sdk-2/bin/pip" install -q mcp==2.3.0 && "$Q/mcp-sdk-2/bin/pip" freeze > "$E/mcp-sdk-2.3.0.freeze.txt"
step mcp-sdk-2.3.0-conformance.log "$N" ". dev/nexus/env.sh && $Q/mcp-sdk-2/bin/python -I tests/nexus/mcp_sdk_conformance.py --server http://127.0.0.1:\$NEXUS_PORTAL_PORT --username demo-riley --out docs/nexus/evidence/final"
python3 -m venv "$Q/mcp-sdk-1" && "$Q/mcp-sdk-1/bin/pip" install -q mcp==1.30.0 && "$Q/mcp-sdk-1/bin/pip" freeze > "$E/mcp-sdk-1.30.0.freeze.txt"
step mcp-sdk-1.30.0-conformance.log "$N" ". dev/nexus/env.sh && $Q/mcp-sdk-1/bin/python -I tests/nexus/mcp_sdk_conformance.py --server http://127.0.0.1:\$NEXUS_PORTAL_PORT --username demo-riley --out docs/nexus/evidence/final"
rm -rf "$Q/mcp-sdk-1" "$Q/mcp-sdk-2"; echo "# afterwards: rm -rf scratchpad/qa/mcp-sdk-1 scratchpad/qa/mcp-sdk-2 (both throwaway SDK venvs deleted: $(ls -d "$Q"/mcp-sdk-* 2>/dev/null | wc -l) left)" >> "$E/mcp-sdk-1.30.0-conformance.log"
# 7. the end-to-end journey (screenshots in docs/nexus/screenshots/final/)
rm -f "$N"/docs/nexus/screenshots/final/*.png
step smoke-journey.txt "$N" ". dev/nexus/env.sh && node tests/nexus/journey.smoke.mjs"
# 8. chat suites against the Nexus homeserver
step chat-test-e2ee.txt "$N/services/chat" ". ../../dev/nexus/env.sh && echo CHATDEV_CONTAINER=\$CHATDEV_CONTAINER CHATDEV_PORT=\$CHATDEV_PORT && npm run test:e2ee 2>&1 | tail -30"
step chat-test-ui.txt "$N/services/chat" ". ../../dev/nexus/env.sh && npm run test:ui 2>&1 | grep -vE '^dist/|^\s*$' | tail -45"
(cd "$N" && git checkout -- tests/chat/screenshots && echo "# afterwards: git checkout -- tests/chat/screenshots (tracked screenshots restored)" >> "$E/chat-test-ui.txt")
stop_servers
echo "$(date -u +%H:%M:%S) dev servers stopped" | tee -a "$sum"
# 9. installer: a fresh test server with this commit, then removed
bash "$Q/vm-nexus.sh" > "$Q/vm-nexus.out" 2>&1; echo "$(date -u +%H:%M:%S) installer exit=$?" | tee -a "$sum"
docker rm -f lumen-it >/dev/null 2>&1; docker volume rm lumen-it-docker lumen-it-containerd >/dev/null 2>&1
echo "$(date -u +%H:%M:%S) test server removed: $(docker ps -a --format '{{.Names}}' | grep -c '^lumen-it$') containers, $(docker volume ls --format '{{.Name}}' | grep -c '^lumen-it-') volumes left; free $(df -h --output=avail / | tail -1)" | tee -a "$sum"
echo DONE | tee -a "$sum"
