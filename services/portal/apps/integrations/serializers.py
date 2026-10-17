"""JSON shapes of integrations and inbox items. Tokens and secrets are never serialized;
everything that came from a provider is marked ``external`` and ``untrusted``."""

from __future__ import annotations

from apps.crm import access
from apps.crm.access import Cap
from apps.crm.serializers import user_ref

from . import conf
from .models import EmailDraft, EmailMessage, InboxItem, InboxLink, IntegrationConnection, PendingAction, Provider

SOURCE_LABEL = {Provider.GMAIL: "Gmail", Provider.SLACK: "Slack", Provider.GOHIGHLEVEL: "GoHighLevel"}
# What kind of thing an item is, for the inbox's source badges (never "native": native chat
# is merged in the browser only).
ORIGIN = {
    InboxItem.Kind.EMAIL_THREAD: "synced_email",
    InboxItem.Kind.SLACK_MESSAGE: "external_message",
    InboxItem.Kind.GHL_CONVERSATION: "external_message",
    InboxItem.Kind.MISSED_CALL: "external_notification",
}


def connection(actor, c: IntegrationConnection, *, detail: bool = False) -> dict:
    spec = conf.spec(c.provider)
    wanted = set(_wanted_scopes(c))
    granted = list(c.granted_scopes or [])
    can_manage = access.for_actor(actor, IntegrationConnection, access.CHANGE).filter(pk=c.pk).exists()
    data = {
        "id": str(c.pk),
        "provider": c.provider,
        "provider_label": spec.label,
        "scope": c.scope,
        "account": {"id": c.account_id if (c.scope == IntegrationConnection.Scope.WORKSPACE or c.owner_id == actor.user.pk
                                           or actor.can(Cap.INTEGRATIONS_OWN)) else "",
                    "label": c.account_label},
        "owner": user_ref(c.owner),
        "is_mine": c.owner_id == actor.user.pk,
        "status": c.status,
        "status_label": c.get_status_display(),
        "auth_method": c.auth_method,
        "is_mock": c.is_mock,
        "mock_label": conf.MOCK_LABEL if c.is_mock else None,
        "granted_scopes": granted,
        "missing_scopes": sorted(wanted - set(granted)) if c.auth_method == IntegrationConnection.AuthMethod.OAUTH else [],
        "connected_at": c.connected_at,
        "last_sync_at": c.last_sync_at,
        "next_sync_at": c.next_sync_at,
        "last_webhook_at": c.last_webhook_at,
        "syncing": bool(c.sync_lease_until),
        "last_error": ({"code": c.last_error_code, "message": c.last_error_message, "at": c.last_error_at} if c.last_error_code else None),
        "actions": {
            "reconnect": can_manage and c.auth_method == IntegrationConnection.AuthMethod.OAUTH and c.status != IntegrationConnection.Status.DISCONNECTED,
            "retry": can_manage and c.status in {IntegrationConnection.Status.CONNECTED, IntegrationConnection.Status.ERROR},
            "disconnect": can_manage and c.status != IntegrationConnection.Status.DISCONNECTED,
        },
        "permissions": {"change": can_manage, "delete": can_manage},
        "settings": safe_settings(actor, c),
    }
    return data


def _wanted_scopes(c: IntegrationConnection) -> list[str]:
    from .providers import adapter_for

    options = {"private_channels": bool((c.settings or {}).get("private_channels"))} if c.provider == Provider.SLACK else {}
    return adapter_for(c.provider).scopes(options)


def safe_settings(actor, c: IntegrationConnection) -> dict:
    s = c.settings or {}
    if c.provider == Provider.SLACK:
        member_map = s.get("member_map") or {}
        return {
            "channels": [{"id": ch.get("id"), "name": ch.get("name"), "is_private": bool(ch.get("is_private"))} for ch in s.get("channels") or []],
            "private_channels": bool(s.get("private_channels")),
            "my_slack_user_id": member_map.get(str(actor.user.public_id), ""),
        }
    if c.provider == Provider.GOHIGHLEVEL:
        from .services import workflow_triggers_allowed

        return {"workflow_triggers_enabled": bool(s.get("workflow_triggers_enabled")),
                "workflow_triggers_active": workflow_triggers_allowed(c),
                "environment_blocks_workflows": not conf_production()}
    return {}


def conf_production() -> bool:
    from django.conf import settings

    return settings.NEXUS_ENVIRONMENT == "production"


def target_ref(actor, type_label: str, target_id) -> dict | None:
    """A linked record, only if the actor may see it."""
    model = access._TYPES.get(type_label)
    if model is None:
        return None
    obj = access.for_actor(actor, model).filter(pk=target_id).first()
    if obj is None:
        return None
    label = getattr(obj, "display_name", None) or getattr(obj, "name", None) or getattr(obj, "title", None) or str(obj)
    return {"type": type_label, "id": str(obj.pk), "label": str(label)[:200]}


def link(actor, ln: InboxLink) -> dict | None:
    target = target_ref(actor, ln.target_type, ln.target_id)
    if target is None:
        return None
    return {"id": str(ln.id), "target": target, "created_by": user_ref(ln.created_by), "created_at": ln.created_at,
            "on_timeline": bool(ln.activity_id),
            "permissions": {"delete": access.for_actor(actor, InboxLink, access.DELETE).filter(pk=ln.pk).exists()}}


