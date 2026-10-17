"""Django settings for the Lumen portal, admin console (ops) and worker.

One codebase runs as three processes with different privileges, selected by
``LUMEN_SURFACE``:

* ``public`` — website, customer portal, OIDC provider, billing webhooks.
* ``ops``    — operator console + internal entitlement API (never public).
* ``worker`` — background jobs; serves no HTTP.

Every value comes from the environment rendered by the installer
(``/etc/lumen/lumen.env``) and secrets from read-only files (``*_FILE``).
"""

from __future__ import annotations

import re
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from django.utils.csp import CSP

from .env import env, env_bool, env_int, env_list, secret

BASE_DIR = Path(__file__).resolve().parent.parent

SURFACE = env("LUMEN_SURFACE", "public")
if SURFACE not in {"public", "ops", "worker", "test"}:
    raise RuntimeError(f"Unknown LUMEN_SURFACE {SURFACE!r}")

LUMEN_VERSION = env("LUMEN_VERSION", "0.0.0-dev")
DEBUG = env_bool("DJANGO_DEBUG", False)
# Local development over plain HTTP (never in production): drops Secure cookies.
INSECURE_DEV = env_bool("LUMEN_INSECURE_DEV", False)

SECRET_KEY = secret("DJANGO_SECRET_KEY", required=True)

# --- Domains -----------------------------------------------------------------
PRIMARY_DOMAIN = env("LUMEN_PRIMARY_DOMAIN", "localhost")
APP_DOMAIN = env("LUMEN_APP_DOMAIN", f"app.{PRIMARY_DOMAIN}")
MATRIX_DOMAIN = env("LUMEN_MATRIX_DOMAIN", f"matrix.{PRIMARY_DOMAIN}")
OPS_DOMAIN = env("LUMEN_OPS_DOMAIN", f"ops.{PRIMARY_DOMAIN}")
OPS_PORT = env_int("LUMEN_OPS_PORT", 8443)
MATRIX_SERVER_NAME = env("MATRIX_SERVER_NAME", PRIMARY_DOMAIN)
_scheme = "http" if INSECURE_DEV else "https"
PUBLIC_BASE_URL = env("LUMEN_PUBLIC_BASE_URL", f"{_scheme}://{PRIMARY_DOMAIN}")
APP_BASE_URL = env("LUMEN_APP_BASE_URL", f"{_scheme}://{APP_DOMAIN}")
MATRIX_BASE_URL = env("LUMEN_MATRIX_BASE_URL", f"{_scheme}://{MATRIX_DOMAIN}")
OPS_BASE_URL = env("LUMEN_OPS_BASE_URL", f"{_scheme}://{OPS_DOMAIN}:{OPS_PORT}")

if SURFACE == "ops":
    ALLOWED_HOSTS = [OPS_DOMAIN, "ops", "localhost", "127.0.0.1"]
elif SURFACE == "test":
    ALLOWED_HOSTS = ["*"]
else:
    ALLOWED_HOSTS = [PRIMARY_DOMAIN, "portal", "localhost", "127.0.0.1"]
ALLOWED_HOSTS += env_list("LUMEN_EXTRA_ALLOWED_HOSTS")

CSRF_TRUSTED_ORIGINS = [PUBLIC_BASE_URL, OPS_BASE_URL]

# --- Branding (all user-visible names come from here) -------------------------
# "Nexus Office AI" is a TEMPORARY test brand of the test/unified-business-workspace
# branch (docs/nexus/IMPLEMENTATION-NOTES.md); the BRAND_* variables still override it.
BRAND = {
    "name": env("BRAND_NAME", "Nexus Office AI"),
    "short_name": env("BRAND_SHORT_NAME", "Nexus"),
    "tagline": env("BRAND_TAGLINE", "Your encrypted business workspace: chat, calls, CRM and AI in one place."),
    "legal_name": env("BRAND_LEGAL_NAME", "The Lumen Secure operator"),
    "jurisdiction": env("BRAND_JURISDICTION", ""),
    "support_email": env("SUPPORT_EMAIL", f"support@{PRIMARY_DOMAIN}"),
    "security_email": env("SECURITY_EMAIL", f"security@{PRIMARY_DOMAIN}"),
    "privacy_email": env("PRIVACY_EMAIL", f"privacy@{PRIMARY_DOMAIN}"),
}

