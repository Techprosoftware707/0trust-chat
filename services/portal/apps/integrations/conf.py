"""Provider catalog, configuration state and setup instructions.

Verified against the providers' official documentation on 2026-10-17; the URLs and what was
checked are listed in docs/nexus/INTEGRATIONS.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from django.conf import settings

from . import crypto
from .models import IntegrationConnection, Provider

MOCK_LABEL = "Mock provider (development)"

# --- endpoints (official, documented) ---------------------------------------------------------

GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"  # nosec B105 - an endpoint URL, not a secret
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
SLACK_API = "https://slack.com/api"

GHL_AUTHORIZE_URL = "https://marketplace.gohighlevel.com/v2/oauth/chooselocation"
GHL_API = "https://services.leadconnectorhq.com"
GHL_TOKEN_URL = f"{GHL_API}/oauth/token"  # nosec B105 - an endpoint URL, not a secret

# --- least-privilege scopes ----------------------------------------------------------------------

GMAIL_SCOPES = [
    # Restricted scopes: production use needs Google's OAuth app verification and, because
    # restricted-scope data is stored/transmitted by a server, a security assessment.
    ("https://www.googleapis.com/auth/gmail.readonly",
     "Read thread and message metadata, search with Gmail's query syntax, open bodies and attachments on demand."),
    ("https://www.googleapis.com/auth/gmail.compose", "Create reply drafts, and send a draft after you review and confirm it."),
]
SLACK_BOT_SCOPES = [
    ("channels:read", "List public channels so an admin can pick which ones to bring in."),
    ("channels:history", "Read messages of the public channels the bot was invited to and an admin selected."),
    ("chat:write", "Post to a selected channel, only after you confirm."),
    ("users:read", "Show people's names instead of member IDs."),
]
SLACK_PRIVATE_SCOPES = [
    ("groups:read", "Optional: list private channels the bot was invited to (admin opt-in)."),
    ("groups:history", "Optional: read the private channels an admin selected."),
]
GHL_SCOPES = [
    ("contacts.readonly", "Search contacts and show their tasks and appointments."),
    ("contacts.write", "Create or update a contact, only after you confirm."),
    ("opportunities.readonly", "Show opportunities and pipelines as external records."),
    ("conversations.readonly", "List conversations in the inbox (read-only)."),
    ("conversations/message.readonly", "Read the messages of a conversation (read-only)."),
    ("locations.readonly", "Show the connected sub-account's name."),
    ("locations/tags.readonly", "Show tags."),
    ("locations/customFields.readonly", "Show custom fields."),
    ("workflows.readonly", "List workflows (starting one stays off unless an admin enables it)."),
]


@dataclass(frozen=True)
class EnvVar:
    name: str
    secret: bool
    is_set: bool
    note: str = ""


@dataclass
class ProviderSpec:
    id: str
    label: str
    description: str
    scope: str  # personal | workspace
    auth_methods: list[str]
    scopes: list[tuple[str, str]]
    steps: list[str] = field(default_factory=list)
    docs_url: str = ""
    open_label: str = ""


def mock_mode() -> bool:
    """Local fake providers: only when explicitly enabled AND not in production."""
    return bool(settings.NEXUS_INTEGRATIONS_MOCK) and settings.NEXUS_ENVIRONMENT in {"development", "test"}


def mock_refused() -> bool:
    return bool(settings.NEXUS_INTEGRATIONS_MOCK) and settings.NEXUS_ENVIRONMENT == "production"


def base_url() -> str:
    return settings.PUBLIC_BASE_URL.rstrip("/")


CALLBACK_SLUG = {Provider.GMAIL: "google", Provider.SLACK: "slack", Provider.GOHIGHLEVEL: "crm-connector"}
SLUG_PROVIDER = {v: k for k, v in CALLBACK_SLUG.items()}


def redirect_uri(provider: str) -> str:
    return f"{base_url()}/integrations/oauth/{CALLBACK_SLUG[provider]}/callback"


def webhook_url(provider: str) -> str:
    return {
        Provider.SLACK: f"{base_url()}/integrations/webhooks/slack/events",
        Provider.GOHIGHLEVEL: f"{base_url()}/integrations/webhooks/gohighlevel",
    }.get(provider, "")


def app_url(hash_path: str = "#/integrations") -> str:
    return f"{settings.APP_BASE_URL.rstrip('/')}/{hash_path}"


def env_vars(provider: str) -> list[EnvVar]:
    s = settings
    common = [EnvVar("NEXUS_INTEGRATIONS_KEY", True, crypto.key_configured(), "64 hex characters; the installer generates it.")]
    if provider == Provider.GMAIL:
        return common + [
            EnvVar("NEXUS_GOOGLE_CLIENT_ID", False, bool(s.NEXUS_GOOGLE_CLIENT_ID)),
            EnvVar("NEXUS_GOOGLE_CLIENT_SECRET", True, bool(s.NEXUS_GOOGLE_CLIENT_SECRET)),
        ]
    if provider == Provider.SLACK:
        return common + [
            EnvVar("NEXUS_SLACK_CLIENT_ID", False, bool(s.NEXUS_SLACK_CLIENT_ID)),
            EnvVar("NEXUS_SLACK_CLIENT_SECRET", True, bool(s.NEXUS_SLACK_CLIENT_SECRET)),
            EnvVar("NEXUS_SLACK_SIGNING_SECRET", True, bool(s.NEXUS_SLACK_SIGNING_SECRET)),
        ]
    return common + [
        EnvVar("NEXUS_GHL_CLIENT_ID", False, bool(s.NEXUS_GHL_CLIENT_ID), "Only for the marketplace-app (OAuth) flow."),
        EnvVar("NEXUS_GHL_CLIENT_SECRET", True, bool(s.NEXUS_GHL_CLIENT_SECRET), "Only for the marketplace-app (OAuth) flow."),
        EnvVar("NEXUS_GHL_APP_ID", False, bool(s.NEXUS_GHL_APP_ID), "Optional: lets disconnect uninstall the app."),
    ]


def oauth_configured(provider: str) -> bool:
    s = settings
    if provider == Provider.GMAIL:
        return bool(s.NEXUS_GOOGLE_CLIENT_ID and s.NEXUS_GOOGLE_CLIENT_SECRET)
    if provider == Provider.SLACK:
        return bool(s.NEXUS_SLACK_CLIENT_ID and s.NEXUS_SLACK_CLIENT_SECRET and s.NEXUS_SLACK_SIGNING_SECRET)
    if provider == Provider.GOHIGHLEVEL:
        return bool(s.NEXUS_GHL_CLIENT_ID and s.NEXUS_GHL_CLIENT_SECRET)
    return False


def available_methods(provider: str) -> list[str]:
    """Connection methods that work right now (mock mode makes OAuth work with fakes)."""
    if not crypto.key_configured():
        return []
    methods = []
    if mock_mode() or oauth_configured(provider):
        methods.append(IntegrationConnection.AuthMethod.OAUTH)
    if provider == Provider.GOHIGHLEVEL:
        methods.append(IntegrationConnection.AuthMethod.PRIVATE_TOKEN)
    return methods


SPECS: dict[str, ProviderSpec] = {
    Provider.GMAIL: ProviderSpec(
        id=Provider.GMAIL,
        label="Gmail",
        description=("Your mailbox in the inbox: thread metadata and snippets sync; bodies and attachments open on demand. Replies "
                     "are drafted in Gmail and sent only after you confirm."),
        scope=IntegrationConnection.Scope.PERSONAL,
        auth_methods=[IntegrationConnection.AuthMethod.OAUTH],
        scopes=GMAIL_SCOPES,
        steps=[
            "In Google Cloud Console, create (or pick) a project and enable the Gmail API.",
            "Configure the OAuth consent screen (Google Auth Platform → Branding/Audience/Data access) and add the two Gmail scopes listed here.",
            "Create an OAuth client ID of type “Web application” with the authorized redirect URI shown here.",
            ("Store the client ID in lumen.conf (NEXUS_GOOGLE_CLIENT_ID) and the secret with: sudo ./lumenctl set-secret "
             "nexus_google_client_secret; then sudo ./lumenctl apply."),
            ("Gmail scopes are restricted: before real customers use it, Google must verify the app (and a security "
             "assessment is required). While the app is in “Testing”, refresh tokens expire after 7 days."),
        ],
        docs_url="https://developers.google.com/identity/protocols/oauth2/web-server",
        open_label="Open in Gmail",
    ),
    Provider.GOHIGHLEVEL: ProviderSpec(
        id=Provider.GOHIGHLEVEL,
        label="GoHighLevel",
        description=("Contacts, opportunities, pipelines, conversations, tasks and appointments of one sub-account, shown as "
                     "external records. Changes are made only after you confirm."),
        scope=IntegrationConnection.Scope.WORKSPACE,
        auth_methods=[IntegrationConnection.AuthMethod.OAUTH, IntegrationConnection.AuthMethod.PRIVATE_TOKEN],
        scopes=GHL_SCOPES,
        steps=[
            ("Either: create a Marketplace app (Target user: Sub-account) in the HighLevel developer portal, add the "
             "redirect URL and webhook URL shown here, select the scopes listed here, and generate a client ID and secret."),
            ("Store the client ID (and optionally the app ID) in lumen.conf (NEXUS_GHL_CLIENT_ID, NEXUS_GHL_APP_ID) and the "
             "secret with: sudo ./lumenctl set-secret nexus_ghl_client_secret; then sudo ./lumenctl apply."),
            ("Or: in the sub-account's Settings → Private Integrations, create a token with the scopes listed here and "
             "paste it below with the location ID (no app needed; it does not refresh, rotate it every 90 days)."),
        ],
        docs_url="https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0",
        open_label="Open in HighLevel",
    ),
    Provider.SLACK: ProviderSpec(
        id=Provider.SLACK,
        label="Slack",
        description="Messages of the channels an admin selects (the bot must be invited), mentions and permalinks. Posting needs your confirmation every time.",
        scope=IntegrationConnection.Scope.WORKSPACE,
        auth_methods=[IntegrationConnection.AuthMethod.OAUTH],
        scopes=SLACK_BOT_SCOPES,
        steps=[
            ("Create a Slack app (api.slack.com/apps) for your Slack workspace; add the bot scopes listed here under OAuth "
             "& Permissions, and the redirect URL shown here."),
            ("Under Event Subscriptions, enable events with the request URL shown here and subscribe to the bot events "
             "message.channels (and message.groups only if you opt in to private channels)."),
            ("Store the client ID in lumen.conf (NEXUS_SLACK_CLIENT_ID) and the client secret and signing secret with: sudo "
             "./lumenctl set-secret nexus_slack_client_secret and nexus_slack_signing_secret; then sudo ./lumenctl apply."),
            "After connecting, invite the bot to each channel (/invite @your-app) and select the channels here.",
        ],
        docs_url="https://docs.slack.dev/authentication/installing-with-oauth",
        open_label="Open in Slack",
    ),
}


def spec(provider: str) -> ProviderSpec:
    try:
        return SPECS[provider]
    except KeyError:
        raise LookupError(provider) from None
