"""OAuth connection flow (authorization-code grant, server-side, confidential client).

1. ``start`` (bearer API, ``POST .../integrations/connections/oauth-start``): checks the
   person may connect this provider, creates an ``OAuthState`` (nonce stored hashed, PKCE
   verifier encrypted, 10-minute expiry) and returns a portal URL ``/integrations/oauth/begin``
   carrying the signed state.
2. ``begin`` (portal session): the browser must be signed in to the portal as the same person;
   a random binding is put into that session (its hash on the state row), then the browser is
   sent to the provider with ``state`` (and the PKCE challenge where supported).
3. ``complete`` (the provider's redirect): verifies the signature and expiry of ``state``,
   that the nonce exists, is unexpired and unused, that the session holds the binding and is
   the same person, and that the person is still allowed to connect in that workspace; marks
   the state used (single-use, atomically), exchanges the code with the client secret and the
   PKCE verifier, stores the tokens encrypted and redirects back to the app.

Any failure redirects to the app with an error code only; nothing from the provider is echoed.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta

from django.core import signing
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.crm import access
from apps.crm.access import Cap

from . import conf, crypto
from .http import ProviderError
from .models import IntegrationConnection, OAuthState, Provider
from .providers import OAuthFailed, adapter_for
from .tokens import store_tokens

STATE_SALT = "nexus.integrations.oauth-state"
STATE_MAX_AGE = 600
SESSION_KEY = "nexus_integrations_oauth"


class FlowError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def pkce_pair() -> tuple[str, str]:
    """(verifier, S256 challenge) per RFC 7636."""
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def can_connect(actor: access.Actor, provider: str) -> bool:
    if conf.spec(provider).scope == IntegrationConnection.Scope.WORKSPACE:
        return actor.can(Cap.INTEGRATIONS_OWN)
    # Personal mailboxes: anyone who works with records (not read-only people).
    return actor.view_level != "none" and actor.role != "readonly"


def require_can_connect(actor: access.Actor, provider: str) -> None:
    from django.core.exceptions import PermissionDenied

    if not can_connect(actor, provider):
        if conf.spec(provider).scope == IntegrationConnection.Scope.WORKSPACE:
            raise PermissionDenied("Only workspace owners and admins can connect this integration.")
        raise PermissionDenied("Your role can't connect a mailbox.")


@dataclass
class Started:
    state: OAuthState
    begin_url: str


def start(actor: access.Actor, provider: str, *, reconnect: IntegrationConnection | None = None, options: dict | None = None) -> Started:
    require_can_connect(actor, provider)
    if not crypto.key_configured():
        raise FlowError("encryption_key_missing", "The server has no encryption key for integrations yet (NEXUS_INTEGRATIONS_KEY).")
    if IntegrationConnection.AuthMethod.OAUTH not in conf.available_methods(provider):
        raise FlowError("not_configured", f"{conf.spec(provider).label} isn't set up on this server yet. See the setup steps.")
    nonce = secrets.token_urlsafe(32)
    verifier = None
    adapter = adapter_for(provider)
    if adapter.uses_pkce:
        verifier, _ = pkce_pair()
    with transaction.atomic():
        state = OAuthState.objects.create(
            nonce_hash=_hash(nonce), provider=provider, workspace=actor.workspace, user=actor.user, reconnect=reconnect,
            expires_at=timezone.now() + timedelta(seconds=STATE_MAX_AGE),
        )
        if verifier:
            state.pkce_verifier = crypto.encrypt(verifier, aad=f"oauth-state:{state.pk}:pkce")
            state.save(update_fields=["pkce_verifier"])
    token = signing.dumps({"n": nonce, "p": provider, "w": str(actor.workspace_id), "u": str(actor.user.public_id),
                           "o": {k: bool(v) for k, v in (options or {}).items() if k in {"private_channels"}}},
                          salt=STATE_SALT, compress=False)
    return Started(state=state, begin_url=f"{conf.base_url()}/integrations/oauth/begin?{_q({'s': token})}")


def _q(params: dict) -> str:
    from urllib.parse import urlencode

    return urlencode(params)


def _load(token: str) -> dict:
    try:
        data = signing.loads(token, salt=STATE_SALT, max_age=STATE_MAX_AGE)
    except signing.SignatureExpired:
        raise FlowError("state_expired", "The connection attempt took too long. Start again.") from None
    except signing.BadSignature:
        raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.") from None
    if not isinstance(data, dict) or not {"n", "p", "w", "u"} <= set(data):
        raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.")
    return data


def _check_user(request, data: dict) -> None:
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated or str(user.public_id) != data["u"]:
        raise FlowError("wrong_user", "You're signed in to the portal as someone other than the person who started connecting. "
                                      "Sign in as yourself and start again.")


def begin(request, token: str) -> str:
    """Binds the flow to this browser session and returns the provider's authorization URL."""
    data = _load(token)
    _check_user(request, data)
    state = OAuthState.objects.filter(nonce_hash=_hash(data["n"])).select_related("workspace").first()
    if state is None or state.provider != data["p"] or str(state.workspace_id) != data["w"] or state.user_id != request.user.pk:
        raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.")
    if state.used_at or state.began_at:
        raise FlowError("state_used", "This connection link was already used. Start again from Integrations.")
    if state.expires_at <= timezone.now():
        raise FlowError("state_expired", "The connection attempt took too long. Start again.")
    binding = secrets.token_urlsafe(32)
    flows = dict(request.session.get(SESSION_KEY) or {})
    flows = {k: v for k, v in flows.items() if v.get("exp", 0) > timezone.now().timestamp()}
    flows[str(state.pk)] = {"b": binding, "p": state.provider, "exp": state.expires_at.timestamp()}
    request.session[SESSION_KEY] = flows
    updated = OAuthState.objects.filter(pk=state.pk, began_at__isnull=True, used_at__isnull=True).update(
        binding_hash=_hash(binding), began_at=timezone.now())
    if not updated:
        raise FlowError("state_used", "This connection link was already used. Start again from Integrations.")
    adapter = adapter_for(state.provider)
    challenge = None
    if adapter.uses_pkce and state.pkce_verifier:
        verifier = crypto.decrypt(state.pkce_verifier, aad=f"oauth-state:{state.pk}:pkce")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    options = dict(data.get("o") or {})
    if state.provider == Provider.GMAIL and state.reconnect_id:
        options["login_hint"] = state.reconnect.account_id
    return adapter.authorization_url(state=token, redirect_uri=conf.redirect_uri(state.provider), code_challenge=challenge, options=options)