# --- Nexus environment ------------------------------------------------------------
# production | test | development. Anything but production shows a persistent
# "Test environment · synthetic demo data" banner in the portal and the chat app, prefixes
# page titles, and is sent on every response as X-Nexus-Environment. The demo-data commands
# (nexus_demo_seed / nexus_demo_reset) refuse to run in production.
NEXUS_ENVIRONMENT = env("NEXUS_ENVIRONMENT", "production").strip().lower()
if NEXUS_ENVIRONMENT not in {"production", "test", "development"}:
    raise ImproperlyConfigured("NEXUS_ENVIRONMENT must be production, test or development")
NEXUS_ENVIRONMENT_LABEL = {"production": "", "test": "Test", "development": "Development"}[NEXUS_ENVIRONMENT]

# --- Applications --------------------------------------------------------------
# Nexus business apps. Each owns its models and migrations, and may provide (all optional):
#   urls.py      -> mounted at /<app>/ on the public surface (webhooks, OAuth callbacks)
#   api_urls.py  -> mounted at /api/v1/workspaces/<workspace_id>/<app>/ (bearer API)
#   jobs.py      -> JOBS = [Job(...)] picked up by the worker
#   features.py  -> FEATURES = {key: fn(workspace, plan, settings) -> bool} for the SPA
# Registration is already done here and in lumen/urls_public.py; teams only fill the modules.
NEXUS_APPS = ["apps.crm", "apps.integrations", "apps.assistant", "apps.mcp", "apps.automation"]

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",
    "allauth",
    "allauth.account",
    "allauth.mfa",
    "allauth.usersessions",
    "allauth.idp.oidc",
    "apps.core",
    "apps.accounts",
    "apps.workspaces",
    "apps.billing",
    "apps.oidc",
    "apps.ops",
    "apps.api",
    *NEXUS_APPS,
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "apps.core.middleware.RequestContextMiddleware",
    "apps.core.middleware.NexusEnvironmentMiddleware",
    "apps.api.cors.ApiCorsMiddleware",
    "apps.core.middleware.SurfaceGuardMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "allauth.usersessions.middleware.UserSessionsMiddleware",
    "apps.core.middleware.SessionIdleTimeoutMiddleware",
    "apps.core.middleware.AccountStatusMiddleware",
    "apps.ops.middleware.OpsAccessMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django.middleware.csp.ContentSecurityPolicyMiddleware",
    "apps.core.middleware.SecurityHeadersMiddleware",
]

ROOT_URLCONF = {
    "public": "lumen.urls_public",
    "ops": "lumen.urls_ops",
    "worker": "lumen.urls_worker",
    "test": "lumen.urls_test",
}[SURFACE]

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "django.template.context_processors.csp",
                "apps.core.context_processors.lumen",
            ],
        },
    }
]

WSGI_APPLICATION = "lumen.wsgi.application"

# --- Database --------------------------------------------------------------------
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "HOST": env("POSTGRES_HOST", "postgres"),
        "PORT": env("POSTGRES_PORT", "5432"),
        "NAME": env("POSTGRES_DB", "lumen"),
        "USER": env("POSTGRES_USER", "lumen_app"),
        "PASSWORD": secret("POSTGRES_PASSWORD", required=True),
        # Persistent connections (seconds). The development servers (runserver, a thread per
        # request) set 0, so several of them can share one PostgreSQL without running out.
        "CONN_MAX_AGE": env_int("POSTGRES_CONN_MAX_AGE", 60),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {"connect_timeout": 5, "application_name": f"lumen-{SURFACE}"},
    }
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "lumen_cache",
        "TIMEOUT": 300,
    }
}

# --- Authentication ----------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LOGIN_URL = "account_login"
LOGIN_REDIRECT_URL = "portal:dashboard" if SURFACE != "ops" else "ops:dashboard"
LOGOUT_REDIRECT_URL = "site:home" if SURFACE != "ops" else "account_login"

# --- Email -----------------------------------------------------------------------
SMTP_HOST = env("SMTP_HOST", "")
EMAIL_ENABLED = bool(SMTP_HOST)
if EMAIL_ENABLED:
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = SMTP_HOST
    EMAIL_PORT = env_int("SMTP_PORT", 587)
    EMAIL_HOST_USER = env("SMTP_USER", "")
    EMAIL_HOST_PASSWORD = secret("SMTP_PASSWORD")
    EMAIL_USE_TLS = env("SMTP_SECURITY", "starttls") == "starttls"
    EMAIL_USE_SSL = env("SMTP_SECURITY", "starttls") == "tls"
    EMAIL_TIMEOUT = 15
