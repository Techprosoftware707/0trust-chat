"""Settings for the automated test-suite (environment prepared before import).

Tests run against PostgreSQL (the audit-log trigger, advisory locks and the
atomic rate limiter are PostgreSQL features). Point POSTGRES_* at a disposable
server, e.g. `docker run -d -p 127.0.0.1:55432:5432 -e POSTGRES_USER=lumen_app
-e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=lumen postgres:17-alpine`
(the Nexus test environment uses its own server on 55433: docs/nexus/DEVELOPMENT.md).
"""


import os
import subprocess
import tempfile

_key = os.path.join(tempfile.gettempdir(), "lumen-test-oidc.pem")
if not os.path.exists(_key):
    subprocess.run(["openssl", "genrsa", "-out", _key, "2048"], check=True, capture_output=True)

os.environ.update(
    {
        "LUMEN_SURFACE": "test",
        "LUMEN_ALLOW_ENV_SECRETS": "1",
        "DJANGO_SECRET_KEY": "test-secret-key-0123456789abcdef0123456789abcdef",
        "LUMEN_PRIMARY_DOMAIN": "lumen.test",
        "OPS_GATEWAY_SECRET": "test-gateway",
        "INTERNAL_API_TOKEN": "test-internal-token",
        "SYNAPSE_OIDC_CLIENT_SECRET": "test-oidc-client-secret",
        "OIDC_PRIVATE_KEY_FILE": _key,
        "LUMEN_SIMPLE_STATIC": "1",
        "LUMEN_TEST_EMAIL_LOCMEM": "1",
        "SYNAPSE_ADMIN_TOKEN": "",
        "NEXUS_ENVIRONMENT": "test",
        # Throwaway AES-256 key for encrypted integration tokens in tests (apps.integrations.crypto).
        "NEXUS_INTEGRATIONS_KEY": "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    }
)
os.environ.setdefault("POSTGRES_HOST", "127.0.0.1")
os.environ.setdefault("POSTGRES_PORT", "55432")
os.environ.setdefault("POSTGRES_PASSWORD", "devpass")

from .settings import *  # noqa: E402,F401,F403

# Unit tests never talk to a real host agent, even on a host where one is running: the
# console then shows its "agent unavailable" state, which is what these tests exercise.
HOST_AGENT_SOCKET = "/nonexistent/lumen-agent-under-test.sock"