def _state_from_session(request, provider: str) -> tuple[OAuthState, str] | None:
    """HighLevel documents no ``state`` round trip: accept the single pending flow of this
    provider bound to this browser session and person (and nothing else)."""
    flows = request.session.get(SESSION_KEY) or {}
    now = timezone.now().timestamp()
    pending = [(k, v) for k, v in flows.items() if v.get("p") == provider and v.get("exp", 0) > now]
    if len(pending) != 1:
        return None
    state = OAuthState.objects.filter(pk=pending[0][0], user_id=request.user.pk, provider=provider).first()
    return (state, pending[0][1]["b"]) if state else None


def complete(request, provider: str, *, code: str, token: str | None, error: str | None) -> IntegrationConnection:
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        raise FlowError("not_signed_in", "Sign in to the portal, then start connecting again.")
    data = None
    if token:
        data = _load(token)
        if data["p"] != provider:
            raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.")
        _check_user(request, data)
        state = OAuthState.objects.filter(nonce_hash=_hash(data["n"])).first()
        binding = ((request.session.get(SESSION_KEY) or {}).get(str(state.pk)) or {}).get("b") if state else None
    elif provider == Provider.GOHIGHLEVEL:
        found = _state_from_session(request, provider)
        state, binding = found if found else (None, None)
    else:
        raise FlowError("state_missing", "The provider didn't send the connection state back. Start again.")
    if state is None or state.user_id != user.pk or state.provider != provider:
        raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.")
    if data is not None and str(state.workspace_id) != data["w"]:
        raise FlowError("state_invalid", "The connection link isn't valid. Start again from Integrations.")
    if not binding or not state.binding_hash or not secrets.compare_digest(_hash(binding), state.binding_hash):
        raise FlowError("session_mismatch", "This connection was started in another browser or session. Start again here.")
    if state.expires_at <= timezone.now():
        raise FlowError("state_expired", "The connection attempt took too long. Start again.")
    # Single use: only the first callback for this state proceeds.
    if not OAuthState.objects.filter(pk=state.pk, used_at__isnull=True).update(used_at=timezone.now()):
        raise FlowError("state_used", "This connection link was already used. Start again from Integrations.")
    flows = dict(request.session.get(SESSION_KEY) or {})
    flows.pop(str(state.pk), None)
    request.session[SESSION_KEY] = flows
    if error:
        raise FlowError("access_denied" if error == "access_denied" else "provider_error",
                        "You didn't allow access, so nothing was connected." if error == "access_denied"
                        else "The provider reported an error. Nothing was connected.")
    if not code or len(code) > 2048:
        raise FlowError("code_missing", "The provider didn't send an authorization code. Start again.")
    actor = access.actor_for(user, state.workspace_id)  # 404 if no longer a member
    require_can_connect(actor, provider)
    adapter = adapter_for(provider)
    verifier = crypto.decrypt(state.pkce_verifier, aad=f"oauth-state:{state.pk}:pkce") if state.pkce_verifier else None
    try:
        tokens, raw = adapter.exchange_code(code, redirect_uri=conf.redirect_uri(provider), code_verifier=verifier)
        info = adapter.identify(tokens, raw)
    except OAuthFailed as exc:
        raise FlowError(exc.code, exc.message) from None
    except ProviderError as exc:
        raise FlowError(exc.code, exc.message) from None
    return save_connection(request, actor, provider, info, tokens, auth_method=IntegrationConnection.AuthMethod.OAUTH,
                           reconnect=state.reconnect)