else:
    # No SMTP: never pretend mail was sent. Code paths check EMAIL_ENABLED and
    # this backend raises if anything still tries to send.
    EMAIL_BACKEND = "apps.core.mail.DisabledEmailBackend"
if env_bool("LUMEN_TEST_EMAIL_LOCMEM"):
    EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    EMAIL_ENABLED = True
DEFAULT_FROM_EMAIL = env("SMTP_FROM", f"{BRAND['name']} <no-reply@{PRIMARY_DOMAIN}>")
SERVER_EMAIL = DEFAULT_FROM_EMAIL

# --- django-allauth ----------------------------------------------------------------
REGISTRATION_MODE = env("REGISTRATION_MODE", "open")  # open | invite | closed
ACCOUNT_ADAPTER = "apps.accounts.adapter.AccountAdapter"
ACCOUNT_FORMS = {"signup": "apps.accounts.forms.SignupForm"}
ACCOUNT_LOGIN_METHODS = {"email", "username"}
ACCOUNT_SIGNUP_FIELDS = ["username*", "email*", "password1*", "password2*"]
ACCOUNT_USERNAME_MIN_LENGTH = 3
ACCOUNT_USERNAME_VALIDATORS = "apps.accounts.validators.USERNAME_VALIDATORS"
ACCOUNT_PRESERVE_USERNAME_CASING = False
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_EMAIL_VERIFICATION = "mandatory" if EMAIL_ENABLED else "none"
ACCOUNT_EMAIL_NOTIFICATIONS = EMAIL_ENABLED
ACCOUNT_CHANGE_EMAIL = True
ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = True
ACCOUNT_CONFIRM_EMAIL_ON_GET = False
ACCOUNT_DEFAULT_HTTP_PROTOCOL = "http" if INSECURE_DEV else "https"
ACCOUNT_EMAIL_SUBJECT_PREFIX = f"[{BRAND['short_name']}{' · ' + NEXUS_ENVIRONMENT_LABEL if NEXUS_ENVIRONMENT_LABEL else ''}] "
ACCOUNT_SESSION_REMEMBER = True
ACCOUNT_REAUTHENTICATION_TIMEOUT = 300
ACCOUNT_LOGOUT_ON_GET = False
ACCOUNT_RATE_LIMITS = {
    "login": "30/m/ip",
    "login_failed": "10/m/ip,5/5m/key",
    "signup": "10/h/ip",
    "confirm_email": "1/3m/key",
    "reset_password": "10/h/ip,3/h/key",
    "reset_password_from_key": "20/m/ip",
    "change_password": "5/m/user",
    "change_email": "3/h/user",
    "reauthenticate": "10/m/user",
}

MFA_SUPPORTED_TYPES = ["totp", "recovery_codes", "webauthn"]
# allauth only lets users with a verified email enrol MFA. Without SMTP no address can
# ever be verified (and email is not used for sign-in or recovery), so MFA must not
# depend on it; with SMTP, verification is mandatory and the guard stays in place.
MFA_ALLOW_UNVERIFIED_EMAIL = not EMAIL_ENABLED
MFA_ADAPTER = "apps.accounts.adapter.MFAAdapter"
MFA_TOTP_ISSUER = BRAND["name"]
MFA_RECOVERY_CODE_COUNT = 10
MFA_TRUST_ENABLED = False
MFA_PASSKEY_LOGIN_ENABLED = False
MFA_WEBAUTHN_ALLOW_INSECURE_ORIGIN = INSECURE_DEV

USERSESSIONS_TRACK_ACTIVITY = True

