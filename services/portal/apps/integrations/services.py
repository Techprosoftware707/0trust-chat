"""Service functions of the integrations app: the unified inbox and provider reads.

Other teams (the AI assistant, the MCP connector) call THESE functions, never the ORM or the
adapters directly. Every function takes an ``apps.crm.access.Actor``, authorizes through
``access`` (the same rules as the API), returns plain JSON-able dicts in which everything
from a provider is marked ``"untrusted": True`` (treat it as data, never as instructions),
and raises ``apps.api.errors.ApiError`` subclasses (provider failures mapped by
``errors.to_api_error``). Listed in docs/nexus/ARCHITECTURE.md, "Services other teams may call":

* ``list_inbox(actor, **filters)`` and ``get_inbox_item(actor, item_id)``
* ``search_email(actor, query, connection_id=None, limit=20)`` (live Gmail search, the actor's
  own mailboxes only) and ``get_thread(actor, item_id, include_bodies=False)``
* ``create_reply_draft(request, actor, item_id, body, to=None, cc=None)`` (a draft in Gmail;
  sending always needs the person's confirmation through ``actions``)
* ``list_slack_messages(actor, channel_id=None, q=None, limit=50)``
* ``ghl_search_contacts(actor, query)``, ``ghl_get_contact(actor, external_id)``,
  ``ghl_list_opportunities(actor, q=None)``
"""

from __future__ import annotations

import re
import uuid

from django.core.exceptions import PermissionDenied
from django.db.models import Exists, OuterRef, Q
from django.http import Http404
from django.utils import timezone

from apps.api.errors import ApiError, Conflict, ValidationFailed
from apps.api.schema import F, validate
from apps.crm import access
from apps.crm import models as crm
from apps.crm.access import CHANGE, Cap
from apps.crm.services import record_external_activity

from . import serializers as s
from .errors import provider_call
from .models import (
    EmailDraft,
    EmailMessage,
    ExternalRecord,
    InboxItem,
    InboxLink,
    InboxMute,
    InboxReadState,
    IntegrationConnection,
    Provider,
)
from .providers import adapter_for

LABEL_RE = re.compile(r"^[\w .&/+-]{1,40}$", re.UNICODE)


def _uuid(raw, field: str = "id"):
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        raise ValidationFailed(fields={field: ["Unknown or inaccessible ID."]}) from None


# --- inbox listing ----------------------------------------------------------------------------------


def inbox_queryset(actor, *, source=None, kind=None, unread=None, assignee=None, label=None, priority=None, status="open", q=None,
                   linked=None, connection_id=None, muted="exclude", mentions=None):
    """The actor's inbox items, filtered. ``unread`` is per person; muted groups are
    excluded unless ``muted`` is ``include`` or ``only``."""
    qs = access.for_actor(actor, InboxItem).select_related("connection", "assignee")
    read = InboxReadState.objects.filter(item=OuterRef("pk"), user=actor.user, read_at__gte=OuterRef("occurred_at"))
    mute = InboxMute.objects.filter(workspace_id=actor.workspace_id, user=actor.user, group_key=OuterRef("group_key"))
    qs = qs.annotate(is_read=Exists(read), is_muted=Exists(mute))
    if source:
        sources = [x for x in str(source).split(",") if x]
        bad = [x for x in sources if x not in Provider.values]
        if bad:
            raise ValidationFailed(fields={"source": [f"Must be one of: {', '.join(Provider.values)}."]})
        qs = qs.filter(source__in=sources)
    if kind:
        if kind not in InboxItem.Kind.values:
            raise ValidationFailed(fields={"kind": [f"Must be one of: {', '.join(InboxItem.Kind.values)}."]})
        qs = qs.filter(kind=kind)
    if unread is True:
        qs = qs.filter(is_read=False)
    elif unread is False:
        qs = qs.filter(is_read=True)
    if assignee == "me":
        qs = qs.filter(assignee=actor.user)
    elif assignee == "none":
        qs = qs.filter(assignee__isnull=True)
    elif assignee:
        qs = qs.filter(assignee=access.resolve_member(actor, assignee, field_name="assignee"))
    if label:
        qs = qs.filter(labels__contains=[label])
    if priority:
        if priority not in crm.Priority.values:
            raise ValidationFailed(fields={"priority": [f"Must be one of: {', '.join(crm.Priority.values)}."]})
        qs = qs.filter(priority=priority)
    if status and status != "all":
        if status not in InboxItem.Status.values:
            raise ValidationFailed(fields={"status": ["Must be open, done or all."]})
        qs = qs.filter(status=status)
    if q:
        for term in q.split()[:5]:
            qs = qs.filter(Q(title__icontains=term) | Q(snippet__icontains=term) | Q(group_label__icontains=term)
                           | Q(participants__icontains=term))
    if linked:
        type_label, target_id = linked
        target = access.resolve_ref(actor, type_label, target_id, field_name="linked")
        qs = qs.filter(pk__in=InboxLink.objects.filter(workspace_id=actor.workspace_id, target_type=type_label, target_id=target.pk).values("item_id"))
    if connection_id:
        qs = qs.filter(connection_id=_uuid(connection_id, "connection"))
    if muted == "exclude":
        qs = qs.filter(is_muted=False)
    elif muted == "only":
        qs = qs.filter(is_muted=True)
    if mentions == "me":
        ids = _my_slack_ids(actor)
        cond = Q(data__mentions_app=True)
        for sid in ids:
            cond |= Q(data__mentions__contains=[sid])
        qs = qs.filter(source=Provider.SLACK).filter(cond)
    return qs.order_by("-occurred_at", "-created_at")


