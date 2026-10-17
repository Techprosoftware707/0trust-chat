# Environment of the Nexus local test environment (portal dev server on 127.0.0.1:8710).
#   . dev/nexus/env.sh          (from the repository root; bash/zsh)
# Development values only: every secret here is a throwaway for this machine.
NEXUS_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
NEXUS_REPO="$(cd "$NEXUS_DEV_DIR/../.." && pwd)"
export NEXUS_DEV_DIR NEXUS_REPO
export NEXUS_VENV="${NEXUS_VENV:-/home/user/nexus-venv}"
export NEXUS_STATE="${NEXUS_STATE:-$NEXUS_REPO/dev/nexus/.state}"
mkdir -p "$NEXUS_STATE"
[ -f "$NEXUS_STATE/oidc.pem" ] || openssl genrsa -out "$NEXUS_STATE/oidc.pem" 2048 2>/dev/null

export LUMEN_SURFACE=public
export LUMEN_ALLOW_ENV_SECRETS=1
export DJANGO_DEBUG=1
export LUMEN_INSECURE_DEV=1
export DJANGO_SECRET_KEY=nexus-local-dev-only-0123456789abcdef0123456789abcdef
export LUMEN_PRIMARY_DOMAIN=127.0.0.1
export LUMEN_PUBLIC_BASE_URL=http://127.0.0.1:8710
export LUMEN_APP_BASE_URL=http://127.0.0.1:5710
export LUMEN_MATRIX_BASE_URL=http://127.0.0.1:28108
export MATRIX_SERVER_NAME=chatdev.test
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55433 POSTGRES_DB=nexus_dev POSTGRES_USER=lumen_app POSTGRES_PASSWORD=devpass
export OIDC_PRIVATE_KEY_FILE="$NEXUS_STATE/oidc.pem"
export SYNAPSE_OIDC_CLIENT_SECRET=nexus-local-dev-synapse-secret
export LUMEN_SIMPLE_STATIC=1
export BRAND_ASSET_URL=/static/brand/
export NEXUS_ENVIRONMENT=test
export NEXUS_DEMO_PASSWORD="${NEXUS_DEMO_PASSWORD:-nexus-demo-pass-2026}"
# Chat SPA dev server (Vite) on 127.0.0.1:5710 with the Nexus config.
export LUMEN_CHAT_DEV_PORT=5710
export LUMEN_CHAT_DEV_CONFIG="$NEXUS_DEV_DIR/chat-config.json"
# Own homeserver container, separate from any other checkout's.
export CHATDEV_CONTAINER=lumen-chatdev-nexus
export CHATDEV_PORT=28108