def item(actor, it: InboxItem, *, unread: bool | None = None, muted: bool | None = None, links: list | None = None, detail: bool = False,
         can_change: bool | None = None) -> dict:
    conn = it.connection
    spec = conf.spec(it.source)
    data = dict(it.data or {})
    out = {
        "id": str(it.pk),
        "type": "integrations.inboxitem",
        "source": it.source,
        "source_label": SOURCE_LABEL.get(it.source, it.source),
        "kind": it.kind,
        "kind_label": it.get_kind_display(),
        "origin": ORIGIN.get(it.kind, "external_message"),
        "external": True,
        "untrusted": True,
        "is_mock": conn.is_mock,
        "mock_label": conf.MOCK_LABEL if conn.is_mock else None,
        "visibility": it.visibility,
        "title": it.title,
        "snippet": it.snippet if it.kind != InboxItem.Kind.EMAIL_THREAD or detail else it.snippet[:300],
        "participants": it.participants,
        "occurred_at": it.occurred_at,
        "unread": bool(unread) if unread is not None else False,
        "provider_unread": it.provider_unread,
        "priority": it.priority,
        "assignee": user_ref(it.assignee),
        "labels": list(it.labels or []),
        "status": it.status,
        "group": {"key": it.group_key, "label": it.group_label},
        "muted": bool(muted),
        "message_count": it.message_count,
        "has_attachments": it.has_attachments,
        "external_url": it.external_url,
        "open_label": spec.open_label,
        "connection": {"id": str(conn.pk), "provider": conn.provider, "account_label": conn.account_label, "status": conn.status},
        "links": [x for x in (links or []) if x],
        "meta": _meta(it, data),
        "capabilities": capabilities(actor, it, can_change=can_change),
    }
    return out


def _meta(it: InboxItem, data: dict) -> dict:
    if it.source == Provider.SLACK:
        return {"channel": data.get("channel_name"), "channel_id": data.get("channel"), "ts": data.get("ts"), "thread_ts": data.get("thread_ts"),
                "author": data.get("user_name") or data.get("user"), "mentions": data.get("mentions") or [],
                "mentions_app": bool(data.get("mentions_app")), "bot": bool(data.get("bot"))}
    if it.source == Provider.GMAIL:
        shown = {"INBOX", "UNREAD", "IMPORTANT", "STARRED", "SENT"}
        return {"thread_id": data.get("thread_id"), "labels": [x for x in data.get("label_ids") or [] if x in shown],
                "outgoing": bool(data.get("outgoing"))}
    return {"contact_id": data.get("contact_id"), "last_message_type": data.get("last_message_type"), "call_status": data.get("call_status")}


def capabilities(actor, it: InboxItem, *, can_change: bool | None = None) -> dict:
    conn = it.connection
    scopes = set(conn.granted_scopes or [])
    if can_change is None:
        can_change = access.for_actor(actor, InboxItem, access.CHANGE).filter(pk=it.pk).exists()
    caps = {"change": can_change, "link": can_change and actor.can(Cap.ACTIVITIES_CREATE), "reply": False, "reply_unsupported_reason": ""}
    if it.source == Provider.GMAIL:
        if it.owner_id != actor.user.pk:
            caps["reply_unsupported_reason"] = "Only the mailbox owner can reply."
        elif "https://www.googleapis.com/auth/gmail.compose" not in scopes:
            caps["reply_unsupported_reason"] = "Drafting replies wasn't allowed when Gmail was connected. Reconnect to allow it."
        else:
            caps["reply"] = True
    elif it.source == Provider.SLACK:
        if "chat:write" not in scopes:
            caps["reply_unsupported_reason"] = "Posting wasn't allowed when Slack was connected."
        elif not actor.can(Cap.ACTIVITIES_CREATE):
            caps["reply_unsupported_reason"] = "Your role can't post to Slack."
        else:
            caps["reply"] = True
    else:
        caps["reply_unsupported_reason"] = "Replying to HighLevel conversations isn't supported here. Open it in HighLevel to reply."
    return caps


def email_message(m: EmailMessage) -> dict:
    return {
        "id": str(m.pk), "external_id": m.external_id, "from": {"name": m.from_name, "address": m.from_address}, "reply_to": m.reply_to,
        "to": m.to, "cc": m.cc, "subject": m.subject, "sent_at": m.sent_at, "snippet": m.snippet,
        "outgoing": "SENT" in (m.label_ids or []), "unread": "UNREAD" in (m.label_ids or []),
        "attachments": [{"id": a.get("id"), "filename": a.get("filename"), "mime_type": a.get("mime_type"), "size": a.get("size")}
                        for a in m.attachments or []],
        "untrusted": True,
    }


def draft(d: EmailDraft) -> dict:
    return {"id": str(d.pk), "item_id": str(d.item_id), "to": d.to, "cc": d.cc, "subject": d.subject,
            "body": d.body if d.status == EmailDraft.Status.DRAFT else "", "status": d.status, "status_label": d.get_status_display(),
            "sent_at": d.sent_at, "last_error_code": d.last_error_code, "created_at": d.created_at, "updated_at": d.updated_at}


def action(a: PendingAction, *, token: str | None = None) -> dict:
    out = {"id": str(a.pk), "kind": a.kind, "kind_label": a.get_kind_display(), "status": a.status, "status_label": a.get_status_display(),
           "preview": a.preview, "expires_at": a.expires_at, "result": a.result,
           "error": {"code": a.error_code, "message": a.error_message} if a.error_code else None,
           "connection": {"id": str(a.connection_id), "provider": a.connection.provider, "is_mock": a.connection.is_mock}}
    if token:
        out["confirmation_token"] = token  # returned once, to the person who must confirm
    return out