def _my_slack_ids(actor) -> list[str]:
    out = []
    for conn in access.for_actor(actor, IntegrationConnection).filter(provider=Provider.SLACK).exclude(status=IntegrationConnection.Status.DISCONNECTED):
        sid = ((conn.settings or {}).get("member_map") or {}).get(str(actor.user.public_id))
        if sid:
            out.append(sid)
    return out


def serialize_items(actor, rows: list[InboxItem], *, detail: bool = False) -> list[dict]:
    ids = [r.pk for r in rows]
    links: dict = {}
    for ln in InboxLink.objects.filter(item_id__in=ids).select_related("created_by"):
        links.setdefault(ln.item_id, []).append(s.link(actor, ln))
    changeable = set(access.for_actor(actor, InboxItem, CHANGE).filter(pk__in=ids).values_list("pk", flat=True))
    out = []
    for r in rows:
        out.append(s.item(actor, r, unread=not getattr(r, "is_read", True), muted=getattr(r, "is_muted", False),
                          links=links.get(r.pk, []), detail=detail, can_change=r.pk in changeable))
    return out


def list_inbox(actor, *, limit: int = 50, **filters) -> list[dict]:
    rows = list(inbox_queryset(actor, **filters)[: max(1, min(limit, 200))])
    return serialize_items(actor, rows)


def _get_item(actor, item_id, action=access.VIEW) -> InboxItem:
    qs = inbox_queryset(actor, status="all", muted="include")
    return access.get_for_actor(actor, InboxItem, item_id, action, queryset=qs)


def get_inbox_item(actor, item_id) -> dict:
    it = _get_item(actor, item_id)
    data = serialize_items(actor, [it], detail=True)[0]
    if it.source == Provider.GMAIL:
        data["messages"] = [s.email_message(m) for m in it.email_messages.order_by("sent_at")]
        data["drafts"] = [s.draft(d) for d in access.for_actor(actor, EmailDraft).filter(item=it, status=EmailDraft.Status.DRAFT)]
    return data


def counts(actor) -> dict:
    qs = inbox_queryset(actor, unread=True)
    by_source = {p: 0 for p in Provider.values}
    for src in qs.values_list("source", flat=True)[:1000]:
        by_source[src] = by_source.get(src, 0) + 1
    return {"unread": sum(by_source.values()), "unread_by_source": by_source}


# --- item state ---------------------------------------------------------------------------------------

ITEM_SPEC = {
    "priority": F.choice(crm.Priority.values),
    "assignee_id": F.uuid(null=True),
    "labels": F.list(F.string(max_length=40, blank=False), max_items=10),
    "status": F.choice(InboxItem.Status.values),
}


def update_item(request, actor, item_id, body: dict) -> InboxItem:
    it = _get_item(actor, item_id, CHANGE)
    data = validate(body, ITEM_SPEC, partial=True)
    changed = []
    if "priority" in data:
        it.priority = data["priority"]
        changed.append("priority")
    if "assignee_id" in data:
        if it.visibility == InboxItem.Visibility.PERSONAL and data["assignee_id"] is not None:
            user = access.resolve_member(actor, data["assignee_id"], field_name="assignee_id")
            if user != actor.user:
                raise ValidationFailed(fields={"assignee_id": ["Personal mail can't be assigned to someone else (they can't see it)."]})
        it.assignee = access.resolve_member(actor, data["assignee_id"], field_name="assignee_id") if data["assignee_id"] else None
        changed.append("assignee")
    if "labels" in data:
        for label in data["labels"]:
            if not LABEL_RE.match(label):
                raise ValidationFailed(fields={"labels": ["Labels may use letters, digits, spaces and . & / + - (up to 40)."]})
        it.labels = data["labels"]
        changed.append("labels")
    if "status" in data:
        it.status = data["status"]
        changed.append("status")
    it.save(update_fields=[f if f != "assignee" else "assignee" for f in changed] + ["updated_at"])
    access.audit_write(request, actor, "update", it, fields=changed)
    return it


