"""JSON API of the MCP connector: /api/v1/workspaces/<workspace_id>/mcp/...

* ``GET status`` - is the connector available here, its URL, how to add it in Claude.
* ``GET connections`` - "Connected apps": your connections to this workspace
  (``?scope=workspace``: everyone's, owners and admins only) with client, redirect hosts,
  scopes, created and last used.
* ``DELETE connections/<id>`` - revoke: deletes the connection's tokens and the grant (and a
  dynamically registered client nobody else uses).
"""

from __future__ import annotations

from allauth.idp.oidc.models import Client, Token
from django.conf import settings
from django.utils import timezone

from apps.api.decorators import api_endpoint
from apps.api.http import no_content, ok, paginated
from apps.api.schema import F, query_param
from apps.core.audit import audit
from apps.crm import access
from apps.crm.access import DELETE, Cap
from apps.crm.serializers import user_ref

from . import oauth
from .models import McpGrant


def _row(g: McpGrant, now) -> dict:
    c = g.client
    kind = oauth.client_kind(c)
    active = Token.objects.filter(user_id=g.user_id, client_id=c.pk, expires_at__gt=now).exists()
    return {
        "id": str(g.pk),
        "client": {"name": c.name or "MCP client", "kind": kind, "host": (c.data or {}).get("host", "") if kind == "cimd" else "",
                   "redirect_hosts": oauth.redirect_hosts(c), "loopback_only": oauth.loopback_only(c)},
        "user": user_ref(g.user),
        "scopes": g.scopes,
        "created_at": g.created_at,
        "last_used_at": g.last_used_at,
        "last_token_at": g.last_token_at,
        "active": active,
    }


@api_endpoint(methods=["GET"], feature="crm")
def status(request, actor):
    return ok({
        "installation_enabled": settings.NEXUS_MCP_ENABLED,
        "workspace_enabled": bool(actor.features.get("mcp")),
        "url": settings.NEXUS_MCP_RESOURCE,
        "registration": {"dcr": settings.NEXUS_MCP_DCR_ENABLED, "cimd": settings.NEXUS_MCP_CIMD_ENABLED},
        "scopes": settings.NEXUS_MCP_SCOPES,
        "can_manage": actor.can(Cap.ORG_SETTINGS),
    })


@api_endpoint(methods=["GET"], feature="crm")
def connections(request, actor):
    scope = query_param(request, "scope", F.choice(["mine", "workspace"]), default="mine")
    qs = access.for_actor(actor, McpGrant).select_related("client", "user")
    if scope == "workspace":
        access.require(actor, Cap.ORG_SETTINGS, "Only the workspace owner and admins can see everyone's connections.")
    else:
        qs = qs.filter(user_id=actor.user.pk)
    now = timezone.now()
    return paginated(request, qs.order_by("-created_at"), lambda g: _row(g, now))


@api_endpoint(methods=["DELETE"], feature="crm")
def connection_detail(request, actor, grant_id):
    g = access.get_for_actor(actor, McpGrant, grant_id, DELETE)
    client = g.client
    tokens = oauth.revoke_connection(g.user_id, client.pk)
    audit(request, "mcp.connection.revoke", target_type="oidc_client", target_id=client.pk[:120], actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "revoked_tokens": tokens, "own": g.user_id == actor.user.pk})
    g.delete()
    if oauth.client_kind(client) == "dcr" and not McpGrant.objects.filter(client=client).exists() \
            and not Token.objects.filter(client=client).exists():
        Client.objects.filter(pk=client.pk).delete()
    return no_content()
