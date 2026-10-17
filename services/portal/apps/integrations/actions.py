"""Consequential external actions need the person's explicit, two-step confirmation.

``prepare_*`` validates the request, builds a preview of exactly what will happen (the email
with its recipients and full text, the Slack channel and text, the HighLevel fields) and
returns a single-use confirmation token (random, 256 bits, stored hashed, valid for
``CONFIRM_SECONDS``). ``confirm`` runs the action only if the SAME person presents that token
before it expires and it was never used; the token is spent atomically before the provider
is called, so a replay or a double click can never send twice. Results are recorded only
after the provider confirmed success ("sent" means Gmail returned the sent message).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from django.core.exceptions import PermissionDenied
from django.http import Http404
from django.utils import timezone

from apps.api.errors import ApiError, Conflict, ValidationFailed
from apps.api.schema import F, validate
from apps.crm import access
from apps.crm import models as crm
from apps.crm.access import CHANGE, Cap

from . import services
from .errors import to_api_error
from .http import ProviderError, ProviderUnavailable
from .models import EmailDraft, IntegrationConnection, PendingAction, Provider
from .providers import adapter_for
from .providers.base import upsert_mapping

CONFIRM_SECONDS = 600


class ConfirmationRequired(ApiError):
    status, code, message = 403, "confirmation_invalid", "That confirmation isn't valid (expired, used, or not yours). Review the action again."


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _create(actor, conn: IntegrationConnection, kind: str, payload: dict, preview: dict) -> tuple[PendingAction, str]:
    token = secrets.token_urlsafe(32)
    # One open confirmation per target: re-reviewing replaces the older one.
    PendingAction.objects.filter(workspace_id=actor.workspace_id, user=actor.user, kind=kind, status=PendingAction.Status.PENDING,
                                 payload__target=payload.get("target")).update(status=PendingAction.Status.CANCELED, payload={})
    a = PendingAction.objects.create(workspace=actor.workspace, created_by=actor.user, user=actor.user, connection=conn, kind=kind,
                                     payload=payload, preview=preview, token_hash=_hash(token),
                                     expires_at=timezone.now() + timedelta(seconds=CONFIRM_SECONDS), is_demo=conn.is_mock)
    return a, token


def _draft_fingerprint(d: EmailDraft) -> str:
    return hashlib.sha256("\x1f".join([",".join(d.to), ",".join(d.cc), d.subject, d.body]).encode()).hexdigest()


# --- prepare ------------------------------------------------------------------------------------------


def prepare_send_draft(request, actor, draft_id) -> tuple[PendingAction, str]:
    d = access.get_for_actor(actor, EmailDraft, draft_id, CHANGE)
    if d.status != EmailDraft.Status.DRAFT:
        raise Conflict("This draft was already sent or discarded.")
    services._require_reply(actor, d.item)
    preview = {"from": d.connection.account_id, "to": d.to, "cc": d.cc, "subject": d.subject, "body": d.body,
               "thread": d.item.title, "provider": "Gmail", "is_mock": d.connection.is_mock}
    a, token = _create(actor, d.connection, PendingAction.Kind.GMAIL_SEND, {"target": str(d.pk), "fingerprint": _draft_fingerprint(d)}, preview)
    access.audit_write(request, actor, "prepare", a, fields=["kind"], extra={"kind": a.kind})
    return a, token


def prepare_slack_post(request, actor, body: dict) -> tuple[PendingAction, str]:
    data = validate(body, {
        "connection_id": F.uuid(required=True),
        "channel_id": F.string(max_length=40, required=True, blank=False),
        "text": F.string(max_length=4000, multiline=True, required=True, blank=False),
        "thread_ts": F.string(max_length=40),
    })
    conn = access.resolve_one(actor, IntegrationConnection, data["connection_id"], field_name="connection_id")
    if conn.provider != Provider.SLACK or conn.status not in {IntegrationConnection.Status.CONNECTED, IntegrationConnection.Status.ERROR}:
        raise ValidationFailed(fields={"connection_id": ["Not a connected Slack workspace."]})
    access.require(actor, Cap.ACTIVITIES_CREATE, "Your role can't post to Slack.")
    if "chat:write" not in (conn.granted_scopes or []):
        raise PermissionDenied("Posting wasn't allowed when Slack was connected.")
    channel = next((c for c in (conn.settings or {}).get("channels") or [] if c.get("id") == data["channel_id"]), None)
    if channel is None:
        raise ValidationFailed(fields={"channel_id": ["Only channels an admin selected can be posted to."]})
    preview = {"workspace": conn.account_label, "channel": f"#{channel.get('name')}", "text": data["text"],
               "in_thread": bool(data["thread_ts"]), "provider": "Slack", "is_mock": conn.is_mock}
    payload = {"target": f"{data['channel_id']}:{data['thread_ts']}", "channel": data["channel_id"], "text": data["text"],
               "thread_ts": data["thread_ts"], "channel_name": channel.get("name") or ""}
    a, token = _create(actor, conn, PendingAction.Kind.SLACK_POST, payload, preview)
    access.audit_write(request, actor, "prepare", a, fields=["kind"], extra={"kind": a.kind})
    return a, token


GHL_FIELDS = {"firstName": F.string(max_length=80), "lastName": F.string(max_length=80), "email": F.email(), "phone": F.phone()}


def prepare_ghl(request, actor, body: dict) -> tuple[PendingAction, str]:
    kind = (body or {}).get("kind")
    access.require(actor, Cap.RECORDS_CREATE, "Your role can't change HighLevel records.")
    conn = services.ghl_connection(actor, (body or {}).get("connection_id"))
    if conn.status not in {IntegrationConnection.Status.CONNECTED, IntegrationConnection.Status.ERROR}:
        raise Conflict("Reconnect GoHighLevel first.", code="reauth_required")
    adapter = adapter_for(Provider.GOHIGHLEVEL)
    if kind == "create_contact":
        data = validate(body, {"kind": F.string(max_length=30), "connection_id": F.uuid(null=True), "contact_id": F.uuid(required=True)})
        contact = access.resolve_one(actor, crm.Contact, data["contact_id"], field_name="contact_id")
        if crm.ExternalRecordMapping.objects.filter(workspace_id=actor.workspace_id, provider=Provider.GOHIGHLEVEL, object_type="crm.contact",
                                                    object_id=contact.pk, external_id__startswith=f"{conn.account_id}:contact:").exists():
            raise Conflict("This contact is already linked to a HighLevel contact.", code="already_linked")
        fields = {k: v for k, v in {"firstName": contact.first_name, "lastName": contact.last_name, "email": contact.email,
                                    "phone": contact.phone}.items() if v}
        duplicates = []
        try:
            if contact.email:
                duplicates = adapter.lookup_contacts(conn, email=contact.email)
        except ProviderError:
            duplicates = []
        preview = {"action": "Create a contact in HighLevel", "location": conn.account_label, "fields": fields,
                   "possible_duplicates": [{"id": d["id"], "display_name": d["display_name"], "email": d.get("email", "")} for d in duplicates],
                   "provider": "GoHighLevel", "is_mock": conn.is_mock}
        return _ghl_create(request, actor, conn, PendingAction.Kind.GHL_CREATE_CONTACT,
                           {"target": str(contact.pk), "contact_id": str(contact.pk), "fields": fields}, preview)
    if kind == "update_contact":
        data = validate(body, {"kind": F.string(max_length=30), "connection_id": F.uuid(null=True),
                               "external_id": F.string(max_length=120, required=True, blank=False), "fields": F.object(max_keys=4, required=True)})
        fields = validate(data["fields"], GHL_FIELDS, partial=True)
        if not fields:
            raise ValidationFailed(fields={"fields": ["Choose at least one field to change."]})
        from .errors import provider_call

        with provider_call(conn):
            current = adapter.get_contact(conn, data["external_id"])
        preview = {"action": "Update a contact in HighLevel", "location": conn.account_label, "contact": current.get("display_name"),
                   "changes": [{"field": k, "from": current.get(k, ""), "to": v} for k, v in fields.items()],
                   "provider": "GoHighLevel", "is_mock": conn.is_mock}
        return _ghl_create(request, actor, conn, PendingAction.Kind.GHL_UPDATE_CONTACT,
                           {"target": data["external_id"], "external_id": data["external_id"], "fields": fields}, preview)
    if kind == "add_to_workflow":
        data = validate(body, {"kind": F.string(max_length=30), "connection_id": F.uuid(null=True),
                               "external_id": F.string(max_length=120, required=True, blank=False),
                               "workflow_id": F.string(max_length=120, required=True, blank=False)})
        if not services.workflow_triggers_allowed(conn):
            raise PermissionDenied("Starting HighLevel workflows is turned off here. It's never available in test or development "
                                   "environments, and in production an owner or admin must enable it first.")
        preview = {"action": "Start a HighLevel workflow for a contact (customer-facing automation may run)",
                   "location": conn.account_label, "contact": data["external_id"], "workflow": data["workflow_id"],
                   "provider": "GoHighLevel", "is_mock": conn.is_mock}
        return _ghl_create(request, actor, conn, PendingAction.Kind.GHL_ADD_TO_WORKFLOW,
                           {"target": f"{data['external_id']}:{data['workflow_id']}", "external_id": data["external_id"],
                            "workflow_id": data["workflow_id"]}, preview)
    raise ValidationFailed(fields={"kind": ["Must be create_contact, update_contact or add_to_workflow."]})


def _ghl_create(request, actor, conn, kind, payload, preview):
    a, token = _create(actor, conn, kind, payload, preview)
    access.audit_write(request, actor, "prepare", a, fields=["kind"], extra={"kind": kind})
    return a, token


# --- confirm ------------------------------------------------------------------------------------------


def confirm(request, actor, action_id, body: dict) -> PendingAction:
    data = validate(body, {"confirmation_token": F.string(max_length=200, required=True, blank=False)})
    a = access.for_actor(actor, PendingAction).filter(pk=services._uuid(action_id)).select_related("connection").first()
    if a is None:
        raise Http404()
    if a.status != PendingAction.Status.PENDING or a.used_at or a.expires_at <= timezone.now():
        raise ConfirmationRequired()
    if not secrets.compare_digest(_hash(data["confirmation_token"]), a.token_hash):
        raise ConfirmationRequired()
    # Spend the token first (atomically): a replay or a double click can never run it twice.
    if not PendingAction.objects.filter(pk=a.pk, used_at__isnull=True, status=PendingAction.Status.PENDING).update(used_at=timezone.now()):
        raise ConfirmationRequired()
    a.refresh_from_db()
    try:
        result = _execute(request, actor, a)
    except ProviderError as exc:
        _fail(a, exc.code, exc.message)
        access.audit_write(request, actor, "failed", a, fields=["kind"], extra={"kind": a.kind, "code": exc.code})
        raise to_api_error(exc) from None
    except ApiError as exc:
        _fail(a, exc.code, exc.message)
        raise
    except PermissionDenied as exc:
        _fail(a, "permission_denied", str(exc) or "Not allowed.")
        raise
    except Http404:
        _fail(a, "not_found", "The item no longer exists.")
        raise
    a.status = PendingAction.Status.EXECUTED
    a.result = result
    a.payload = {}
    a.save(update_fields=["status", "result", "payload", "updated_at"])
    access.audit_write(request, actor, "execute", a, fields=["kind"], extra={"kind": a.kind})
    return a


def cancel(request, actor, action_id) -> None:
    a = access.for_actor(actor, PendingAction).filter(pk=services._uuid(action_id)).first()
    if a is None:
        raise Http404()
    if a.status == PendingAction.Status.PENDING:
        a.status = PendingAction.Status.CANCELED
        a.payload = {}
        a.save(update_fields=["status", "payload", "updated_at"])
        access.audit_write(request, actor, "cancel", a, fields=["kind"])


def _fail(a: PendingAction, code: str, message: str) -> None:
    a.status = PendingAction.Status.FAILED
    a.error_code = code[:60]
    a.error_message = message[:300]
    a.payload = {}
    a.save(update_fields=["status", "error_code", "error_message", "payload", "updated_at"])


def _execute(request, actor, a: PendingAction) -> dict:
    conn = a.connection
    if conn.status not in {IntegrationConnection.Status.CONNECTED, IntegrationConnection.Status.ERROR}:
        raise Conflict("Reconnect this integration first.", code="reauth_required")
    p = a.payload
    if a.kind == PendingAction.Kind.GMAIL_SEND:
        d = access.get_for_actor(actor, EmailDraft, p["target"], CHANGE)
        if d.status != EmailDraft.Status.DRAFT:
            raise Conflict("This draft was already sent or discarded.")
        if _draft_fingerprint(d) != p.get("fingerprint"):
            raise Conflict("The draft changed after you reviewed it. Review it again before sending.", code="draft_changed")
        adapter = adapter_for(Provider.GMAIL)
        raw = adapter.build_raw(sender=d.connection.account_id, to=d.to, cc=d.cc, subject=d.subject, body=d.body, in_reply_to=d.in_reply_to,
                                references=d.references)
        try:
            sent = adapter.send_draft(d.connection, d.external_draft_id, raw=raw, thread_id=d.item.data.get("thread_id") or d.item.external_id)
        except ProviderError as exc:
            EmailDraft.objects.filter(pk=d.pk).update(status=EmailDraft.Status.FAILED if exc.code == "send_unconfirmed" else EmailDraft.Status.DRAFT,
                                                      last_error_code=exc.code[:60])
            if isinstance(exc, ProviderUnavailable):
                raise ProviderUnavailable("Gmail didn't confirm the message was sent, so it isn't marked as sent. "
                                          "Check your Sent folder in Gmail before trying again.") from None
            raise
        # Gmail confirmed: only now is it recorded as sent.
        d.status = EmailDraft.Status.SENT
        d.sent_message_id = sent["message_id"][:255]
        d.sent_at = timezone.now()
        d.body = ""
        d.last_error_code = ""
        d.save(update_fields=["status", "sent_message_id", "sent_at", "body", "last_error_code", "updated_at"])
        access.audit_write(request, actor, "send", d, fields=["status"])
        try:
            adapter.refresh_thread(d.connection, d.item.data.get("thread_id") or d.item.external_id)
        except ProviderError:
            pass
        return {"sent": True, "draft_id": str(d.pk), "provider_message_id": sent["message_id"]}
    if a.kind == PendingAction.Kind.SLACK_POST:
        from .providers.slack import store_message

        selected = {c["id"] for c in (conn.settings or {}).get("channels") or []}
        if p["channel"] not in selected:
            raise Conflict("That channel is no longer selected.", code="channel_unselected")
        posted = adapter_for(Provider.SLACK).post_message(conn, p["channel"], p["text"], p.get("thread_ts") or "")
        store_message(conn, posted["channel"], p.get("channel_name") or posted["channel"],
                      {"ts": posted["ts"], "text": p["text"], "user": (conn.sync_state or {}).get("bot_user_id") or "", "bot_id": "app",
                       "thread_ts": p.get("thread_ts") or ""})
        return {"posted": True, "channel": posted["channel"], "ts": posted["ts"]}
    adapter = adapter_for(Provider.GOHIGHLEVEL)
    if a.kind == PendingAction.Kind.GHL_CREATE_CONTACT:
        contact = access.resolve_one(actor, crm.Contact, p["contact_id"], field_name="contact_id")
        created = adapter.create_contact(conn, p["fields"])
        from .providers.gohighlevel import ghl_contact_url

        upsert_mapping(conn, f"{conn.account_id}:contact:{created['id']}", contact, external_url=ghl_contact_url(conn, created["id"]))
        return {"created": True, "external_id": created["id"]}
    if a.kind == PendingAction.Kind.GHL_UPDATE_CONTACT:
        updated = adapter.update_contact(conn, p["external_id"], p["fields"])
        return {"updated": True, "external_id": updated.get("id") or p["external_id"]}
    if a.kind == PendingAction.Kind.GHL_ADD_TO_WORKFLOW:
        if not services.workflow_triggers_allowed(conn):
            raise PermissionDenied("Starting HighLevel workflows is turned off here.")
        adapter.add_to_workflow(conn, p["external_id"], p["workflow_id"])
        return {"started": True}
    raise ValidationFailed("Unknown action.")
