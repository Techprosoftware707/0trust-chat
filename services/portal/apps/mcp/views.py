"""HTTP side of the MCP connector: the ``/mcp`` endpoint and the discovery documents.

``POST /mcp`` (Streamable HTTP, JSON responses):

1. ``NEXUS_MCP_ENABLED`` off -> 404. A browser ``Origin`` not in
   ``NEXUS_MCP_ALLOWED_ORIGINS`` -> 403 (requests without Origin, e.g. from Claude's
   servers, pass). GET/DELETE -> 405 (no SSE stream, no sessions).
2. Bearer token (header only) through the foundation's ``authenticate_bearer`` with the MCP
   policy, then an exact (canonical) audience check: only tokens bound to this resource
   work. No token -> 401 with ``WWW-Authenticate: Bearer resource_metadata="...",
   scope="..."`` (this starts Claude's sign-in); bad token -> 401 ``invalid_token``; a token
   without MCP scopes, or calling a write tool with a read-only token -> 403
   ``insufficient_scope`` (step-up).
3. Per-person rate limit, then one JSON-RPC message (``server.py``).

Discovery: RFC 9728 Protected Resource Metadata at
``/.well-known/oauth-protected-resource/mcp`` and ``/.well-known/oauth-protected-resource``;
RFC 8414 Authorization Server Metadata at ``/.well-known/oauth-authorization-server`` (the
same document as ``/.well-known/openid-configuration``).
"""

from __future__ import annotations

import json
import logging

from allauth.idp.oidc.views import configuration as allauth_configuration
from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import Http404, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from apps.api.auth import authenticate_bearer
from apps.api.errors import InsufficientScope, RateLimited, Unauthenticated
from apps.core import ratelimit
from apps.crm import access

from . import oauth, server

log = logging.getLogger("nexus.mcp")
ALLOW_HEADERS = "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID"
EXPOSE_HEADERS = "WWW-Authenticate, Retry-After"


def _origin_ok(request) -> tuple[bool, str]:
    origin = request.META.get("HTTP_ORIGIN", "")
    if not origin:
        return True, ""
    return origin in settings.NEXUS_MCP_ALLOWED_ORIGINS, origin


def _cors(response: HttpResponse, origin: str) -> HttpResponse:
    if origin:
        response["Access-Control-Allow-Origin"] = origin
        response["Access-Control-Expose-Headers"] = EXPOSE_HEADERS
        response["Vary"] = "Origin"
    return response


def _auth_error(status: int, error: str, description: str, *, header_error: str = "", scope: str = "mcp:read mcp:write") -> JsonResponse:
    body = {"error": error or "invalid_token", "error_description": description}
    response = JsonResponse(body, status=status)
    response["WWW-Authenticate"] = oauth.challenge(error=header_error, description=description if header_error else "", scope=scope)
    response["Cache-Control"] = "no-store"
    return response


def _session(request, token_ctx) -> server.Session:
    grant = oauth.grant_for(token_ctx.user, token_ctx.client_id)
    workspace = grant.workspace if grant else None
    if workspace is None:
        eligible = oauth.eligible_workspaces(token_ctx.user)
        if len(eligible) == 1:
            workspace = eligible[0]
        else:
            return server.Session(request, token_ctx, grant, None,
                                  "This connection isn't linked to a workspace. Disconnect and connect again to choose one.")
    try:
        actor = access.actor_for(token_ctx.user, workspace.pk, token=token_ctx)
    except Http404:
        return server.Session(request, token_ctx, grant, None, "You're no longer a member of the workspace this connection uses.")
    if not actor.features.get("mcp"):
        return server.Session(request, token_ctx, grant, None,
                              "The Claude connector is turned off for this workspace. An owner or admin can turn it on in the AI settings.")
    if grant is not None and (grant.last_used_at is None or (timezone.now() - grant.last_used_at).total_seconds() > 60):
        type(grant).objects.filter(pk=grant.pk).update(last_used_at=timezone.now())
    return server.Session(request, token_ctx, grant, actor, "")


