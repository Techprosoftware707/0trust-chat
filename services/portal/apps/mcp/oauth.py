"""OAuth for the Claude MCP connector, built on the portal's own provider (allauth.idp.oidc).

What this adds to the existing authorization server:

* **Resource binding (RFC 8707).** The MCP server's resource is ``NEXUS_MCP_RESOURCE``
  (``<LUMEN_PUBLIC_BASE_URL>/mcp``). MCP clients must send exactly that ``resource`` in the
  authorization request (and, if at all, in the token request); their tokens carry it and
  ``/mcp`` accepts only tokens bound to it (canonical comparison). Other clients may not
  ask for it, and the API at ``/api/v1`` refuses MCP tokens (different resource).
* **PKCE S256 for every MCP client**, and ``plain`` refused for every client.
* **``iss`` in every authorization response** (RFC 9207), success or error.
* **Dynamic Client Registration (RFC 7591)** at ``/identity/o/api/register`` with a
  redirect-URI policy (Claude's callbacks, loopback on any port, an operator allow-list),
  per-IP rate limits, a cap on unused registrations and clean-up (``jobs.py``).
* **Client ID Metadata Documents** (``cimd.py``), fetched with SSRF protection.
* **Refresh token rotation with reuse detection**: a rotated refresh token used again
  revokes the connection (``invalid_grant``).
* **A consent screen** showing the client, the redirect host, a warning for loopback-only
  clients, the scopes and the workspace the connection may use.
* **Metadata**: RFC 8414 fields added to the discovery documents.

The MCP server itself (``server.py``/``views.py``) validates tokens with the foundation's
``apps.api.auth.authenticate_bearer`` and ``mcp_policy()``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from allauth.idp.oidc.models import Client, Token
from allauth.idp.oidc.views import AuthorizationView, ClientRegistrationView
from allauth.idp.oidc.views import token as allauth_token
from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from apps.api.auth import TokenPolicy
from apps.core import ratelimit
from apps.core.audit import audit, security_event

log = logging.getLogger("nexus.mcp")

SCOPE_READ, SCOPE_WRITE = "mcp:read", "mcp:write"
MCP_SCOPE_LIST = [SCOPE_READ, SCOPE_WRITE]
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


# --- resource and policy ---------------------------------------------------------------------


def canonical(uri: str) -> str:
    """Canonical form of a resource URI (RFC 8707 / MCP): lowercase scheme and host, no
    default port, no fragment, no trailing slash."""
    try:
        p = urlsplit(uri.strip())
    except ValueError:
        return ""
    if not p.scheme or not p.hostname:
        return ""
    scheme = p.scheme.lower()
    host = p.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    port = p.port
    netloc = host if port is None or (scheme, port) in {("https", 443), ("http", 80)} else f"{host}:{port}"
    path = p.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, p.query, ""))


def mcp_resource() -> str:
    return canonical(settings.NEXUS_MCP_RESOURCE)


def is_mcp_resource(uri: str) -> bool:
    return bool(uri) and canonical(uri) == mcp_resource()


def mcp_policy() -> TokenPolicy:
    return TokenPolicy(name="mcp", resource=settings.NEXUS_MCP_RESOURCE, allowed_client_ids=None, realm="nexus-mcp")


def issuer() -> str:
    return settings.PUBLIC_BASE_URL.rstrip("/")


def resource_metadata_url() -> str:
    path = urlsplit(settings.NEXUS_MCP_RESOURCE).path.strip("/")
    return f"{issuer()}/.well-known/oauth-protected-resource" + (f"/{path}" if path else "")


def challenge(*, error: str = "", description: str = "", scope: str = " ".join(MCP_SCOPE_LIST)) -> str:
    parts = []
    if error:
        parts.append(f'error="{error}"')
    if description:
        parts.append(f'error_description="{description}"')
    parts.append(f'resource_metadata="{resource_metadata_url()}"')
    if scope:
        parts.append(f'scope="{scope}"')
    return "Bearer " + ", ".join(parts)


# --- clients and redirect URIs ---------------------------------------------------------------


def is_mcp_client(client: Client | None) -> bool:
    return bool(client is not None and isinstance(client.data, dict) and client.data.get("mcp") is True)


def client_kind(client: Client) -> str:
    data = client.data or {}
    return "cimd" if data.get("cimd") else "dcr" if data.get("dcr") else "registered"


def is_loopback_uri(uri: str) -> bool:
    try:
        p = urlsplit(uri)
    except ValueError:
        return False
    return p.scheme == "http" and (p.hostname or "") in LOOPBACK_HOSTS


def redirect_allowed(uri: str) -> bool:
    """The redirect-URI policy for dynamically registered (DCR) and CIMD clients."""
    if not isinstance(uri, str) or len(uri) > 500 or any(c in uri for c in "\r\n\t *"):
        return False
    try:
        p = urlsplit(uri)
        p.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        return False
    if p.fragment or p.username or p.password or not p.hostname:
        return False
    if is_loopback_uri(uri):
        return settings.NEXUS_MCP_ALLOW_LOOPBACK_REDIRECTS
    if p.scheme != "https":
        return False
    return canonical(uri) in {canonical(u) for u in settings.NEXUS_MCP_REDIRECT_URIS}


def loopback_only(client: Client) -> bool:
    uris = client.get_redirect_uris()
    return bool(uris) and all(is_loopback_uri(u) for u in uris)


def redirect_hosts(client: Client) -> list[str]:
    return sorted({urlsplit(u).hostname or "" for u in client.get_redirect_uris()})


def patch_loopback_matching() -> None:
    """RFC 8252 port-agnostic loopback redirects also for ``http://localhost`` (Claude Code
    registers ``http://localhost/callback`` and ``http://127.0.0.1/callback`` and uses a
    random port). allauth treats only 127.0.0.1 and ::1 as loopback; this extends its
    single predicate. Applied once from ``McpConfig.ready()``; a test proves it is active."""
    from allauth.idp.oidc.internal import clientkit

    if getattr(clientkit.is_loopback, "_nexus", False):
        return

    def is_loopback(parsed_uri) -> bool:
        return parsed_uri.scheme == "http" and parsed_uri.hostname in LOOPBACK_HOSTS

    is_loopback._nexus = True
    clientkit.is_loopback = is_loopback


# --- server metadata (RFC 8414 additions) --------------------------------------------------------


def extend_server_metadata(data: dict) -> None:
    """Called by the OIDC adapter for both discovery documents."""
    data["authorization_response_iss_parameter_supported"] = True
    data["code_challenge_methods_supported"] = ["S256"]
    if not settings.NEXUS_MCP_ENABLED:
        return
    scopes = list(data.get("scopes_supported", []))
    data["scopes_supported"] = scopes + [s for s in MCP_SCOPE_LIST if s not in scopes]
    methods = list(data.get("token_endpoint_auth_methods_supported", []))
    if "none" not in methods:
        methods.append("none")
    data["token_endpoint_auth_methods_supported"] = methods
    data["revocation_endpoint_auth_methods_supported"] = methods
    if settings.NEXUS_MCP_DCR_ENABLED:
        data["registration_endpoint"] = f"{issuer()}/identity/o/api/register"
    if settings.NEXUS_MCP_CIMD_ENABLED:
        data["client_id_metadata_document_supported"] = True


# --- authorization endpoint ------------------------------------------------------------------------


def with_iss(location: str) -> str:
    """Adds ``iss`` (RFC 9207) to an authorization response redirect."""
    parts = urlsplit(location)
    query = parse_qsl(parts.query, keep_blank_values=True)
    if any(k == "iss" for k, _ in query):
        return location
    if not any(k in ("code", "error") for k, _ in query):
        return location
    query.append(("iss", issuer()))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def add_iss(response: HttpResponse) -> HttpResponse:
    if response.status_code in (301, 302, 303) and response.get("Location"):
        response["Location"] = with_iss(response["Location"])
    return response


def _error_redirect(redirect_uri: str, error: str, description: str, state: str) -> HttpResponse:
    params = {"error": error, "error_description": description}
    if state:
        params["state"] = state[:500]
    response = HttpResponse(status=302)
    sep = "&" if "?" in redirect_uri else "?"
    response["Location"] = with_iss(f"{redirect_uri}{sep}{urlencode(params)}")
    return response


def _error_page(request, message: str, status: int = 400) -> HttpResponse:
    from django.shortcuts import render

    return render(request, "mcp/oauth_error.html", {"message": message}, status=status)


def authorize_precheck(request) -> HttpResponse | None:
    """Runs before allauth's authorization endpoint (GET). Returns a response to stop the
    flow, or None to continue."""
    if request.method != "GET":
        return None
    from allauth.idp.oidc.internal.clientkit import is_redirect_uri_allowed

    from . import cimd

    client_id = request.GET.get("client_id", "")
    if cimd.is_cimd_url(client_id):
        if not (settings.NEXUS_MCP_ENABLED and settings.NEXUS_MCP_CIMD_ENABLED):
            return _error_page(request, "This server doesn't accept client metadata documents.")
        try:
            cimd.resolve_client(client_id, request)
        except cimd.CimdError as exc:
            return _error_page(request, f"The app asking for access couldn't be verified: {exc}")
    client = Client.objects.filter(id=client_id[:100]).first() if client_id else None
    redirect_uri = request.GET.get("redirect_uri", "")
    if client is None or not redirect_uri or not is_redirect_uri_allowed(redirect_uri, client.get_redirect_uris(), client.allow_uri_wildcards):
        return None  # allauth answers with its own error page (no redirect to unknown URIs)
    state = request.GET.get("state", "")
    if request.GET.get("code_challenge_method") == "plain":
        return _error_redirect(redirect_uri, "invalid_request", "PKCE with S256 is required.", state)
    resources = request.GET.getlist("resource")
    if is_mcp_client(client):
        if not settings.NEXUS_MCP_ENABLED:
            return _error_page(request, "The Claude connector isn't enabled on this server.")
        if not request.GET.get("code_challenge") or request.GET.get("code_challenge_method") != "S256":
            return _error_redirect(redirect_uri, "invalid_request", "PKCE with S256 is required.", state)
        if len(resources) != 1 or not is_mcp_resource(resources[0]):
            return _error_redirect(redirect_uri, "invalid_target", f"The resource must be {settings.NEXUS_MCP_RESOURCE}.", state)
        if resources[0] != settings.NEXUS_MCP_RESOURCE:
            # An equivalent spelling (case, default port, trailing slash): store the canonical one.
            query = request.GET.copy()
            query.setlist("resource", [settings.NEXUS_MCP_RESOURCE])
            request.GET = query
        if "none" in request.GET.get("prompt", "").split():
            return _error_redirect(redirect_uri, "consent_required", "This app needs your consent first.", state)
    elif any(is_mcp_resource(r) for r in resources):
        return _error_redirect(redirect_uri, "invalid_target", "This client can't request tokens for the MCP server.", state)
    return None


def eligible_workspaces(user) -> list:
    """Workspaces the person may connect: member, business workspace, connector on."""
    from apps.crm.access import Actor
    from apps.workspaces.models import Membership

    out = []
    for ms in Membership.objects.filter(user=user).select_related("workspace").order_by("workspace__name"):
        if Actor(user=user, membership=ms).features.get("mcp"):
            out.append(ms.workspace)
    return out


class McpAuthorizationView(AuthorizationView):
    """allauth's authorization view with Nexus's consent screen for MCP clients (client,
    redirect host, loopback warning, scopes, workspace choice) and the grant record."""

    mcp_template = "mcp/consent.html"

    def _client(self) -> Client | None:
        info = getattr(self, "_request_info", None) or {}
        cid = info.get("client_id") or self.request.GET.get("client_id", "")
        return Client.objects.filter(id=str(cid)[:100]).first() if cid else None

    def get_template_names(self):
        return [self.mcp_template] if is_mcp_client(self._client()) else super().get_template_names()

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        client = ctx.get("client")
        if not is_mcp_client(client):
            return ctx
        info = getattr(self, "_request_info", {}) or {}
        redirect_uri = info.get("redirect_uri") or ""
        kind = client_kind(client)
        workspaces = eligible_workspaces(self.request.user)
        ctx.update({
            "mcp_kind": kind,
            "mcp_client_host": (client.data or {}).get("host", "") if kind == "cimd" else "",
            "mcp_redirect_host": urlsplit(redirect_uri).hostname or "",
            "mcp_redirect_is_loopback": is_loopback_uri(redirect_uri),
            "mcp_loopback_only": loopback_only(client),
            "mcp_workspaces": workspaces,
            "mcp_workspace_error": getattr(self, "_workspace_error", ""),
            "mcp_url": settings.NEXUS_MCP_RESOURCE,
            "brand": settings.BRAND,
        })
        return ctx

    def render_to_response(self, context, **kwargs):
        response = super().render_to_response(context, **kwargs)
        info = getattr(self, "_request_info", {}) or {}
        redirect_uri = info.get("redirect_uri") or ""
        if redirect_uri and is_mcp_client(context.get("client")):
            # The consent form's POST redirects to the client's callback: allow exactly that
            # origin in this page's form-action (browsers apply form-action to redirects).
            p = urlsplit(redirect_uri)
            origin = f"{p.scheme}://{p.netloc}"
            config = {k: list(v) for k, v in settings.SECURE_CSP.items()}
            config["form-action"] = list(config.get("form-action", [])) + [origin]
            response._csp_config = config
        return response

    def form_valid(self, form):
        client = self._client()
        if not is_mcp_client(client):
            return super().form_valid(form)
        workspaces = {str(w.pk): w for w in eligible_workspaces(self.request.user)}
        chosen = workspaces.get(self.request.POST.get("workspace", ""))
        if chosen is None and len(workspaces) == 1:
            chosen = next(iter(workspaces.values()))
        if chosen is None:
            self._workspace_error = "Choose the workspace this connection may use." if workspaces else (
                "None of your workspaces allows the Claude connector yet.")
            return self.form_invalid(form)
        response = super().form_valid(form)
        if response.status_code in (301, 302) and "code=" in response.get("Location", ""):
            from .models import McpGrant

            scopes = sorted(set(form.cleaned_data["scopes"]) & set(MCP_SCOPE_LIST))
            McpGrant.objects.update_or_create(
                user=self.request.user, client=client,
                defaults={"workspace": chosen, "scopes": scopes, "created_by": self.request.user},
            )
            audit(self.request, "mcp.connection.grant", target_type="oidc_client", target_id=client.pk[:120], actor=self.request.user,
                  metadata={"workspace": str(chosen.pk), "scopes": scopes, "kind": client_kind(client)})
        return response


mcp_authorization = McpAuthorizationView.as_view()


# --- token endpoint ------------------------------------------------------------------------------


def _token_hash(value: str) -> str:
    from allauth.idp.oidc.adapter import get_adapter

    return get_adapter().hash_token(value)


def _oauth_error(error: str, description: str, status: int = 400) -> JsonResponse:
    resp = JsonResponse({"error": error, "error_description": description}, status=status)
    resp["Cache-Control"] = "no-store"
    resp["Pragma"] = "no-cache"
    return resp


def revoke_connection(user_id, client_id: str) -> int:
    """Deletes every token of one person for one client."""
    n, _ = Token.objects.filter(user_id=user_id, client_id=client_id).delete()
    return n


@csrf_exempt
def token_view(request):
    """Wraps allauth's token endpoint (form-urlencoded, RFC 6749) with the MCP rules."""
    if request.method != "POST":
        return allauth_token(request)
    client_id = request.POST.get("client_id", "")[:100]
    client = Client.objects.filter(id=client_id).first() if client_id else None
    resources = request.POST.getlist("resource")
    mcp = is_mcp_client(client)
    if mcp:
        if not settings.NEXUS_MCP_ENABLED:
            return _oauth_error("invalid_client", "The MCP connector is not enabled.", 401)
        if any(not is_mcp_resource(r) for r in resources):
            return _oauth_error("invalid_target", f"The resource must be {settings.NEXUS_MCP_RESOURCE}.")
        if resources and resources != [settings.NEXUS_MCP_RESOURCE]:
            form = request.POST.copy()
            form.setlist("resource", [settings.NEXUS_MCP_RESOURCE])
            request.POST = form
        if request.POST.get("grant_type") == "refresh_token":
            old = request.POST.get("refresh_token", "")
            if old:
                from .models import RotatedRefreshToken

                h = _token_hash(old)
                replay = RotatedRefreshToken.objects.filter(hash=h).first()
                if replay is not None and not Token.objects.filter(hash=h, type=Token.Type.REFRESH_TOKEN).exists():
                    n = revoke_connection(replay.user_id, replay.client_id)
                    security_event(request, "mcp_refresh_token_reuse", user=replay.user,
                                   detail={"client": replay.client_id[:60], "revoked_tokens": n})
                    return _oauth_error("invalid_grant", "This refresh token was already used; the connection was revoked for safety.")
    elif any(is_mcp_resource(r) for r in resources):
        return _oauth_error("invalid_target", "This client can't request tokens for the MCP server.")
    old_rt = request.POST.get("refresh_token", "") if mcp and request.POST.get("grant_type") == "refresh_token" else ""
    try:
        response = allauth_token(request)
    except ValidationError:
        return _oauth_error("invalid_target", "The resource is not valid.")
    if mcp and response.status_code == 200:
        response = _after_mcp_token(request, client, response, old_rt)
    return response