IDP_OIDC_ADAPTER = "apps.oidc.adapter.LumenOIDCAdapter"
IDP_OIDC_PRIVATE_KEY = secret("OIDC_PRIVATE_KEY") if SURFACE in {"public", "test"} else ""
IDP_OIDC_ID_TOKEN_EXPIRES_IN = 300
IDP_OIDC_ACCESS_TOKEN_EXPIRES_IN = 300
IDP_OIDC_AUTHORIZATION_CODE_EXPIRES_IN = 60
IDP_OIDC_RP_INITIATED_LOGOUT_ASKS_FOR_OP_LOGOUT = True
# Confidential clients post their secret. (client_secret_basic is not offered: with
# oauthlib's OIDC dispatcher it yields token responses without an id_token, because the
# code lookup needs client_id in the request body.) "none" is for registered PUBLIC
# clients only (the first-party SPA "nexus-web"): oauthlib still requires the secret of
# every confidential client such as the homeserver, and PKCE is mandatory for public ones.
IDP_OIDC_AUTH_METHODS = ["client_secret_post", "none"]
SYNAPSE_OIDC_CLIENT_ID = env("SYNAPSE_OIDC_CLIENT_ID", "lumen-synapse")
SYNAPSE_OIDC_CLIENT_SECRET = secret("SYNAPSE_OIDC_CLIENT_SECRET") if SURFACE in {"public", "test"} else ""
# Refresh tokens (only the SPA client is granted refresh_token) expire after this long and
# rotate on every use; access tokens live IDP_OIDC_ACCESS_TOKEN_EXPIRES_IN (5 minutes).
IDP_OIDC_REFRESH_TOKEN_EXPIRES_IN = env_int("NEXUS_REFRESH_TOKEN_SECONDS", 12 * 3600)
IDP_OIDC_ROTATE_REFRESH_TOKEN = True


def _origin(url: str) -> str:
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


# --- Nexus API (/api/v1/, bearer tokens from this portal's OAuth server) ---------------
# First-party public client for the workspace SPA (registered by lumen_bootstrap).
NEXUS_WEB_CLIENT_ID = env("NEXUS_WEB_CLIENT_ID", "nexus-web")
NEXUS_WEB_REDIRECT_URIS = env_list("NEXUS_WEB_REDIRECT_URIS", [f"{APP_BASE_URL.rstrip('/')}/oauth/callback"])
# Browser origins allowed to call /api/v1/ and the token/revoke endpoints (CORS, no cookies).
NEXUS_CORS_ORIGINS = env_list("NEXUS_CORS_ORIGINS", [_origin(APP_BASE_URL)])
# The protected resource identifier of the API (RFC 8707 audience). Tokens that carry
# resources must name it; tokens without resources must come from NEXUS_API_CLIENT_IDS.
NEXUS_API_RESOURCE = env("NEXUS_API_RESOURCE", f"{PUBLIC_BASE_URL.rstrip('/')}/api/v1")
NEXUS_API_CLIENT_IDS = env_list("NEXUS_API_CLIENT_IDS", [NEXUS_WEB_CLIENT_ID])
# Scopes understood by /api/v1/. Other teams add theirs here (e.g. mcp:*) next to their policy.
NEXUS_API_SCOPES = {
    "workspace:read": "Read the business records of your workspaces",
    "workspace:write": "Create and change business records in your workspaces",
}
NEXUS_API_RATE_LIMITS = {
    # (requests, window seconds) per authenticated user
    "read": (env_int("NEXUS_API_READS_PER_MINUTE", 600), 60),
    "write": (env_int("NEXUS_API_WRITES_PER_MINUTE", 120), 60),
    # failed bearer authentications per client IP
    "auth_failures": (30, 60),
}
# Record a hash-chained audit event for reads of sensitive data (contact details, exports).
NEXUS_AUDIT_SENSITIVE_READS = env_bool("NEXUS_AUDIT_SENSITIVE_READS", True)

