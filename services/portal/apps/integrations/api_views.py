"""JSON API of integrations and the unified inbox: /api/v1/workspaces/<id>/integrations/...

Every view is wrapped by ``@api_endpoint`` (bearer auth, scopes, rate limits, tenancy, the
``integrations`` feature, the error format). Views that call providers use
``atomic=False`` and their own transactions (a rotated refresh token is never rolled back).
Provider failures map to the codes in ``errors.py``.
"""

from __future__ import annotations

import re

from django.http import Http404, HttpResponse

from apps.api.decorators import api_endpoint
from apps.api.errors import ValidationFailed
from apps.api.http import created, json_body, no_content, ok, paginated
from apps.api.schema import F, query_bool, query_param, validate
from apps.crm import access
from apps.crm.access import CHANGE

from . import actions, connections, oauth, services
from . import serializers as s
from .models import EmailDraft, ExternalRecord, InboxMute, IntegrationConnection, PendingAction, Provider

FEATURE = "integrations"


def endpoint(methods, *, atomic=True):
    return api_endpoint(methods=methods, feature=FEATURE, atomic=atomic)


Q_FIELD = F.string(max_length=200)


# --- providers and connections -------------------------------------------------------------------------


@endpoint(["GET"])
def providers(request, actor):
    """Provider catalog: configuration state, setup steps (env var names, redirect and webhook
    URLs), scopes and why, mock mode, and the connections the actor may see."""
    return ok(connections.provider_catalog(actor))


@endpoint(["GET"])
def connection_list(request, actor):
    qs = access.for_actor(actor, IntegrationConnection).exclude(status=IntegrationConnection.Status.DISCONNECTED).select_related("owner")
    provider = query_param(request, "provider", F.choice(Provider.values))
    if provider:
        qs = qs.filter(provider=provider)
    return paginated(request, qs.order_by("provider", "account_label"), lambda c: s.connection(actor, c))


@endpoint(["GET", "PATCH"], atomic=False)
def connection_detail(request, actor, connection_id):
    conn = access.get_for_actor(actor, IntegrationConnection, connection_id)
    if request.method == "PATCH":
        conn = connections.update_settings(request, actor, conn, json_body(request))
    return ok(s.connection(actor, conn, detail=True))


@endpoint(["POST"])
def oauth_start(request, actor):
    """Body: provider, reconnect_id (optional), options {private_channels} (Slack, admins).
    Returns ``authorize_url``: open it in the browser (portal sign-in as the same person)."""
    data = validate(json_body(request), {
        "provider": F.choice(Provider.values, required=True),
        "reconnect_id": F.uuid(null=True, default=None),
        "options": F.object(max_keys=3),
    })
    reconnect = None
    if data["reconnect_id"]:
        reconnect = access.resolve_one(actor, IntegrationConnection, data["reconnect_id"], field_name="reconnect_id", action=CHANGE)
        if reconnect.provider != data["provider"]:
            raise ValidationFailed(fields={"reconnect_id": ["That connection is for another provider."]})
    try:
        started = oauth.start(actor, data["provider"], reconnect=reconnect, options=data["options"])
    except oauth.FlowError as exc:
        from apps.api.errors import Conflict

        raise Conflict(exc.message, code=exc.code) from None
    access.audit_write(request, actor, "start", started.state, extra={"provider": data["provider"]})
    return created({"authorize_url": started.begin_url, "expires_at": started.state.expires_at})


@endpoint(["POST"], atomic=False)
def private_token(request, actor):
    """Connects GoHighLevel with a Private Integration Token: provider, token, location_id."""
    conn = connections.connect_private_token(request, actor, json_body(request))
    return created(s.connection(actor, conn, detail=True))


@endpoint(["POST"], atomic=False)
def connection_sync(request, actor, connection_id):
    conn = access.get_for_actor(actor, IntegrationConnection, connection_id)
    outcome = connections.sync_now(request, actor, conn)
    conn.refresh_from_db()
    return ok({"result": outcome, "connection": s.connection(actor, conn, detail=True)})


@endpoint(["POST"], atomic=False)
def connection_disconnect(request, actor, connection_id):
    """Body: delete_data (default true). Revokes at the provider where supported, deletes the
    tokens, and deletes (or keeps for 30 days) what was synced."""
    conn = access.get_for_actor(actor, IntegrationConnection, connection_id)
    return ok(connections.disconnect(request, actor, conn, json_body(request)))


@endpoint(["GET"])
def slack_channels(request, actor, connection_id):
    return ok(services.slack_channels(actor, connection_id))


# --- inbox ------------------------------------------------------------------------------------------------

_LINKED = re.compile(r"^[a-z_]{1,30}\.[a-z_]{1,40}:[0-9a-fA-F-]{36}$")