def save_connection(request, actor, provider: str, info, tokens, *, auth_method: str, reconnect: IntegrationConnection | None = None) -> IntegrationConnection:
    spec = conf.spec(provider)
    if reconnect is not None and reconnect.account_id != info.account_id:
        raise FlowError("wrong_account", f"You signed in to a different account ({info.label}) than the one being reconnected ({reconnect.account_label}).")
    try:
        with transaction.atomic():
            conn = (IntegrationConnection.objects.select_for_update()
                    .filter(workspace=actor.workspace, provider=provider, account_id=info.account_id)
                    .exclude(status=IntegrationConnection.Status.DISCONNECTED).first())
            if conn is not None and spec.scope == IntegrationConnection.Scope.PERSONAL and conn.owner_id != actor.user.pk:
                raise FlowError("account_in_use", "Someone else in this workspace already connected that mailbox.")
            created = conn is None
            if conn is None:
                conn = IntegrationConnection(workspace=actor.workspace, provider=provider, account_id=info.account_id, created_by=actor.user,
                                             scope=spec.scope, owner=actor.user, settings=info.settings, sync_state=info.sync_state)
            else:
                conn.settings = {**info.settings, **(conn.settings or {})}
                conn.sync_state = {**(conn.sync_state or {}), **info.sync_state}
            conn.account_label = info.label[:255]
            conn.granted_scopes = list(info.scopes or [])
            conn.status = IntegrationConnection.Status.CONNECTED
            conn.auth_method = auth_method
            conn.is_mock = conf.mock_mode()
            conn.is_demo = conn.is_mock
            conn.last_error_code = conn.last_error_message = ""
            conn.last_error_at = None
            conn.failure_count = 0
            conn.next_sync_at = timezone.now()
            if created:
                conn.connected_at = timezone.now()
            conn.save()
            store_tokens(conn, tokens, keep_refresh=False)
            access.audit_write(request, actor, "connect" if created else "reconnect", conn, fields=["provider", "account", "scopes"],
                               extra={"provider": provider, "mock": conn.is_mock})
    except IntegrityError:
        raise FlowError("account_in_use", "That account is already connected in this workspace.") from None
    return conn


def purge_expired() -> int:
    deleted, _ = OAuthState.objects.filter(expires_at__lt=timezone.now() - timedelta(hours=1)).delete()
    return deleted