# --- Nexus AI assistant (apps.assistant) and Claude MCP connector (apps.mcp) ---------------
# docs/nexus/CONFIG.md and docs/nexus/CLAUDE-CONNECTOR.md. The MCP connector does not give
# the in-app assistant a model: AI_PROVIDER needs its own credentials and billing.
# none | dev (deterministic, model-free, labelled "Development mode") | anthropic
AI_PROVIDER = env("AI_PROVIDER", "none" if NEXUS_ENVIRONMENT == "production" else "dev").strip().lower()
AI_MODEL = env("AI_MODEL", "")  # required for AI_PROVIDER=anthropic: a current Claude model ID; no default on purpose
AI_API_KEY = secret("AI_API_KEY") if SURFACE in {"public", "test"} else ""
AI_API_BASE_URL = env("AI_API_BASE_URL", "https://api.anthropic.com")
AI_MAX_TOKENS = env_int("AI_MAX_TOKENS", 4096)
AI_TIMEOUT_SECONDS = env_int("AI_TIMEOUT_SECONDS", 60)
AI_MAX_TOOL_ROUNDS = env_int("AI_MAX_TOOL_ROUNDS", 6)
NEXUS_AI_RATE_LIMITS = {
    # (requests, window seconds) per user
    "chat": (env_int("NEXUS_AI_CHATS_PER_MINUTE", 20), 60),
    "mcp": (env_int("NEXUS_MCP_REQUESTS_PER_MINUTE", 120), 60),
    "prepare": (env_int("NEXUS_AI_PREPARES_PER_MINUTE", 30), 60),
    "confirm": (env_int("NEXUS_AI_CONFIRMS_PER_MINUTE", 30), 60),
}
NEXUS_AI_PENDING_ACTION_SECONDS = env_int("NEXUS_AI_PENDING_ACTION_SECONDS", 600)

# Remote MCP server at <LUMEN_PUBLIC_BASE_URL>/mcp (Streamable HTTP, OAuth on this portal).
NEXUS_MCP_ENABLED = env_bool("NEXUS_MCP_ENABLED", False)
NEXUS_MCP_RESOURCE = env("NEXUS_MCP_RESOURCE", f"{PUBLIC_BASE_URL.rstrip('/')}/mcp")
NEXUS_MCP_SCOPES = {
    "mcp:read": "Read business records you can see (contacts, deals, tasks, calendar, timeline)",
    "mcp:write": "Prepare changes (tasks, notes, contact fields, deal stages) that you confirm before they happen",
}
# Browser Origins accepted at /mcp (requests without Origin, e.g. from Claude's servers, are fine).
NEXUS_MCP_ALLOWED_ORIGINS = env_list(
    "NEXUS_MCP_ALLOWED_ORIGINS", [_origin(PUBLIC_BASE_URL), _origin(APP_BASE_URL), "https://claude.ai", "https://claude.com"]
)
# Redirect URIs a dynamically registered (DCR) or CIMD client may use: Claude's callbacks,
# loopback on any port (Claude Code, RFC 8252) and an operator allow-list.
NEXUS_MCP_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] + env_list(
    "NEXUS_MCP_EXTRA_REDIRECT_URIS"
)
NEXUS_MCP_ALLOW_LOOPBACK_REDIRECTS = env_bool("NEXUS_MCP_ALLOW_LOOPBACK_REDIRECTS", True)
NEXUS_MCP_DCR_ENABLED = env_bool("NEXUS_MCP_DCR_ENABLED", True)
NEXUS_MCP_DCR_RATE = (env_int("NEXUS_MCP_REGISTRATIONS_PER_MINUTE", 10), 60)  # per client IP
NEXUS_MCP_DCR_MAX_UNUSED = env_int("NEXUS_MCP_DCR_MAX_UNUSED", 500)
NEXUS_MCP_DCR_UNUSED_DAYS = env_int("NEXUS_MCP_DCR_UNUSED_DAYS", 7)
NEXUS_MCP_CIMD_ENABLED = env_bool("NEXUS_MCP_CIMD_ENABLED", True)
NEXUS_MCP_CIMD_ALLOWED_HOSTS = env_list("NEXUS_MCP_CIMD_ALLOWED_HOSTS")  # empty: any public HTTPS host
NEXUS_MCP_CIMD_TIMEOUT_SECONDS = env_int("NEXUS_MCP_CIMD_TIMEOUT_SECONDS", 4)
NEXUS_MCP_CIMD_MAX_BYTES = env_int("NEXUS_MCP_CIMD_MAX_BYTES", 16384)
NEXUS_MCP_CIMD_CACHE_SECONDS = env_int("NEXUS_MCP_CIMD_CACHE_SECONDS", 3600)
# Connector refresh tokens rotate on every use; this is how long an unused one stays valid.
NEXUS_MCP_REFRESH_TOKEN_SECONDS = env_int("NEXUS_MCP_REFRESH_TOKEN_SECONDS", 14 * 24 * 3600)