def mark_read(actor, item_ids, *, read: bool = True) -> int:
    ids = [_uuid(i, "item_ids") for i in item_ids]
    found = list(access.for_actor(actor, InboxItem).filter(pk__in=ids).values_list("pk", flat=True))
    if len(set(found)) != len(set(ids)):
        raise ValidationFailed(fields={"item_ids": ["Unknown or inaccessible ID."]})
    now = timezone.now()
    if read:
        for pk in found:
            InboxReadState.objects.update_or_create(item_id=pk, user=actor.user, defaults={"read_at": now})
    else:
        InboxReadState.objects.filter(item_id__in=found, user=actor.user).delete()
    return len(found)


# --- mutes --------------------------------------------------------------------------------------------

MATRIX_GROUP_RE = re.compile(r"^matrix:![^:\s]{1,200}(:[^\s]{1,200})?$")
# Workspace notifications (apps.automation) are grouped by their own group key.
NOTIFICATION_GROUP_RE = re.compile(r"^nexus:[A-Za-z0-9:._-]{1,190}$")


def add_mute(request, actor, body: dict) -> InboxMute:
    data = validate(body, {"group_key": F.string(max_length=200, required=True, blank=False), "label": F.string(max_length=200)})
    key = data["group_key"]
    if key.startswith("matrix:"):
        if not MATRIX_GROUP_RE.match(key):
            raise ValidationFailed(fields={"group_key": ["Not a chat room ID."]})
    elif key.startswith("nexus:"):
        if not NOTIFICATION_GROUP_RE.match(key):
            raise ValidationFailed(fields={"group_key": ["Not a notification group."]})
    elif not access.for_actor(actor, InboxItem).filter(group_key=key).exists():
        raise ValidationFailed(fields={"group_key": ["Unknown or inaccessible group."]})
    mute, _ = InboxMute.objects.get_or_create(workspace=actor.workspace, user=actor.user, group_key=key,
                                              defaults={"label": data["label"], "created_by": actor.user})
    access.audit_write(request, actor, "create", mute, fields=["group_key"])
    return mute


def remove_mute(request, actor, mute_id) -> None:
    mute = access.get_for_actor(actor, InboxMute, mute_id, access.DELETE)
    access.audit_write(request, actor, "delete", mute)
    mute.delete()


# --- links to records ---------------------------------------------------------------------------------

TIMELINE_TYPES = {"crm.contact", "crm.opportunity"}


def add_link(request, actor, item_id, body: dict) -> InboxLink:
    it = _get_item(actor, item_id, CHANGE)
    data = validate(body, {"target": F.object(max_keys=2, required=True)})
    target_type = data["target"].get("type")
    target = access.resolve_ref(actor, target_type if isinstance(target_type, str) else "", data["target"].get("id"), field_name="target")
    access.require(actor, Cap.ACTIVITIES_CREATE, "Your role can't link items to records.")
    if InboxLink.objects.filter(item=it, target_type=target_type, target_id=target.pk).exists():
        raise Conflict("This item is already linked to that record.")
    activity = None
    if target_type in TIMELINE_TYPES:
        kind = crm.Activity.Kind.EMAIL if it.source == Provider.GMAIL else crm.Activity.Kind.INTEGRATION_EVENT
        prefix = {Provider.GMAIL: "Email", Provider.SLACK: "Slack message", Provider.GOHIGHLEVEL: "HighLevel"}[it.source]
        activity = record_external_activity(
            actor.workspace, provider=it.source, kind=kind, summary=f"{prefix}: {it.title}"[:300], body=it.snippet[:2000],
            external_ref=it.external_id, occurred_at=it.occurred_at,
            contact=target if target_type == "crm.contact" else None, opportunity=target if target_type == "crm.opportunity" else None,
            metadata={"inbox_item_id": str(it.pk), "linked_by": str(actor.user.public_id), "mock": it.connection.is_mock},
        )
    ln = InboxLink.objects.create(workspace=actor.workspace, created_by=actor.user, item=it, target_type=target_type, target_id=target.pk,
                                  activity=activity, is_demo=it.is_demo)
    access.audit_write(request, actor, "create", ln, fields=["item", "target"], extra={"target_type": target_type})
    return ln


