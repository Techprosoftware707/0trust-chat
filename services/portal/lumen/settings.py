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

from pathlib import Path

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
BRAND = {
    "name": env("BRAND_NAME", "Lumen Secure"),
    "short_name": env("BRAND_SHORT_NAME", "Lumen"),
    "tagline": env("BRAND_TAGLINE", "Private conversations on an open, federated network."),
    "legal_name": env("BRAND_LEGAL_NAME", "The Lumen Secure operator"),
    "jurisdiction": env("BRAND_JURISDICTION", ""),
    "support_email": env("SUPPORT_EMAIL", f"support@{PRIMARY_DOMAIN}"),
    "security_email": env("SECURITY_EMAIL", f"security@{PRIMARY_DOMAIN}"),
    "privacy_email": env("PRIVACY_EMAIL", f"privacy@{PRIMARY_DOMAIN}"),
}

# --- Applications --------------------------------------------------------------
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
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "apps.core.middleware.RequestContextMiddleware",
    "apps.core.middleware.SurfaceGuardMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "allauth.usersessions.middleware.UserSessionsMiddleware",
    "apps.core.middleware.SessionIdleTimeoutMiddleware",
    "apps.core.middleware.AccountStatusMiddleware",
    "apps.ops.middleware.OpsAccessMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
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
        "CONN_MAX_AGE": 60,
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
ACCOUNT_EMAIL_SUBJECT_PREFIX = f"[{BRAND['short_name']}] "
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
# Only confidential clients posting their secret. (client_secret_basic is not
# offered: with oauthlib's OIDC dispatcher it yields token responses without an
# id_token, because the code lookup needs client_id in the request body.)
IDP_OIDC_AUTH_METHODS = ["client_secret_post"]
SYNAPSE_OIDC_CLIENT_ID = env("SYNAPSE_OIDC_CLIENT_ID", "lumen-synapse")
SYNAPSE_OIDC_CLIENT_SECRET = secret("SYNAPSE_OIDC_CLIENT_SECRET") if SURFACE in {"public", "test"} else ""

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
    # OIDC: the consent POST redirects to the homeserver callback.
    "form-action": [CSP.SELF, MATRIX_BASE_URL, APP_BASE_URL] + (
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
VOIP_ENABLED = env_bool("VOIP_ENABLED", False)
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
WIREGUARD_ENABLED = env_bool("WIREGUARD_ENABLED", False)
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