# --- Nexus verticals: lending documents, deadlines, automation (docs/nexus/CONFIG.md) ---------
# Encrypted lending documents: ciphertext directory (never under a public/static/media path;
# empty = uploads are refused with "not set up") and the AES-256 master key(s), base64, from
# the secret file NEXUS_DOCUMENT_KEY_FILE (first key encrypts, all decrypt: rotation).
NEXUS_SECURE_DOCUMENTS_DIR = env("NEXUS_SECURE_DOCUMENTS_DIR", "")
NEXUS_DOCUMENT_KEY = secret("NEXUS_DOCUMENT_KEY") if SURFACE in {"public", "worker", "test"} else ""
NEXUS_DOCUMENT_MAX_BYTES = env_int("NEXUS_DOCUMENT_MAX_MB", 15) * 1024 * 1024
NEXUS_DOCUMENT_TOKEN_SECONDS = env_int("NEXUS_DOCUMENT_TOKEN_SECONDS", 60)
# Deal and application deadlines due within this many days are highlighted as "due soon".
NEXUS_DEADLINE_SOON_DAYS = env_int("NEXUS_DEADLINE_SOON_DAYS", 3)
# Automation: loop depth limit, workspace-wide hourly cap, reminder lead time, retention.
NEXUS_AUTOMATION_MAX_DEPTH = env_int("NEXUS_AUTOMATION_MAX_DEPTH", 3)
NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR = env_int("NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR", 300)
NEXUS_AUTOMATION_REMINDER_MINUTES = env_int("NEXUS_AUTOMATION_REMINDER_MINUTES", 60)
NEXUS_AUTOMATION_RETENTION_DAYS = env_int("NEXUS_AUTOMATION_RETENTION_DAYS", 90)

# --- Nexus integrations (Gmail, GoHighLevel, Slack; apps/integrations, docs/nexus/INTEGRATIONS.md) ----
# Provider tokens are encrypted with AES-256-GCM. NEXUS_INTEGRATIONS_KEY (secret file
# NEXUS_INTEGRATIONS_KEY_FILE; env only with LUMEN_ALLOW_ENV_SECRETS in development) holds one or
# more 32-byte keys as 64 hex characters, separated by commas or newlines: the first encrypts,
# all decrypt (key rotation). Without a key no integration can be connected.
NEXUS_INTEGRATIONS_KEYS = [k for k in re.split(r"[\s,]+", secret("NEXUS_INTEGRATIONS_KEY")) if k]
# Local fake providers for demos and tests; refused unless NEXUS_ENVIRONMENT is development/test.
NEXUS_INTEGRATIONS_MOCK = env_bool("NEXUS_INTEGRATIONS_MOCK", False)
NEXUS_GOOGLE_CLIENT_ID = env("NEXUS_GOOGLE_CLIENT_ID", "")
NEXUS_GOOGLE_CLIENT_SECRET = secret("NEXUS_GOOGLE_CLIENT_SECRET") if SURFACE in {"public", "worker", "test"} else ""
NEXUS_SLACK_CLIENT_ID = env("NEXUS_SLACK_CLIENT_ID", "")
NEXUS_SLACK_CLIENT_SECRET = secret("NEXUS_SLACK_CLIENT_SECRET") if SURFACE in {"public", "worker", "test"} else ""
NEXUS_SLACK_SIGNING_SECRET = secret("NEXUS_SLACK_SIGNING_SECRET") if SURFACE in {"public", "test"} else ""
NEXUS_GHL_CLIENT_ID = env("NEXUS_GHL_CLIENT_ID", "")
NEXUS_GHL_CLIENT_SECRET = secret("NEXUS_GHL_CLIENT_SECRET") if SURFACE in {"public", "worker", "test"} else ""
NEXUS_GHL_APP_ID = env("NEXUS_GHL_APP_ID", "")  # for the documented uninstall call on disconnect (optional)
# HighLevel API "Version" header; the docs' latest published version (verified 2026-10-17).
NEXUS_GHL_API_VERSION = env("NEXUS_GHL_API_VERSION", "v3")
# Ed25519 public key for X-GHL-Signature, as published in HighLevel's Webhook Integration Guide.
NEXUS_GHL_WEBHOOK_PUBLIC_KEY = env(
    "NEXUS_GHL_WEBHOOK_PUBLIC_KEY",
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----",
)
NEXUS_INTEGRATIONS_SYNC_SECONDS = env_int("NEXUS_INTEGRATIONS_SYNC_SECONDS", 300)
# Retention of synced external content (docs/nexus/INTEGRATIONS.md, "What is stored").
NEXUS_GMAIL_RETENTION_DAYS = env_int("NEXUS_GMAIL_RETENTION_DAYS", 90)
NEXUS_SLACK_RETENTION_DAYS = env_int("NEXUS_SLACK_RETENTION_DAYS", 30)
NEXUS_GHL_RETENTION_DAYS = env_int("NEXUS_GHL_RETENTION_DAYS", 90)