def remove_link(request, actor, item_id, link_id) -> None:
    it = _get_item(actor, item_id)
    ln = access.get_for_actor(actor, InboxLink, link_id, access.DELETE, queryset=access.for_actor(actor, InboxLink).filter(item=it))
    if ln.activity_id:
        crm.Activity.objects.filter(pk=ln.activity_id, workspace_id=actor.workspace_id, untrusted=True).delete()
    access.audit_write(request, actor, "delete", ln, fields=["item", "target"])
    ln.delete()


_DIGITS = re.compile(r"\D+")


def _phone_key(value: str) -> str:
    digits = _DIGITS.sub("", value or "")
    return digits[-10:] if len(digits) >= 7 else ""


def contact_suggestions(actor, emails: list[str], phones: list[str] = (), exclude_ids=()) -> list[dict]:
    """Internal contacts that share an email address or phone number. Suggestions only: a
    person decides; nothing is ever merged or linked automatically."""
    emails = sorted({e.strip().lower() for e in emails if e and "@" in e})[:20]
    keys = {_phone_key(p) for p in phones if _phone_key(p)}
    if not emails and not keys:
        return []
    qs = access.for_actor(actor, crm.Contact).filter(archived_at__isnull=True).exclude(pk__in=list(exclude_ids))
    cond = Q()
    for e in emails:
        cond |= Q(email__iexact=e)
    for k in keys:
        cond |= Q(phone__endswith=k[-4:])
    out = []
    for c in qs.filter(cond)[:20]:
        if c.email and c.email.lower() in emails:
            reason = f"Same email address ({c.email})"
        elif _phone_key(c.phone) in keys:
            reason = "Same phone number"
        else:
            continue
        out.append({"type": "crm.contact", "id": str(c.pk), "label": c.display_name, "reason": reason, "email": c.email})
    return out[:10]


def item_suggestions(actor, item_id) -> list[dict]:
    it = _get_item(actor, item_id)
    linked = InboxLink.objects.filter(item=it, target_type="crm.contact").values_list("target_id", flat=True)
    emails = [p.get("address", "") for p in it.participants or [] if isinstance(p, dict)]
    phones = [p.get("address", "") for p in it.participants or [] if isinstance(p, dict) and "@" not in (p.get("address") or "")]
    if it.source == Provider.GMAIL:
        emails += list(it.email_messages.values_list("from_address", flat=True))
    return contact_suggestions(actor, emails, phones, exclude_ids=list(linked))


# --- Gmail ------------------------------------------------------------------------------------------


def _own_gmail(actor, connection_id=None) -> list[IntegrationConnection]:
    qs = (IntegrationConnection.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GMAIL, owner=actor.user)
          .exclude(status=IntegrationConnection.Status.DISCONNECTED))
    if connection_id:
        qs = qs.filter(pk=_uuid(connection_id, "connection_id"))
        if not qs.exists():
            raise ValidationFailed(fields={"connection_id": ["Unknown or inaccessible ID."]})
    return list(qs)


def search_email(actor, query: str, *, connection_id=None, limit: int = 20) -> list[dict]:
    """Searches the actor's own connected mailboxes with Gmail's query syntax (live)."""
    query = (query or "").strip()
    if not query or len(query) > 500:
        raise ValidationFailed(fields={"q": ["Enter a search of up to 500 characters."]})
    conns = _own_gmail(actor, connection_id)
    if not conns:
        raise Conflict("Connect your Gmail first.", code="not_connected")
    items: list[InboxItem] = []
    for conn in conns:
        if conn.status == IntegrationConnection.Status.NEEDS_REAUTH:
            continue
        with provider_call(conn):
            items += adapter_for(Provider.GMAIL).search(conn, query, limit=limit)
    ids = [i.pk for i in items]
    rows = list(inbox_queryset(actor, status="all", muted="include").filter(pk__in=ids))
    order = {pk: n for n, pk in enumerate(ids)}
    rows.sort(key=lambda r: order.get(r.pk, 0))
    return serialize_items(actor, rows)


def get_thread(actor, item_id, *, include_bodies: bool = False) -> dict:
    data = get_inbox_item(actor, item_id)
    if data["source"] != Provider.GMAIL:
        raise ValidationFailed(fields={"item_id": ["Not an email thread."]})
    if include_bodies:
        it = _get_item(actor, item_id)
        for m in data["messages"]:
            m["body"] = message_body(None, actor, it.pk, m["id"])["text"]
    return data


