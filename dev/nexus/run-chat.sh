#!/usr/bin/env bash
# Chat SPA / workspace shell (Vite dev server) on http://127.0.0.1:5710 (5710+NEXUS_SLOT)
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$NEXUS_REPO/services/chat"
exec npx vite --port "$NEXUS_CHAT_PORT" --strictPort