# --- Sessions, cookies, CSRF ------------------------------------------------------------
_cookie_prefix = "" if INSECURE_DEV else "__Host-"
SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_NAME = f"{_cookie_prefix}lumen_{'ops_' if SURFACE == 'ops' else ''}session"
SESSION_COOKIE_SECURE = not INSECURE_DEV
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = env_int("SESSION_ABSOLUTE_SECONDS", 7 * 24 * 3600 if SURFACE != "ops" else 8 * 3600)
SESSION_IDLE_TIMEOUT = env_int("SESSION_IDLE_SECONDS", 12 * 3600 if SURFACE != "ops" else 30 * 60)
CSRF_COOKIE_NAME = f"{_cookie_prefix}lumen_csrf"
CSRF_COOKIE_SECURE = not INSECURE_DEV
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Strict"
CSRF_FAILURE_VIEW = "apps.core.views.csrf_failure"

# --- Transport / headers -----------------------------------------------------------
# Caddy is the only ingress and overwrites X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
# URL scheme of the Lumen mobile/desktop apps (SSO returns to <scheme>:/sso-callback).
APP_URL_SCHEME = env("APP_URL_SCHEME", "io.lumen.secure")
if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_-]*)+", APP_URL_SCHEME, re.I):
    raise ImproperlyConfigured("APP_URL_SCHEME must be a reverse-DNS URL scheme")

SECURE_CSP = {
    "default-src": [CSP.SELF],
    "script-src": [CSP.SELF],
    "style-src": [CSP.SELF],
    "img-src": [CSP.SELF, "data:"],
    "font-src": [CSP.SELF],
    "connect-src": [CSP.SELF],
    "object-src": [CSP.NONE],
    "base-uri": [CSP.NONE],
    "frame-ancestors": [CSP.NONE],
    # OIDC: the sign-in/consent POST redirects through the homeserver callback to the client:
    # the web app, or a native/desktop app's private-use scheme (browsers apply form-action
    # to every redirect that follows a form submission).
    "form-action": [CSP.SELF, MATRIX_BASE_URL, APP_BASE_URL, f"{APP_URL_SCHEME}:"] + (
        ["https://checkout.stripe.com", "https://billing.stripe.com"] if env("BILLING_PROVIDER", "none") == "stripe" else []
    ),
}

DATA_UPLOAD_MAX_MEMORY_SIZE = 1 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 1 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 200

# --- I18N / static ------------------------------------------------------------------
LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = Path(env("STATIC_ROOT", str(BASE_DIR / "staticfiles")))
STATICFILES_DIRS = [BASE_DIR / "static"]
DESIGN_DIR = Path(env("LUMEN_DESIGN_DIR", str(BASE_DIR.parent.parent / "design")))
if DESIGN_DIR.is_dir():
    STATICFILES_DIRS.append(("design", DESIGN_DIR))
BRANDING_DIR = Path(env("LUMEN_BRANDING_DIR", str(BASE_DIR.parent.parent / "branding")))
# The bundled brand is also a static prefix, so a dev server without Caddy can use
# BRAND_ASSET_URL=/static/brand/ (in production Caddy serves the operator's /brand/).
if BRANDING_DIR.is_dir():
    STATICFILES_DIRS.append(("brand", BRANDING_DIR))
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
if env_bool("LUMEN_SIMPLE_STATIC"):
    STORAGES["staticfiles"] = {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}
# Brand overrides (theme.css, logo.svg) are served by Caddy at /brand/.
BRAND_ASSET_URL = env("BRAND_ASSET_URL", "/brand/")