def _message(actor, item_id, message_id) -> tuple[InboxItem, EmailMessage]:
    it = _get_item(actor, item_id)
    if it.source != Provider.GMAIL:
        raise Http404()
    msg = access.get_for_actor(actor, EmailMessage, message_id, queryset=access.for_actor(actor, EmailMessage).filter(item=it))
    return it, msg


def message_body(request, actor, item_id, message_id) -> dict:
    it, msg = _message(actor, item_id, message_id)
    conn = it.connection
    if conn.status == IntegrationConnection.Status.NEEDS_REAUTH:
        raise ApiError("Reconnect Gmail to open messages.", code="reauth_required", status=409)
    with provider_call(conn):
        body = adapter_for(Provider.GMAIL).message_body(conn, msg)
    access.audit_read(request, actor, msg, reason="email_body")
    return {"message_id": str(msg.pk), "untrusted": True, "remote_images": "blocked", **body}


def attachment(request, actor, item_id, message_id, attachment_id: str) -> tuple[bytes, dict]:
    it, msg = _message(actor, item_id, message_id)
    meta = next((a for a in msg.attachments or [] if a.get("id") == attachment_id), None)
    if meta is None:
        raise Http404()
    with provider_call(it.connection):
        data = adapter_for(Provider.GMAIL).attachment(it.connection, msg, attachment_id)
    access.audit_read(request, actor, msg, reason="email_attachment")
    return data, meta


DRAFT_SPEC = {
    "body": F.string(max_length=50000, multiline=True, required=True, blank=False),
    "to": F.list(F.email(), max_items=20),
    "cc": F.list(F.email(), max_items=20),
}


def _reply_headers(it: InboxItem, actor_address: str) -> tuple[list[str], str, str, str]:
    msgs = list(it.email_messages.order_by("sent_at"))
    if not msgs:
        raise ValidationFailed("This thread has no messages to reply to.")
    last_in = next((m for m in reversed(msgs) if m.from_address and m.from_address != actor_address), msgs[-1])
    to = [last_in.reply_to or last_in.from_address] if (last_in.reply_to or last_in.from_address) else []
    subject = msgs[0].subject or it.title or ""
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    last = msgs[-1]
    return [t for t in to if t], subject[:300], last.rfc_message_id, last.references


def _require_reply(actor, it: InboxItem) -> IntegrationConnection:
    caps = s.capabilities(actor, it)
    if it.source != Provider.GMAIL:
        raise ValidationFailed(fields={"item_id": ["Only email threads have drafts."]})
    if not caps["reply"]:
        raise PermissionDenied(caps["reply_unsupported_reason"] or "You can't reply to this thread.")
    if it.connection.status != IntegrationConnection.Status.CONNECTED and it.connection.status != IntegrationConnection.Status.ERROR:
        raise ApiError("Reconnect Gmail to draft replies.", code="reauth_required", status=409)
    return it.connection


def create_reply_draft(request, actor, item_id, body: dict) -> EmailDraft:
    """Creates a reply draft in the person's Gmail (nothing is sent)."""
    it = _get_item(actor, item_id, CHANGE)
    conn = _require_reply(actor, it)
    data = validate(body, DRAFT_SPEC)
    to, subject, in_reply_to, references = _reply_headers(it, conn.account_id)
    to = data["to"] or to
    if not to:
        raise ValidationFailed(fields={"to": ["Add at least one recipient."]})
    adapter = adapter_for(Provider.GMAIL)
    raw = adapter.build_raw(sender=conn.account_id, to=to, cc=data["cc"], subject=subject, body=data["body"], in_reply_to=in_reply_to,
                            references=references)
    with provider_call(conn):
        draft_id = adapter.create_draft(conn, raw=raw, thread_id=it.data.get("thread_id") or it.external_id)
    d = EmailDraft.objects.create(workspace=actor.workspace, created_by=actor.user, item=it, connection=conn, external_draft_id=draft_id,
                                  to=to, cc=data["cc"], subject=subject, body=data["body"], in_reply_to=in_reply_to, references=references,
                                  is_demo=conn.is_mock)
    access.audit_write(request, actor, "create", d, fields=["to", "cc", "subject", "body"])
    return d