def _after_mcp_token(request, client: Client, response, old_rt: str):
    from .models import McpGrant, RotatedRefreshToken

    try:
        body = json.loads(response.content)
    except ValueError:
        return response
    now = timezone.now()
    access_hash = _token_hash(body.get("access_token", ""))
    at = Token.objects.filter(hash=access_hash, type=Token.Type.ACCESS_TOKEN).first()
    if at is None:
        return response
    lifetime = settings.NEXUS_MCP_REFRESH_TOKEN_SECONDS
    if body.get("refresh_token"):
        Token.objects.filter(hash=_token_hash(body["refresh_token"]), type=Token.Type.REFRESH_TOKEN).update(
            expires_at=now + timedelta(seconds=lifetime))
        body["refresh_expires_in"] = lifetime
    if old_rt:
        RotatedRefreshToken.objects.get_or_create(hash=_token_hash(old_rt), defaults={
            "user_id": at.user_id, "client_id": client.pk, "expires_at": now + timedelta(seconds=lifetime)})
    McpGrant.objects.filter(user_id=at.user_id, client=client).update(last_token_at=now, scopes=sorted(at.get_scopes()))
    new = JsonResponse(body, status=200)
    for header in ("Cache-Control", "Pragma", "Access-Control-Allow-Origin"):
        if header in response:
            new[header] = response[header]
    new["Cache-Control"] = "no-store"
    return new


