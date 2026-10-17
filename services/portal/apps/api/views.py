"""Workspace-level API: who am I, my workspaces, a workspace's features, settings and
members. Business records are under each app's api_urls (e.g. /crm/)."""

from __future__ import annotations

from django.conf import settings

from apps.billing.services import workspace_plan
from apps.crm import access
from apps.crm.serializers import user_ref
from apps.crm.services import org_settings, update_org_settings
from apps.workspaces.models import ROLE_RANK, Membership, Role

from .decorators import api_endpoint
from .http import json_body, ok, paginated


def _org(org) -> dict:
    return {
        "business_profiles": list(org.business_profiles or []),
        "default_currency": org.default_currency,
        "save_to_record_enabled": org.save_to_record_enabled,
        "is_demo": org.is_demo,
        "updated_at": org.updated_at,
    }


def _workspace(actor: access.Actor) -> dict:
    ws = actor.workspace
    plan = workspace_plan(ws)
    return {
        "id": str(ws.pk),
        "name": ws.name,
        "slug": ws.slug,
        "role": actor.role,
        "role_label": Role(actor.role).label,
        "plan": {"code": plan.code, "name": plan.name},
        "features": actor.features,
        "capabilities": access.capability_summary(actor),
        "settings": _org(org_settings(ws)),
    }


@api_endpoint(methods=["GET"], workspace=False)
def me(request, ctx):
    """The token's user and their workspaces (with role and enabled features)."""
    user = ctx.user
    workspaces = []
    for ms in Membership.objects.filter(user=user).select_related("workspace").order_by("workspace__name"):
        actor = access.Actor(user=user, membership=ms)
        workspaces.append(
            {"id": str(ms.workspace_id), "name": ms.workspace.name, "role": ms.role, "role_label": Role(ms.role).label,
             "features": actor.features}
        )
    return ok(
        {
            "user": user_ref(user),
            "environment": settings.NEXUS_ENVIRONMENT,
            "scopes": sorted(ctx.scopes),
            "workspaces": workspaces,
        }
    )


@api_endpoint(methods=["GET"])
def workspace_detail(request, actor):
    return ok(_workspace(actor))


@api_endpoint(methods=["GET", "PATCH"])
def workspace_settings(request, actor):
    """Business settings. PATCH (owner/admin): business_profiles, default_currency,
    save_to_record_enabled. Enabling a profile creates its default pipeline."""
    if request.method == "PATCH":
        update_org_settings(request, actor, json_body(request))
        actor = access.Actor(user=actor.user, membership=actor.membership)  # features changed
        return ok(_workspace(actor))
    return ok(_org(org_settings(actor.workspace)))


@api_endpoint(methods=["GET"])
def members(request, actor):
    """Members of the workspace (assignee/owner pickers). Users are identified by their
    random public_id."""
    access.require(actor, access.Cap.MEMBERS_VIEW)
    qs = access.members(actor).filter(user__is_active=True).order_by("user__username")

    def row(ms):
        return {**user_ref(ms.user), "role": ms.role, "role_label": Role(ms.role).label, "rank": ROLE_RANK.get(ms.role, 99)}

    return paginated(request, qs, row, default_limit=200)