def update_draft(request, actor, draft_id, body: dict) -> EmailDraft:
    d = access.get_for_actor(actor, EmailDraft, draft_id, CHANGE)
    if d.status != EmailDraft.Status.DRAFT:
        raise Conflict("This draft was already sent or discarded.")
    data = validate(body, DRAFT_SPEC, partial=True)
    for k in ("body", "to", "cc"):
        if k in data:
            setattr(d, k, data[k])
    if not d.to:
        raise ValidationFailed(fields={"to": ["Add at least one recipient."]})
    adapter = adapter_for(Provider.GMAIL)
    raw = adapter.build_raw(sender=d.connection.account_id, to=d.to, cc=d.cc, subject=d.subject, body=d.body, in_reply_to=d.in_reply_to,
                            references=d.references)
    with provider_call(d.connection):
        adapter.update_draft(d.connection, d.external_draft_id, raw=raw, thread_id=d.item.data.get("thread_id") or d.item.external_id)
    d.save()
    access.audit_write(request, actor, "update", d, fields=list(data))
    return d


def discard_draft(request, actor, draft_id) -> None:
    d = access.get_for_actor(actor, EmailDraft, draft_id, access.DELETE)
    if d.status == EmailDraft.Status.DRAFT and d.external_draft_id:
        with provider_call(d.connection):
            adapter_for(Provider.GMAIL).delete_draft(d.connection, d.external_draft_id)
    d.status = EmailDraft.Status.DISCARDED
    d.body = ""
    d.save(update_fields=["status", "body", "updated_at"])
    access.audit_write(request, actor, "discard", d)


# --- Slack ------------------------------------------------------------------------------------------


def list_slack_messages(actor, *, channel_id=None, q=None, limit: int = 50) -> list[dict]:
    """Stored messages of the selected Slack channels (external, untrusted)."""
    qs = inbox_queryset(actor, source=Provider.SLACK, status="all", muted="include", q=q)
    if channel_id:
        qs = qs.filter(data__channel=str(channel_id)[:40])
    return serialize_items(actor, list(qs[: max(1, min(limit, 200))]))


def slack_channels(actor, connection_id) -> list[dict]:
    conn = access.get_for_actor(actor, IntegrationConnection, connection_id)
    if conn.provider != Provider.SLACK:
        raise Http404()
    access.get_for_actor(actor, IntegrationConnection, conn.pk, CHANGE)
    with provider_call(conn):
        channels = adapter_for(Provider.SLACK).channels(conn)
    selected = {c["id"] for c in (conn.settings or {}).get("channels") or []}
    return [{**c, "selected": c["id"] in selected, "untrusted": True} for c in channels]


def slack_permalink(actor, item_id) -> str:
    it = _get_item(actor, item_id)
    if it.source != Provider.SLACK:
        raise Http404()
    if it.external_url:
        return it.external_url
    with provider_call(it.connection):
        link = adapter_for(Provider.SLACK).permalink(it.connection, it.data.get("channel", ""), it.data.get("ts", ""))
    if link:
        InboxItem.objects.filter(pk=it.pk).update(external_url=link[:500])
    return link


# --- GoHighLevel ------------------------------------------------------------------------------------


def ghl_connection(actor, connection_id=None) -> IntegrationConnection:
    qs = access.for_actor(actor, IntegrationConnection).filter(provider=Provider.GOHIGHLEVEL).exclude(status=IntegrationConnection.Status.DISCONNECTED)
    if connection_id:
        qs = qs.filter(pk=_uuid(connection_id, "connection_id"))
    conn = qs.order_by("created_at").first()
    if conn is None:
        raise Conflict("Connect GoHighLevel first.", code="not_connected")
    return conn


def _contact_ext_id(conn, external_id: str) -> str:
    return f"{conn.account_id}:contact:{external_id}"


def _mapped_contacts(actor, conn, external_ids: list[str]) -> dict[str, dict]:
    maps = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, object_type="crm.contact",
                                                    external_id__in=[_contact_ext_id(conn, e) for e in external_ids])
    by_obj = {m.object_id: m for m in maps}
    visible = {c.pk: c for c in access.for_actor(actor, crm.Contact).filter(pk__in=list(by_obj))}
    out = {}
    for obj_id, m in by_obj.items():
        ext = m.external_id.split(":contact:", 1)[1]
        c = visible.get(obj_id)
        out[ext] = {"linked": True, "contact": {"id": str(c.pk), "display_name": c.display_name} if c else None}
    return out


def _ghl_contact_out(actor, conn, c: dict, mapped: dict) -> dict:
    from .providers.gohighlevel import ghl_contact_url

    m = mapped.get(c["id"]) or {"linked": False, "contact": None}
    out = {**c, "external": True, "untrusted": True, "is_mock": conn.is_mock, "external_url": ghl_contact_url(conn, c["id"]),
           "mapping": m}
    if not m["linked"]:
        out["suggestions"] = contact_suggestions(actor, [c.get("email") or ""], [c.get("phone") or ""])
    return out


