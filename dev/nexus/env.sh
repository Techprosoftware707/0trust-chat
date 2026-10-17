# shellcheck shell=bash
# Environment of the Nexus local test environment (portal dev server on 127.0.0.1:8710).
#   . dev/nexus/env.sh          (from the repository root; bash/zsh)
#   NEXUS_SLOT=2 . dev/nexus/env.sh   a second, independent environment next to slot 0:
#     portal 8710+N, chat 5710+N, database nexus_dev_N. The homeserver (28108) is shared;
#     only slot 0 may reset it.
# Development values only: every secret here is a throwaway for this machine.
NEXUS_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
NEXUS_REPO="$(cd "$NEXUS_DEV_DIR/../.." && pwd)"
export NEXUS_DEV_DIR NEXUS_REPO
export NEXUS_VENV="${NEXUS_VENV:-/home/user/nexus-venv}"
export NEXUS_SLOT="${NEXUS_SLOT:-0}"
case "$NEXUS_SLOT" in [0-9]) ;; *) echo "NEXUS_SLOT must be 0-9" >&2; return 1 2>/dev/null || exit 1 ;; esac
export NEXUS_PORTAL_PORT=$((8710 + NEXUS_SLOT)) NEXUS_CHAT_PORT=$((5710 + NEXUS_SLOT))
if [ "$NEXUS_SLOT" = 0 ]; then export NEXUS_DEV_DB=nexus_dev; else export NEXUS_DEV_DB="nexus_dev_$NEXUS_SLOT"; fi
export NEXUS_STATE="${NEXUS_STATE:-$NEXUS_REPO/dev/nexus/.state}"
mkdir -p "$NEXUS_STATE"
[ -f "$NEXUS_STATE/oidc.pem" ] || openssl genrsa -out "$NEXUS_STATE/oidc.pem" 2048 2>/dev/null

export LUMEN_SURFACE=public
export LUMEN_ALLOW_ENV_SECRETS=1
export DJANGO_DEBUG=1
export LUMEN_INSECURE_DEV=1
export DJANGO_SECRET_KEY=nexus-local-dev-only-0123456789abcdef0123456789abcdef
export LUMEN_PRIMARY_DOMAIN=127.0.0.1
export LUMEN_PUBLIC_BASE_URL="http://127.0.0.1:$NEXUS_PORTAL_PORT"
export LUMEN_APP_BASE_URL="http://127.0.0.1:$NEXUS_CHAT_PORT"
export LUMEN_MATRIX_BASE_URL=http://127.0.0.1:28108
export MATRIX_SERVER_NAME=chatdev.test
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55433 POSTGRES_DB="$NEXUS_DEV_DB" POSTGRES_USER=lumen_app POSTGRES_PASSWORD=devpass
export OIDC_PRIVATE_KEY_FILE="$NEXUS_STATE/oidc.pem"
export SYNAPSE_OIDC_CLIENT_SECRET=nexus-local-dev-synapse-secret
export LUMEN_SIMPLE_STATIC=1
export BRAND_ASSET_URL=/static/brand/
export NEXUS_ENVIRONMENT=test
# Encrypted lending documents: ciphertext outside the repository's public paths, and a
# throwaway AES-256 master key per slot, read from a secret file like in production.
export NEXUS_SECURE_DOCUMENTS_DIR="$NEXUS_STATE/secure-documents-$NEXUS_SLOT"
[ -f "$NEXUS_STATE/document-key-$NEXUS_SLOT" ] || (umask 077 && openssl rand -base64 32 >"$NEXUS_STATE/document-key-$NEXUS_SLOT")
export NEXUS_DOCUMENT_KEY_FILE="$NEXUS_STATE/document-key-$NEXUS_SLOT"
export NEXUS_DEMO_PASSWORD="${NEXUS_DEMO_PASSWORD:-nexus-demo-pass-2026}"
# Chat SPA dev server (Vite) on 127.0.0.1:5710+N with the Nexus config (portal URLs follow the slot).
export LUMEN_CHAT_DEV_PORT="$NEXUS_CHAT_PORT"
sed "s#127.0.0.1:8710#127.0.0.1:$NEXUS_PORTAL_PORT#g" "$NEXUS_DEV_DIR/chat-config.json" >"$NEXUS_STATE/chat-config.json"
export LUMEN_CHAT_DEV_CONFIG="$NEXUS_STATE/chat-config.json"
# Own homeserver container, separate from any other checkout's.
export CHATDEV_CONTAINER=lumen-chatdev-nexus
export CHATDEV_PORT=28108
