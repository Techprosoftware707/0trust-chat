"""JSON API of the AI assistant: /api/v1/workspaces/<workspace_id>/assistant/...

* ``GET status`` - provider (or "development mode"), workspace AI settings, what's enabled.
* ``GET|PATCH settings`` - AI policy of the workspace (PATCH: owners and admins).
* ``POST chat`` - one assistant turn (rate limited, audited in the AI log).
* ``GET actions/<id>``, ``POST actions/<id>/confirm``, ``POST actions/<id>/cancel`` - the
  person's decision on a prepared change (single use, own actions only).
* ``GET interactions`` - the AI audit log: your own; ``?scope=workspace`` for owners/admins
  (metadata only; content of other people's conversations is never shown).
* ``POST save-to-record`` - copy selected chat messages into a note (feature
  ``save_to_record``, off by default).
"""

from __future__ import annotations

from django.conf import settings

from apps.api.decorators import api_endpoint
from apps.api.errors import Conflict
from apps.api.http import created, json_body, ok, paginated
from apps.api.schema import F, query_param, validate
from apps.core.audit import audit
from apps.crm import access
from apps.crm.access import Cap

from . import actions, chat, interactions, save_to_record
from .models import AIInteraction, Channel, PendingAction
from .providers import provider_status
from .registry import available_tools
from .safety import ai_settings, can_view_sensitive

SETTINGS_SPEC = {
    "assistant_enabled": F.boolean(),
    "mcp_enabled": F.boolean(),
    "sensitive_data_enabled": F.boolean(),
    "content_retention_days": F.integer(min_value=0, max_value=90),
}


def _settings(row) -> dict:
    return {
        "assistant_enabled": row.assistant_enabled,
        "mcp_enabled": row.mcp_enabled,
        "sensitive_data_enabled": row.sensitive_data_enabled,
        "content_retention_days": row.content_retention_days,
        "updated_at": row.updated_at,
    }


@api_endpoint(methods=["GET"], feature="crm")
def status(request, actor):
    row = ai_settings(actor.workspace)
    tools = available_tools(actor, Channel.ASSISTANT)
    return ok({
        "provider": provider_status(),
        "settings": _settings(row),
        "features": {k: actor.features.get(k, False) for k in ("assistant", "mcp", "save_to_record")},
        "sensitive_in_context": row.sensitive_data_enabled and can_view_sensitive(actor),
        "tools": [{"name": t.name, "title": t.title, "kind": t.kind} for t in tools],
        "mcp": {"installation_enabled": settings.NEXUS_MCP_ENABLED, "url": settings.NEXUS_MCP_RESOURCE},
        "notes": [
            "The assistant works on business records you may see. It cannot read your end-to-end encrypted chats.",
            "It never sends emails or messages and never changes a record without your confirmation.",
            "Connecting Claude to this workspace (MCP connector) does not give this app an AI model: the in-app assistant needs its "
            "own provider configured by the operator.",
        ],
    })


@api_endpoint(methods=["GET", "PATCH"], feature="crm")
def ai_settings_view(request, actor):
    row = ai_settings(actor.workspace)
    if request.method == "PATCH":
        access.require(actor, Cap.ORG_SETTINGS, "Only the workspace owner and admins can change AI settings.")
        data = validate(json_body(request), SETTINGS_SPEC, partial=True)
        changed = [k for k, v in data.items() if getattr(row, k) != v]
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = actor.user
        row.save()
        audit(request, "assistant.settings.update", target_type="workspace", target_id=str(actor.workspace_id), actor=actor.user,
              metadata={"workspace": str(actor.workspace_id), "fields": sorted(changed)})
    return ok(_settings(row))


@api_endpoint(methods=["POST"], feature="assistant", atomic=False)
def chat_view(request, actor):
    return ok(chat.run_chat(request, actor, json_body(request)))


def _action_response(row: PendingAction):
    return ok(actions.serialize(row))


@api_endpoint(methods=["GET"], feature="assistant")
def action_detail(request, actor, action_id):
    row = access.get_for_actor(actor, PendingAction, action_id,
                               queryset=access.for_actor(actor, PendingAction).filter(channel=Channel.ASSISTANT))
    return _action_response(row)


@api_endpoint(methods=["POST"], feature="assistant", atomic=False)  # confirm() manages its transactions (external drafts)
def action_confirm(request, actor, action_id):
    try:
        row = actions.confirm(request, actor, action_id, channel=Channel.ASSISTANT)
    except actions.ConfirmFailed as exc:
        from apps.api.errors import error_response

        return error_response(exc.err, request)  # the failed mark is committed
    return _action_response(row)


@api_endpoint(methods=["POST"], feature="assistant")
def action_cancel(request, actor, action_id):
    row = actions.cancel(request, actor, action_id, channel=Channel.ASSISTANT)
    return _action_response(row)


@api_endpoint(methods=["GET"], feature="crm")
def interactions_view(request, actor):
    scope = query_param(request, "scope", F.choice(["mine", "workspace"]), default="mine")
    qs = access.for_actor(actor, AIInteraction).select_related("created_by")
    if scope == "workspace":
        access.require(actor, Cap.ORG_SETTINGS, "Only the workspace owner and admins can see everyone's AI use.")
    else:
        qs = qs.filter(created_by_id=actor.user.pk)
    channel = query_param(request, "channel", F.choice([c.value for c in Channel]))
    if channel:
        qs = qs.filter(channel=channel)
    me = actor.user.pk
    return paginated(request, qs.order_by("-started_at"), lambda r: interactions.serialize(r, with_content=r.created_by_id == me))


@api_endpoint(methods=["POST"], feature="save_to_record")
def save_to_record_view(request, actor):
    a = save_to_record.save(request, actor, json_body(request))
    return created({"activity_id": str(a.pk), "summary": a.summary, "contact_id": str(a.contact_id) if a.contact_id else None,
                    "opportunity_id": str(a.opportunity_id) if a.opportunity_id else None,
                    "message_count": a.metadata.get("message_count", 0)})


__all__ = ["Conflict"]