def ghl_conversation(request, actor, item_id) -> dict:
    """The latest messages of a HighLevel conversation, fetched now (read-only, untrusted)."""
    it = _get_item(actor, item_id)
    if it.source != Provider.GOHIGHLEVEL:
        raise Http404()
    conv_id = it.external_id if it.kind == InboxItem.Kind.GHL_CONVERSATION else it.data.get("conversation_id", "")
    if not conv_id:
        return {"messages": [], "untrusted": True}
    with provider_call(it.connection):
        rows = adapter_for(Provider.GOHIGHLEVEL).conversation_messages(it.connection, conv_id, limit=20)
    access.audit_read(request, actor, it, reason="ghl_conversation")
    return {"messages": [{**r, "untrusted": True} for r in rows], "untrusted": True, "read_only": True,
            "external_url": it.external_url}


def ghl_search_contacts(actor, query: str, *, connection_id=None, limit: int = 20) -> list[dict]:
    conn = ghl_connection(actor, connection_id)
    query = (query or "").strip()[:100]
    with provider_call(conn):
        rows = adapter_for(Provider.GOHIGHLEVEL).search_contacts(conn, query, limit=limit)
    mapped = _mapped_contacts(actor, conn, [r["id"] for r in rows])
    return [_ghl_contact_out(actor, conn, r, mapped) for r in rows]


def ghl_get_contact(actor, external_id: str, *, connection_id=None) -> dict:
    conn = ghl_connection(actor, connection_id)
    adapter = adapter_for(Provider.GOHIGHLEVEL)
    with provider_call(conn):
        c = adapter.get_contact(conn, external_id)
        tasks = adapter.contact_tasks(conn, external_id)
        appointments = adapter.contact_appointments(conn, external_id)
    out = _ghl_contact_out(actor, conn, c, _mapped_contacts(actor, conn, [c["id"]]))
    out["tasks"] = tasks
    out["appointments"] = appointments
    return out


def ghl_link_contact(request, actor, external_id: str, body: dict, *, connection_id=None) -> dict:
    """Maps a HighLevel contact to an internal contact. Dedup by HighLevel ID: one internal
    contact per HighLevel contact (and vice versa) per connected sub-account."""
    from .providers.base import upsert_mapping

    conn = ghl_connection(actor, connection_id)
    data = validate(body, {"contact_id": F.uuid(required=True)})
    contact = access.resolve_one(actor, crm.Contact, data["contact_id"], field_name="contact_id", action=CHANGE)
    ext = _contact_ext_id(conn, external_id[:200])
    existing = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, external_id=ext).first()
    if existing and existing.object_id != contact.pk:
        raise Conflict("That HighLevel contact is already linked to another contact. Unlink it first.", code="already_linked")
    other = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, object_type="crm.contact",
                                                     object_id=contact.pk, external_id__startswith=f"{conn.account_id}:contact:").exclude(external_id=ext)
    if other.exists():
        raise Conflict("This contact is already linked to a different HighLevel contact. Unlink it first.", code="already_linked")
    with provider_call(conn):
        summary = adapter_for(Provider.GOHIGHLEVEL).get_contact(conn, external_id)
    from .providers.gohighlevel import ghl_contact_url

    upsert_mapping(conn, ext, contact, external_url=ghl_contact_url(conn, summary["id"]))
    access.audit_write(request, actor, "link_external", contact, fields=["external_mapping"], extra={"provider": Provider.GOHIGHLEVEL})
    return {"linked": True, "contact": {"id": str(contact.pk), "display_name": contact.display_name}}


def ghl_unlink_contact(request, actor, external_id: str, *, connection_id=None) -> None:
    conn = ghl_connection(actor, connection_id)
    m = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL,
                                                 external_id=_contact_ext_id(conn, external_id[:200])).first()
    if m is None:
        raise Http404()
    contact = access.get_for_actor(actor, crm.Contact, m.object_id, CHANGE)
    m.delete()
    access.audit_write(request, actor, "unlink_external", contact, fields=["external_mapping"], extra={"provider": Provider.GOHIGHLEVEL})