@csrf_exempt
def endpoint(request):
    if not settings.NEXUS_MCP_ENABLED:
        return JsonResponse({"error": "not_found", "error_description": "The MCP connector is not enabled on this server."}, status=404)
    ok_origin, origin = _origin_ok(request)
    if not ok_origin:
        return JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST, "message": "Origin not allowed."}}, status=403)
    if request.method == "OPTIONS":
        response = HttpResponse(status=204)
        response["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response["Access-Control-Allow-Headers"] = ALLOW_HEADERS
        response["Access-Control-Max-Age"] = "600"
        return _cors(response, origin)
    if request.method != "POST":
        response = JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST,
                                                             "message": "Use POST. This server has no SSE stream and no sessions."}}, status=405)
        response["Allow"] = "POST, OPTIONS"
        return _cors(response, origin)
    return _cors(_post(request), origin)


def _post(request) -> HttpResponse:
    # 1. Authentication. A missing header is the normal start of sign-in: answer the
    #    challenge without counting it as a failed attempt.
    if not request.META.get("HTTP_AUTHORIZATION") and "access_token" not in request.GET:
        return _auth_error(401, "invalid_token", "Sign in to use this connector.")
    try:
        token_ctx = authenticate_bearer(request, policy=oauth.mcp_policy(), scopes=())
    except Unauthenticated as exc:
        return _auth_error(401, "invalid_token", exc.message, header_error="invalid_token")
    except RateLimited as exc:
        response = JsonResponse({"error": "rate_limited", "error_description": exc.message}, status=429)
        response["Retry-After"] = exc.headers.get("Retry-After", "60")
        return response
    except InsufficientScope as exc:  # pragma: no cover - no scopes are required at this step
        return _auth_error(403, "insufficient_scope", exc.message, header_error="insufficient_scope")
    if not any(oauth.is_mcp_resource(r) for r in token_ctx.resources):
        return _auth_error(401, "invalid_token", "The access token was not issued for this MCP server.", header_error="invalid_token")
    if not token_ctx.scopes & {oauth.SCOPE_READ, oauth.SCOPE_WRITE}:
        return _auth_error(403, "insufficient_scope", "The access token has no MCP scope.", header_error="insufficient_scope")

    # 2. Rate limit per person.
    limit, window = settings.NEXUS_AI_RATE_LIMITS["mcp"]
    decision = ratelimit.hit(f"mcp:u{token_ctx.user.pk}", limit, window)
    if not decision.allowed:
        response = JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST, "message": "Too many requests."}}, status=429)
        response["Retry-After"] = str(decision.retry_after)
        return response

    # 3. The message.
    ctype = (request.META.get("CONTENT_TYPE") or "").split(";")[0].strip().lower()
    if ctype != "application/json":
        return JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST,
                                                         "message": "Content-Type must be application/json."}}, status=415)
    accept = request.META.get("HTTP_ACCEPT", "")
    if accept and not any(a in accept for a in ("application/json", "*/*", "application/*")):
        return JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST,
                                                         "message": "Accept must allow application/json."}}, status=406)
    try:
        raw = request.body
    except RequestDataTooBig:
        return JsonResponse({"jsonrpc": "2.0", "error": {"code": server.INVALID_REQUEST, "message": "The request is too large."}}, status=413)
    try:
        msg = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return server.parse_error_response()
    session = _session(request, token_ctx)
    try:
        response = server.handle_message(request, msg, session)
    except server.ScopeChallenge:
        return _auth_error(403, "insufficient_scope", "This tool needs the mcp:write scope. Reconnect and allow changes.",
                           header_error="insufficient_scope", scope="mcp:read mcp:write")
    except server.RpcError as err:
        return server._rpc_error(None, err)
    response["Cache-Control"] = "no-store"
    return response


def _metadata_response(data: dict) -> JsonResponse:
    response = JsonResponse(data)
    response["Access-Control-Allow-Origin"] = "*"
    response["Cache-Control"] = "public, max-age=300"
    return response


def protected_resource_metadata(request):
    """RFC 9728. ``resource`` is exactly the MCP URL; the issuer is the first (and only)
    authorization server."""
    if not settings.NEXUS_MCP_ENABLED:
        return JsonResponse({"error": "not_found"}, status=404)
    return _metadata_response({
        "resource": settings.NEXUS_MCP_RESOURCE,
        "authorization_servers": [oauth.issuer()],
        "scopes_supported": list(oauth.MCP_SCOPE_LIST),
        "bearer_methods_supported": ["header"],
        "resource_name": f"{settings.BRAND['name']} workspace",
    })


def authorization_server_metadata(request):
    """RFC 8414 at the well-known path for an issuer without a path component."""
    return allauth_configuration(request)
