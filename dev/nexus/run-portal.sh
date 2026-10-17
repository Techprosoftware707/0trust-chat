#!/usr/bin/env bash
# Portal (website, portal, OAuth/OIDC provider, /api/v1) on http://127.0.0.1:8710
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$NEXUS_REPO/services/portal"
exec "$NEXUS_VENV/bin/python" manage.py runserver 127.0.0.1:8710 --noreload