def ghl_import_contact(request, actor, external_id: str, *, connection_id=None) -> dict:
    """Creates an internal contact from a HighLevel contact (an explicit person action) and
    maps them. Refused if the HighLevel contact is already mapped."""
    from apps.crm.services import create_contact

    from .providers.base import upsert_mapping
    from .providers.gohighlevel import ghl_contact_url

    conn = ghl_connection(actor, connection_id)
    ext = _contact_ext_id(conn, external_id[:200])
    if crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, external_id=ext).exists():
        raise Conflict("That HighLevel contact is already linked to a contact.", code="already_linked")
    with provider_call(conn):
        c = adapter_for(Provider.GOHIGHLEVEL).get_contact(conn, external_id)
    email = (c.get("email") or "").strip().lower()
    body = {"first_name": (c.get("firstName") or "")[:80], "last_name": (c.get("lastName") or "")[:80],
            "company": (c.get("companyName") or "")[:120], "email": email if "@" in email else "",
            "phone": c.get("phone") or "", "source": "GoHighLevel"}
    if not (body["first_name"] or body["last_name"] or body["company"] or body["email"]):
        body["first_name"] = (c.get("display_name") or "HighLevel contact")[:80]
    try:
        contact = create_contact(request, actor, body)
    except ValidationFailed:
        body["phone"] = ""
        contact = create_contact(request, actor, body)
    upsert_mapping(conn, ext, contact, external_url=ghl_contact_url(conn, c["id"]))
    return {"linked": True, "contact": {"id": str(contact.pk), "display_name": contact.display_name}}


def ghl_list_records(actor, kind: str, *, q=None, connection_id=None, limit: int = 100) -> list[dict]:
    conn = ghl_connection(actor, connection_id)
    qs = access.for_actor(actor, ExternalRecord).filter(connection=conn, kind=kind)
    if q:
        qs = qs.filter(title__icontains=str(q)[:100])
    rows = list(qs.order_by("title")[: max(1, min(limit, 200))])
    mapped = {}
    if kind == ExternalRecord.Kind.OPPORTUNITY:
        maps = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, object_type="crm.opportunity",
                                                        external_id__in=[f"{conn.account_id}:opportunity:{r.external_id}" for r in rows])
        visible = {o.pk: o for o in access.for_actor(actor, crm.Opportunity).filter(pk__in=[m.object_id for m in maps])}
        for m in maps:
            o = visible.get(m.object_id)
            mapped[m.external_id.rsplit(":", 1)[1]] = {"id": str(o.pk), "name": o.name} if o else None
    return [{"id": str(r.pk), "external_id": r.external_id, "kind": r.kind, "title": r.title, "data": r.data, "fetched_at": r.fetched_at,
             "external": True, "untrusted": True, "is_mock": conn.is_mock,
             **({"linked_opportunity": mapped.get(r.external_id)} if kind == ExternalRecord.Kind.OPPORTUNITY else {})} for r in rows]


def ghl_list_opportunities(actor, *, q=None, connection_id=None) -> list[dict]:
    return ghl_list_records(actor, ExternalRecord.Kind.OPPORTUNITY, q=q, connection_id=connection_id)


def ghl_link_opportunity(request, actor, external_id: str, body: dict, *, connection_id=None) -> dict:
    from .providers.base import upsert_mapping

    conn = ghl_connection(actor, connection_id)
    rec = access.for_actor(actor, ExternalRecord).filter(connection=conn, kind=ExternalRecord.Kind.OPPORTUNITY, external_id=external_id[:200]).first()
    if rec is None:
        raise Http404()
    data = validate(body, {"opportunity_id": F.uuid(required=True)})
    opp = access.resolve_one(actor, crm.Opportunity, data["opportunity_id"], field_name="opportunity_id", action=CHANGE)
    ext = f"{conn.account_id}:opportunity:{rec.external_id}"
    existing = crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, external_id=ext).first()
    if existing and existing.object_id != opp.pk:
        raise Conflict("That HighLevel opportunity is already linked to another deal. Unlink it first.", code="already_linked")
    upsert_mapping(conn, ext, opp)
    access.audit_write(request, actor, "link_external", opp, fields=["external_mapping"], extra={"provider": Provider.GOHIGHLEVEL})
    return {"id": str(opp.pk), "name": opp.name}


def ghl_workflows(actor, *, connection_id=None) -> dict:
    conn = ghl_connection(actor, connection_id)
    with provider_call(conn):
        rows = adapter_for(Provider.GOHIGHLEVEL).workflows(conn)
    return {"workflows": [{**w, "external": True, "untrusted": True} for w in rows], "triggers_active": workflow_triggers_allowed(conn),
            "triggers_enabled": bool((conn.settings or {}).get("workflow_triggers_enabled"))}


def workflow_triggers_allowed(conn: IntegrationConnection) -> bool:
    """Starting HighLevel workflows: never outside production, never in mock mode, and only
    after an owner/admin enabled it for this connection (each start is then confirmed)."""
    from django.conf import settings

    return (settings.NEXUS_ENVIRONMENT == "production" and not conn.is_mock
            and bool((conn.settings or {}).get("workflow_triggers_enabled")))