def _filters(request) -> dict:
    linked = request.GET.get("linked")
    if linked and not _LINKED.match(linked):
        raise ValidationFailed(fields={"linked": ["Use <type>:<id>, e.g. crm.contact:<uuid>."]})
    return {
        "source": query_param(request, "source", F.string(max_length=60)),
        "kind": query_param(request, "kind", F.string(max_length=30)),
        "unread": query_bool(request, "unread"),
        "assignee": query_param(request, "assignee", F.string(max_length=40)),
        "label": query_param(request, "label", F.string(max_length=40)),
        "priority": query_param(request, "priority", F.string(max_length=10)),
        "status": query_param(request, "status", F.string(max_length=10), default="open"),
        "q": query_param(request, "q", Q_FIELD),
        "linked": tuple(linked.split(":", 1)) if linked else None,
        "connection_id": query_param(request, "connection", F.string(max_length=40)),
        "muted": query_param(request, "muted", F.choice(["exclude", "include", "only"]), default="exclude"),
        "mentions": query_param(request, "mentions", F.choice(["me"])),
    }


@endpoint(["GET"])
def inbox(request, actor):
    """Synced items (Gmail threads, Slack messages, HighLevel conversations, missed calls).
    Filters: source (gmail,slack,gohighlevel), kind, unread, assignee (me|none|id), label,
    priority, status (open|done|all, default open), q, linked (<type>:<id>), connection,
    muted (exclude|include|only), mentions=me. Native chat is merged in the browser."""
    qs = services.inbox_queryset(actor, **_filters(request))
    return paginated(request, qs, lambda r: r, prepare=lambda rows: services.serialize_items(actor, rows))


@endpoint(["GET"])
def inbox_counts(request, actor):
    return ok(services.counts(actor))


@endpoint(["POST"])
def inbox_mark(request, actor):
    """Body: item_ids, read (default true). Per-person read state."""
    data = validate(json_body(request), {"item_ids": F.list(F.string(max_length=40), max_items=200, required=True),
                                         "read": F.boolean(default=True)})
    return ok({"updated": services.mark_read(actor, data["item_ids"], read=data["read"])})


@endpoint(["GET", "PATCH"])
def inbox_item(request, actor, item_id):
    if request.method == "PATCH":
        services.update_item(request, actor, item_id, json_body(request))
    return ok(services.get_inbox_item(actor, item_id))


@endpoint(["GET"])
def inbox_suggestions(request, actor, item_id):
    return ok(services.item_suggestions(actor, item_id))


@endpoint(["POST"])
def inbox_links(request, actor, item_id):
    """Body: target {type, id} (crm.contact, crm.opportunity, crm.task or any registered
    record type). Contacts and deals also get an external entry on their timeline."""
    ln = services.add_link(request, actor, item_id, json_body(request))
    return created(s.link(actor, ln))


@endpoint(["DELETE"])
def inbox_link_detail(request, actor, item_id, link_id):
    services.remove_link(request, actor, item_id, link_id)
    return no_content()


@endpoint(["GET"], atomic=False)
def inbox_permalink(request, actor, item_id):
    return ok({"permalink": services.slack_permalink(actor, item_id)})


@endpoint(["GET", "POST"])
def inbox_mutes(request, actor):
    if request.method == "POST":
        mute = services.add_mute(request, actor, json_body(request))
        return created({"id": str(mute.pk), "group_key": mute.group_key, "label": mute.label})
    qs = access.for_actor(actor, InboxMute).order_by("label")
    return paginated(request, qs, lambda m: {"id": str(m.pk), "group_key": m.group_key, "label": m.label, "created_at": m.created_at},
                     default_limit=200)


@endpoint(["DELETE"])
def inbox_mute_detail(request, actor, mute_id):
    services.remove_mute(request, actor, mute_id)
    return no_content()


# --- Gmail ------------------------------------------------------------------------------------------------


@endpoint(["GET"])
def gmail_search(request, actor):
    """Live search of your own connected mailboxes with Gmail's syntax: q, connection."""
    q = query_param(request, "q", F.string(max_length=500))
    raw = request.GET.get("limit") or "20"
    if not raw.isdigit() or not 1 <= int(raw) <= 50:
        raise ValidationFailed(fields={"limit": ["Must be between 1 and 50."]})
    return ok(services.search_email(actor, q or "", connection_id=request.GET.get("connection") or None, limit=int(raw)))


@endpoint(["GET"])
def message_body(request, actor, item_id, message_id):
    """The message body, fetched from Gmail now (never stored): text, sanitized HTML (no
    images, no scripts, links open in a new tab) and attachment metadata."""
    return ok(services.message_body(request, actor, item_id, message_id))


