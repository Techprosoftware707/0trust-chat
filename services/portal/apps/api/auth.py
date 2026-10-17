"""Bearer access tokens issued by this portal's own OAuth server (allauth.idp.oidc).

Resource servers in this codebase (the JSON API at /api/v1/ today, the MCP connector
later) validate tokens server-side against allauth's ``Token`` table, through ONE function::

    ctx = authenticate_bearer(request, policy=API_POLICY, scopes=["workspace:read"])

A ``TokenPolicy`` says which tokens a resource accepts:

* ``resource`` is the resource's identifier (RFC 8707 / RFC 9068 "audience"). A token
  that was issued for explicit resources (the client sent ``resource=`` to the
  authorization and token endpoints, which allauth stores on the token) is only accepted
  if this resource is among them.
* ``allowed_client_ids`` lists the first-party clients whose tokens *without* resources
  are accepted (the SPA's ``nexus-web``). ``None`` means "resource-bound tokens only".

The MCP team defines its own policy, e.g.
``TokenPolicy(name="mcp", resource=f"{PUBLIC_BASE_URL}/mcp", allowed_client_ids=None)``,
and its own scopes, and calls the same function.

What is checked, in order: the ``Authorization: Bearer`` header (tokens in the URL or body
are refused), a per-IP budget of failed attempts, the token's hash, type and expiry, the
client and audience, the user (active, not suspended or pending deletion), then scopes.
Failures are RFC 6750 responses (401 ``invalid_token`` with ``WWW-Authenticate``; 403
``insufficient_scope``). Token values are never logged or stored.
"""

from __future__ import annotations

import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field

from allauth.idp.oidc.adapter import get_adapter
from allauth.idp.oidc.internal.resources import is_resources_subset
from allauth.idp.oidc.models import Token
from django.conf import settings
from django.db import connection

from apps.core import ratelimit

from .errors import InsufficientScope, RateLimited, Unauthenticated

# Opaque tokens from allauth are urlsafe base64 (secrets.token_urlsafe(64) = 86 chars).
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{20,1024}$")


@dataclass(frozen=True)
class TokenPolicy:
    name: str
    resource: str | None
    allowed_client_ids: frozenset[str] | None
    realm: str = "nexus"


@dataclass(frozen=True)
class TokenContext:
    """The authenticated caller of a bearer request."""

    user: object
    client_id: str
    scopes: frozenset[str]
    resources: tuple[str, ...]
    token_id: int = field(repr=False)
    expires_at: object = field(repr=False, default=None)

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


def api_policy() -> TokenPolicy:
    """The policy of the JSON API at /api/v1/."""
    return TokenPolicy(
        name="api",
        resource=settings.NEXUS_API_RESOURCE,
        allowed_client_ids=frozenset(settings.NEXUS_API_CLIENT_IDS),
        realm="nexus-api",
    )


def _www_authenticate(policy: TokenPolicy, error: str = "", description: str = "", scope: str = "") -> str:
    parts = [f'realm="{policy.realm}"']
    if error:
        parts.append(f'error="{error}"')
    if description:
        parts.append(f'error_description="{description}"')
    if scope:
        parts.append(f'scope="{scope}"')
    return "Bearer " + ", ".join(parts)


def _failure_key(request) -> str:
    return f"api-auth-fail:{ratelimit.client_ip(request)}"


def _failures_now(request, window: int) -> int:
    """Current count of failed attempts from this IP (read-only peek)."""
    now = int(time.time())
    with connection.cursor() as cur:
        cur.execute(
            "SELECT count FROM core_ratelimitbucket WHERE key = %s AND window_start = %s",
            [_failure_key(request)[:200], now - (now % window)],
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


def _fail(request, policy: TokenPolicy, description: str, *, error: str = "invalid_token") -> Unauthenticated:
    limit, window = settings.NEXUS_API_RATE_LIMITS["auth_failures"]
    ratelimit.hit(_failure_key(request), limit, window)
    header = _www_authenticate(policy, error, description) if error else _www_authenticate(policy)
    return Unauthenticated(description, headers={"WWW-Authenticate": header})


def authenticate_bearer(request, *, policy: TokenPolicy, scopes: Iterable[str] = ()) -> TokenContext:
    """Authenticates ``request`` by its bearer token under ``policy`` and requires
    ``scopes``. Sets ``request.user`` to the token's user. Raises ``Unauthenticated``,
    ``InsufficientScope`` or ``RateLimited``."""
    limit, window = settings.NEXUS_API_RATE_LIMITS["auth_failures"]
    if _failures_now(request, window) >= limit:
        raise RateLimited(
            "Too many failed authentication attempts. Try again in a minute.",
            headers={"Retry-After": str(window)},
        )
    if "access_token" in request.GET or (request.method == "POST" and "access_token" in request.POST):
        raise _fail(request, policy, "Send the token in the Authorization header, not in the URL or body.",
                    error="invalid_request")
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if not header:
        # RFC 6750 3.1: no error code when the request simply lacks authentication.
        raise _fail(request, policy, "A bearer access token is required.", error="")
    scheme, _, value = header.partition(" ")
    value = value.strip()
    if scheme.lower() != "bearer" or not _TOKEN_RE.match(value):
        raise _fail(request, policy, "Malformed Authorization header.", error="invalid_request")

    token = (
        Token.objects.valid()
        .filter(type=Token.Type.ACCESS_TOKEN, hash=get_adapter().hash_token(value))
        .select_related("user", "client")
        .first()
    )
    if token is None or token.client_id is None or token.user_id is None:
        raise _fail(request, policy, "The access token is invalid or has expired.")
    resources = tuple(token.get_resources())
    if resources:
        if not policy.resource or not is_resources_subset([policy.resource], list(resources)):
            raise _fail(request, policy, "The access token was not issued for this resource.")
    elif policy.allowed_client_ids is None or token.client_id not in policy.allowed_client_ids:
        # No resource indicator on the token: only the policy's own clients may use it.
        raise _fail(request, policy, "The access token was not issued for this resource.")

    user = token.user
    if not user.is_active or getattr(user, "status", "active") != "active":
        raise _fail(request, policy, "The account is not active.")

    granted = frozenset(token.get_scopes())
    required = [s for s in scopes if s]
    missing = [s for s in required if s not in granted]
    if missing:
        raise InsufficientScope(
            f"The access token lacks the scope(s): {' '.join(missing)}.",
            headers={"WWW-Authenticate": _www_authenticate(policy, "insufficient_scope", scope=" ".join(required))},
        )
    request.user = user
    return TokenContext(
        user=user,
        client_id=token.client_id,
        scopes=granted,
        resources=resources,
        token_id=token.pk,
        expires_at=token.expires_at,
    )