# --- Matrix / homeserver --------------------------------------------------------------
SYNAPSE_INTERNAL_URL = env("SYNAPSE_INTERNAL_URL", "http://synapse:8008")
SYNAPSE_ADMIN_TOKEN = secret("SYNAPSE_ADMIN_TOKEN") if SURFACE in {"ops", "worker", "test"} else ""
INTERNAL_API_TOKEN = secret("INTERNAL_API_TOKEN") if SURFACE in {"ops", "test"} else ""
OPS_GATEWAY_SECRET = secret("OPS_GATEWAY_SECRET") if SURFACE in {"ops", "test"} else ""
FEDERATION_MODE = env("FEDERATION_MODE", "open")  # open | allowlist | closed
FEDERATION_ALLOWLIST = env_list("FEDERATION_ALLOWLIST")
FEDERATION_PROBE_NOTARY = env("FEDERATION_PROBE_NOTARY", "")
TLS_MODE = env("TLS_MODE", "acme")  # acme (public CA) | internal (Caddy local CA, test/lab only)
CALLS_ENABLED = env_bool("CALLS_ENABLED", True)
RTC_DOMAIN = env("LUMEN_RTC_DOMAIN", f"rtc.{PRIMARY_DOMAIN}")
CALLS_PUBLIC_IP = env("CALLS_PUBLIC_IP", "")
CALLS_UDP_PORTS = env("CALLS_UDP_PORTS", "7882-7889")
CALLS_TCP_PORT = env_int("CALLS_TCP_PORT", 7881)
CALLS_TURN_UDP_PORT = env_int("CALLS_TURN_UDP_PORT", 3478)
# Inside the worker container: the host as seen from the rtc Docker network.
RTC_GATEWAY_IP = env("RTC_GATEWAY_IP", "")
LKJWT_INTERNAL_URL = env("LKJWT_INTERNAL_URL", "http://lkjwt:8080")
PRESENCE_ENABLED = env_bool("PRESENCE_ENABLED", True)
DEFAULT_MAX_UPLOAD_MB = env_int("DEFAULT_MAX_UPLOAD_MB", 50)

# --- Billing ---------------------------------------------------------------------------
BILLING_PROVIDER = env("BILLING_PROVIDER", "none")  # none | manual | stripe
BILLING_CURRENCY = env("BILLING_CURRENCY", "usd")
BILLING_GRACE_DAYS = env_int("BILLING_GRACE_DAYS", 14)
STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY") if BILLING_PROVIDER == "stripe" and SURFACE != "ops" else ""
STRIPE_WEBHOOK_SECRET = secret("STRIPE_WEBHOOK_SECRET") if BILLING_PROVIDER == "stripe" and SURFACE != "ops" else ""
STRIPE_PUBLISHABLE_KEY = env("STRIPE_PUBLISHABLE_KEY", "")
PLANS_FILE = Path(env("LUMEN_PLANS_FILE", str(BASE_DIR / "config" / "plans.yml")))
FREE_WORKSPACES_PER_USER = env_int("FREE_WORKSPACES_PER_USER", 1)

# --- Operations ---------------------------------------------------------------------------
HOST_AGENT_SOCKET = env("HOST_AGENT_SOCKET", "/run/lumen-agent/agent.sock")
STATUS_DIR = Path(env("LUMEN_STATUS_DIR", "/var/lib/lumen/status"))
WIREGUARD_ENABLED = env_bool("WIREGUARD_ENABLED", True)
OPS_REQUIRE_MFA = env_bool("OPS_REQUIRE_MFA", True)
OPS_STEP_UP_SECONDS = env_int("OPS_STEP_UP_SECONDS", 300)
RETENTION = {
    "security_events_days": env_int("RETENTION_SECURITY_EVENTS_DAYS", 90),
    "audit_days": env_int("RETENTION_AUDIT_DAYS", 365),
    "health_days": env_int("RETENTION_HEALTH_DAYS", 14),
    "webhook_days": env_int("RETENTION_WEBHOOK_DAYS", 90),
    "deletion_grace_days": env_int("ACCOUNT_DELETION_GRACE_DAYS", 7),
    "support_days": env_int("RETENTION_SUPPORT_DAYS", 365),
}
PUBLIC_STATUS_PAGE = env_bool("PUBLIC_STATUS_PAGE", True)

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"redact": {"()": "apps.core.logging.RedactFilter"}},
    "formatters": {
        "plain": {"format": "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "plain",
            "filters": ["redact"],
        }
    },
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {
        "django.security": {"level": "WARNING"},
        "django.db.backends": {"level": "WARNING"},
    },
}