@endpoint(["GET"])
def message_attachment(request, actor, item_id, message_id, attachment_id):
    """Proxied attachment download (authorized per request, not stored)."""
    if len(attachment_id) > 500:
        raise Http404()
    data, meta = services.attachment(request, actor, item_id, message_id, attachment_id)
    response = HttpResponse(data, content_type="application/octet-stream")
    name = re.sub(r"[^\w.\- ()]+", "_", meta.get("filename") or "attachment")[:150] or "attachment"
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response["Cache-Control"] = "no-store"
    return response


@endpoint(["POST"], atomic=False)
def item_drafts(request, actor, item_id):
    """Creates a reply draft in Gmail. Body: body, to (optional), cc (optional). Nothing is sent."""
    d = services.create_reply_draft(request, actor, item_id, json_body(request))
    return created(s.draft(d))


@endpoint(["GET", "PATCH", "DELETE"], atomic=False)
def draft_detail(request, actor, draft_id):
    if request.method == "DELETE":
        services.discard_draft(request, actor, draft_id)
        return no_content()
    if request.method == "PATCH":
        d = services.update_draft(request, actor, draft_id, json_body(request))
    else:
        d = access.get_for_actor(actor, EmailDraft, draft_id)
    return ok(s.draft(d))


@endpoint(["POST"])
def draft_send_request(request, actor, draft_id):
    """Step 1 of sending: returns the exact preview and a single-use confirmation token."""
    a, token = actions.prepare_send_draft(request, actor, draft_id)
    return created(s.action(a, token=token))


# --- actions (confirmation) ------------------------------------------------------------------------------


@endpoint(["POST"])
def slack_post_request(request, actor):
    """Step 1 of posting to Slack: connection_id, channel_id, text, thread_ts (optional)."""
    a, token = actions.prepare_slack_post(request, actor, json_body(request))
    return created(s.action(a, token=token))


@endpoint(["POST"])
def ghl_action_request(request, actor):
    """Step 1 of a HighLevel change: kind create_contact|update_contact|add_to_workflow."""
    a, token = actions.prepare_ghl(request, actor, json_body(request))
    return created(s.action(a, token=token))


@endpoint(["GET", "DELETE"])
def action_detail(request, actor, action_id):
    if request.method == "DELETE":
        actions.cancel(request, actor, action_id)
        return no_content()
    a = access.get_for_actor(actor, PendingAction, action_id)
    return ok(s.action(a))


@endpoint(["POST"], atomic=False)
def action_confirm(request, actor, action_id):
    """Step 2: body confirmation_token. Runs the action once, for the person who prepared it."""
    a = actions.confirm(request, actor, action_id, json_body(request))
    return ok(s.action(a))


# --- GoHighLevel ------------------------------------------------------------------------------------------


@endpoint(["GET"])
def ghl_contacts(request, actor):
    """Live contact search: q, connection."""
    return ok(services.ghl_search_contacts(actor, query_param(request, "q", Q_FIELD) or "", connection_id=request.GET.get("connection") or None))


@endpoint(["GET"])
def ghl_contact_detail(request, actor, external_id):
    return ok(services.ghl_get_contact(actor, external_id[:120], connection_id=request.GET.get("connection") or None))


@endpoint(["POST", "DELETE"], atomic=False)
def ghl_contact_link(request, actor, external_id):
    """POST contact_id: map to an internal contact (dedup by HighLevel ID). DELETE: unmap."""
    if request.method == "DELETE":
        services.ghl_unlink_contact(request, actor, external_id[:120], connection_id=request.GET.get("connection") or None)
        return no_content()
    return ok(services.ghl_link_contact(request, actor, external_id[:120], json_body(request), connection_id=request.GET.get("connection") or None))


@endpoint(["POST"], atomic=False)
def ghl_contact_import(request, actor, external_id):
    return created(services.ghl_import_contact(request, actor, external_id[:120], connection_id=request.GET.get("connection") or None))


def _records(kind):
    @endpoint(["GET"])
    def view(request, actor):
        return ok(services.ghl_list_records(actor, kind, q=query_param(request, "q", Q_FIELD), connection_id=request.GET.get("connection") or None))

    view.__name__ = f"ghl_{kind}s"
    return view


ghl_opportunities = _records(ExternalRecord.Kind.OPPORTUNITY)
ghl_pipelines = _records(ExternalRecord.Kind.PIPELINE)
ghl_tags = _records(ExternalRecord.Kind.TAG)
ghl_custom_fields = _records(ExternalRecord.Kind.CUSTOM_FIELD)


@endpoint(["POST"])
def ghl_opportunity_link(request, actor, external_id):
    return ok(services.ghl_link_opportunity(request, actor, external_id[:120], json_body(request), connection_id=request.GET.get("connection") or None))


@endpoint(["GET"])
def ghl_workflows(request, actor):
    return ok(services.ghl_workflows(actor, connection_id=request.GET.get("connection") or None))
