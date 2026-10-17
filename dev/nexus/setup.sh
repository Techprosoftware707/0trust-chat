#!/usr/bin/env bash
# One-time (idempotent) set-up of the Nexus local test environment:
# PostgreSQL container, database, migrations, OAuth clients, demo data, homeserver and
# Matrix accounts for the demo people. Nothing here touches any other checkout's containers.
#   dev/nexus/setup.sh            idempotent
#   dev/nexus/setup.sh --fresh    drop the nexus_dev database first
set -euo pipefail
. "$(dirname "$0")/env.sh"

if ! docker inspect nexus-pg >/dev/null 2>&1; then
  docker run -d --name nexus-pg -p 127.0.0.1:55433:5432 -e POSTGRES_USER=lumen_app -e POSTGRES_PASSWORD=devpass \
    -e POSTGRES_DB=nexus postgres:17-alpine >/dev/null
fi
docker start nexus-pg >/dev/null
until docker exec nexus-pg pg_isready -U lumen_app >/dev/null 2>&1; do sleep 1; done
FRESH=0
if [ "${1:-}" = "--fresh" ]; then
  # Start over: drop the development database (never any other) and, below, the data of
  # this environment's own homeserver container.
  FRESH=1
  docker exec nexus-pg dropdb -U lumen_app --if-exists --force nexus_dev
fi
docker exec nexus-pg psql -U lumen_app -d nexus -tAc "SELECT 1 FROM pg_database WHERE datname='nexus_dev'" | grep -q 1 \
  || docker exec nexus-pg createdb -U lumen_app nexus_dev

cd "$NEXUS_REPO/services/portal"
"$NEXUS_VENV/bin/python" manage.py migrate --noinput -v0
"$NEXUS_VENV/bin/python" manage.py lumen_bootstrap
"$NEXUS_VENV/bin/python" manage.py nexus_demo_seed --reset-passwords

cd "$NEXUS_REPO/services/chat"
[ "$FRESH" = 1 ] && node ../../tests/chat/devserver.mjs reset
node ../../tests/chat/devserver.mjs up
node "$NEXUS_DEV_DIR/matrix-users.mjs"
echo "ready: run dev/nexus/run-portal.sh and dev/nexus/run-chat.sh"