# --- dynamic client registration (RFC 7591) ---------------------------------------------------------

_ALLOWED_METHODS = ("none", "client_secret_post")


def _dcr_error(description: str, error: str = "invalid_client_metadata", status: int = 400) -> JsonResponse:
    return _oauth_error(error, description, status)


def unused_dcr_clients():
    """DCR clients that never obtained a token."""
    used = Token.objects.values("client_id")
    return Client.objects.filter(data__dcr=True, data__mcp=True).exclude(pk__in=used)


class McpClientRegistrationView(ClientRegistrationView):
    def post(self, request, *args, **kwargs):
        if not (settings.NEXUS_MCP_ENABLED and settings.NEXUS_MCP_DCR_ENABLED):
            return _dcr_error("Dynamic client registration is not enabled.", "invalid_request", 404)
        ctype = (request.META.get("CONTENT_TYPE") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return _dcr_error("Send the client metadata as application/json.")
        limit, window = settings.NEXUS_MCP_DCR_RATE
        if not ratelimit.hit(f"mcp-dcr:{ratelimit.client_ip(request)}", limit, window).allowed:
            return _dcr_error("Too many registrations. Try again in a minute.", "temporarily_unavailable", 429)
        if unused_dcr_clients().count() >= settings.NEXUS_MCP_DCR_MAX_UNUSED:
            log.warning("DCR refused: %s unused registrations", settings.NEXUS_MCP_DCR_MAX_UNUSED)
            return _dcr_error("Registration is temporarily unavailable.", "temporarily_unavailable", 503)
        try:
            raw = json.loads(request.body or b"")
        except (ValueError, UnicodeDecodeError):
            return _dcr_error("The body is not valid JSON.")
        if not isinstance(raw, dict):
            return _dcr_error("The body must be a JSON object.")
        meta, problem = self._normalise(raw)
        if problem:
            return _dcr_error(problem, "invalid_redirect_uri" if problem.startswith("redirect_uris") else "invalid_client_metadata")
        self._normalised = meta
        return super().post(request, *args, **kwargs)

    @staticmethod
    def _normalise(raw: dict) -> tuple[dict, str]:
        method = raw.get("token_endpoint_auth_method") or "none"
        if method not in _ALLOWED_METHODS:
            return {}, f"token_endpoint_auth_method must be one of: {', '.join(_ALLOWED_METHODS)}."
        uris = raw.get("redirect_uris")
        if not isinstance(uris, list) or not uris or not all(isinstance(u, str) for u in uris) or len(uris) > 10:
            return {}, "redirect_uris must be a list of 1 to 10 URIs."
        bad = [u for u in uris if not redirect_allowed(u)]
        if bad:
            return {}, ("redirect_uris: not allowed on this server (allowed: Claude's callback URLs, http://localhost or "
                        "http://127.0.0.1 on any port, and the operator's allow-list).")
        grants = raw.get("grant_types") or ["authorization_code", "refresh_token"]
        if not isinstance(grants, list) or not set(grants) <= {"authorization_code", "refresh_token"} or "authorization_code" not in grants:
            return {}, "grant_types may only be authorization_code and refresh_token."
        responses = raw.get("response_types") or ["code"]
        if responses != ["code"]:
            return {}, "response_types must be [\"code\"]."
        scope = raw.get("scope") or ""
        requested = scope.split() if isinstance(scope, str) else []
        scopes = [s for s in MCP_SCOPE_LIST if s in requested] or list(MCP_SCOPE_LIST)
        name = raw.get("client_name") if isinstance(raw.get("client_name"), str) else ""
        from .cimd import _clean_name

        meta = {
            "client_name": _clean_name(name, "MCP client")[:100],
            "redirect_uris": uris,
            "grant_types": grants,
            "response_types": ["code"],
            "token_endpoint_auth_method": method,
            "scope": " ".join(scopes),
        }
        return meta, ""

    def _authorize(self):
        return None, None, None  # open registration, guarded by policy and rate limits

    def _get_client_metadata(self):
        return dict(self._normalised)

    def _ratelimit(self):
        class _Usage:
            def rollback(self):
                pass

        return _Usage(), None  # rate limited in post() with the Nexus limiter

    def _perform_custom_validation(self, *, client, client_metadata, token, bearer_token):
        scopes = client_metadata["scope"].split()
        client.set_scopes(scopes)
        client.set_default_scopes(scopes)
        client.skip_consent = False
        client.allow_uri_wildcards = False
        client.data = {"mcp": True, "dcr": True, "client_metadata": {
            k: client_metadata[k] for k in ("client_name", "redirect_uris", "grant_types", "token_endpoint_auth_method")}}
        if client.type == Client.Type.PUBLIC:
            client.secret = make_password(None)
        audit(self.request, "mcp.client.dcr_registered", target_type="oidc_client", target_id=str(client.pk)[:120],
              metadata={"redirect_hosts": sorted({urlsplit(u).hostname or "" for u in client_metadata["redirect_uris"]}),
                        "public": client.type == Client.Type.PUBLIC})
        return None


registration = csrf_exempt(McpClientRegistrationView.as_view())


def grant_for(user, client_id: str):
    from .models import McpGrant

    return McpGrant.objects.filter(user=user, client_id=client_id).select_related("workspace", "client").first()


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]
