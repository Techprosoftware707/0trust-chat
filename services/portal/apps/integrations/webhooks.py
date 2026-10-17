"""Inbound webhooks: signature verification, replay protection and dedup.

Slack Events API (docs.slack.dev, "Verifying requests from Slack", verified 2026-10-17):
``X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing secret, "v0:" + X-Slack-Request-Timestamp
+ ":" + raw body))``; requests whose timestamp is more than five minutes from our clock are
refused (replay); ``url_verification`` is answered with the challenge only after the signature
checks out; events are deduplicated by ``event_id``; we answer within Slack's three seconds.

HighLevel (Webhook Integration Guide, verified 2026-10-17): ``X-GHL-Signature`` is an
Ed25519 signature (base64) of the raw request body, verified with HighLevel's published
public key. The legacy RSA ``X-WH-Signature`` header is deprecated (2026-09-01) and not
accepted. Deliveries are deduplicated by ``webhookId`` (or, when absent, a hash of the signed
body) and refused when their ``timestamp`` is older than the replay window. HighLevel retries
non-2xx responses up to 12 times.

Webhook bodies are untrusted data: only identifiers and the fields we store are used, and the
payload itself is never stored or logged.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from .models import ExternalRecord, InboxItem, IntegrationConnection, Provider, WebhookEvent
from .providers.base import clip, parse_iso

log = logging.getLogger("nexus.integrations")
SLACK_WINDOW = 300
GHL_MAX_AGE = 24 * 3600
MAX_BODY = 1024 * 1024


@dataclass
class Outcome:
    status: int
    body: dict | str
    outcome: str
    content_type: str = "application/json"


# --- signatures -----------------------------------------------------------------------------------


def slack_signature(secret: str, timestamp: str, body: bytes) -> str:
    base = b"v0:" + timestamp.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


def verify_slack(body: bytes, timestamp: str | None, signature: str | None, *, now: float | None = None) -> str | None:
    """None when valid, else a short reason."""
    secret = settings.NEXUS_SLACK_SIGNING_SECRET
    if not secret:
        return "not_configured"
    if not timestamp or not signature:
        return "missing_signature"
    try:
        ts = int(timestamp)
    except ValueError:
        return "bad_timestamp"
    if abs((now or time.time()) - ts) > SLACK_WINDOW:
        return "stale_timestamp"
    expected = slack_signature(secret, timestamp, body)
    if not hmac.compare_digest(expected.encode(), signature.strip().encode()):
        return "bad_signature"
    return None


def _ghl_key() -> Ed25519PublicKey | None:
    pem = (settings.NEXUS_GHL_WEBHOOK_PUBLIC_KEY or "").strip()
    if not pem:
        return None
    if "\n" not in pem:  # tolerate a one-line paste of the PEM block
        pem = pem.replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----\n").replace("-----END PUBLIC KEY-----", "\n-----END PUBLIC KEY-----")
    try:
        key = load_pem_public_key(pem.encode())
    except ValueError:
        return None
    return key if isinstance(key, Ed25519PublicKey) else None


def verify_ghl(body: bytes, signature: str | None) -> str | None:
    key = _ghl_key()
    if key is None:
        return "not_configured"
    if not signature or signature == "N/A":
        return "missing_signature"
    try:
        sig = base64.b64decode(signature.strip(), validate=True)
    except (binascii.Error, ValueError):
        return "bad_signature"
    try:
        key.verify(sig, body)
    except InvalidSignature:
        return "bad_signature"
    return None


# --- dedup ----------------------------------------------------------------------------------------


def _claim(provider: str, event_id: str, event_type: str) -> WebhookEvent | None:
    """Records the delivery; None if it was seen before (counted as a duplicate)."""
    try:
        with transaction.atomic():
            return WebhookEvent.objects.create(provider=provider, event_id=event_id[:200], event_type=event_type[:80])
    except IntegrityError:
        WebhookEvent.objects.filter(provider=provider, event_id=event_id[:200]).update(duplicates=F("duplicates") + 1)
        return None


def _finish(event: WebhookEvent, outcome: str, detail: str = "", connection: IntegrationConnection | None = None) -> None:
    WebhookEvent.objects.filter(pk=event.pk).update(
        outcome=outcome, detail=detail[:200], connection=connection, workspace_id=connection.workspace_id if connection else None)


# --- Slack ----------------------------------------------------------------------------------------


def handle_slack(body: bytes, headers) -> Outcome:
    if len(body) > MAX_BODY:
        return Outcome(413, {"ok": False}, "rejected")
    reason = verify_slack(body, headers.get("X-Slack-Request-Timestamp"), headers.get("X-Slack-Signature"))
    if reason:
        return Outcome(401 if reason != "not_configured" else 404, {"ok": False}, f"rejected:{reason}")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return Outcome(400, {"ok": False}, "rejected:bad_json")
    if not isinstance(payload, dict):
        return Outcome(400, {"ok": False}, "rejected:bad_json")
    if payload.get("type") == "url_verification":
        challenge = clip(payload.get("challenge"), 200)
        return Outcome(200, challenge, "url_verification", content_type="text/plain")
    if payload.get("type") != "event_callback":
        return Outcome(200, {"ok": True}, "ignored")
    event_id = clip(payload.get("event_id"), 200)
    event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
    if not event_id:
        return Outcome(400, {"ok": False}, "rejected:no_event_id")
    record = _claim(Provider.SLACK, event_id, clip(event.get("type"), 80))
    if record is None:
        return Outcome(200, {"ok": True, "duplicate": True}, "duplicate")
    team = clip(payload.get("team_id"), 255)
    conns = list(IntegrationConnection.objects.filter(provider=Provider.SLACK, account_id=team)
                 .exclude(status=IntegrationConnection.Status.DISCONNECTED))
    if not conns:
        _finish(record, WebhookEvent.Outcome.IGNORED, "no_connection")
        return Outcome(200, {"ok": True}, "ignored")
    detail = ""
    for conn in conns:
        try:
            detail = _apply_slack_event(conn, event)
        except Exception:
            log.exception("slack event %s failed for connection %s", clip(event.get("type"), 40), conn.pk)
            WebhookEvent.objects.filter(pk=record.pk).delete()  # let Slack's retry be processed
            return Outcome(500, {"ok": False}, "failed")
        IntegrationConnection.objects.filter(pk=conn.pk).update(last_webhook_at=timezone.now())
    _finish(record, WebhookEvent.Outcome.PROCESSED if detail != "ignored" else WebhookEvent.Outcome.IGNORED, detail, conns[0])
    return Outcome(200, {"ok": True}, "processed")


def _apply_slack_event(conn: IntegrationConnection, event: dict) -> str:
    from .providers.slack import delete_message, store_message

    etype = event.get("type")
    if etype in {"app_uninstalled", "tokens_revoked"}:
        from .tokens import mark_needs_reauth

        mark_needs_reauth(conn, "app_uninstalled", "The Slack app was removed from the Slack workspace. Reconnect to continue.")
        return "uninstalled"
    if etype != "message":
        return "ignored"
    channel = clip(event.get("channel"), 40)
    selected = {c["id"]: c for c in (conn.settings or {}).get("channels") or [] if isinstance(c, dict)}
    if channel not in selected:
        return "ignored"  # only selected channels are ever stored
    name = selected[channel].get("name") or channel
    subtype = event.get("subtype")
    if subtype == "message_deleted":
        delete_message(conn, channel, clip(event.get("deleted_ts"), 40))
        return "deleted"
    if subtype == "message_changed" and isinstance(event.get("message"), dict):
        store_message(conn, channel, name, event["message"])
        return "updated"
    return "stored" if store_message(conn, channel, name, event) is not None else "ignored"


# --- HighLevel -------------------------------------------------------------------------------------


def handle_ghl(body: bytes, headers) -> Outcome:
    if len(body) > MAX_BODY:
        return Outcome(413, {"ok": False}, "rejected")
    reason = verify_ghl(body, headers.get("X-GHL-Signature"))
    if reason:
        return Outcome(401 if reason != "not_configured" else 404, {"ok": False}, f"rejected:{reason}")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return Outcome(400, {"ok": False}, "rejected:bad_json")
    if not isinstance(payload, dict):
        return Outcome(400, {"ok": False}, "rejected:bad_json")
    sent = parse_iso(payload.get("timestamp")) if isinstance(payload.get("timestamp"), str) else None
    if sent is not None and (timezone.now() - sent).total_seconds() > GHL_MAX_AGE:
        return Outcome(400, {"ok": False}, "rejected:stale")
    event_id = clip(payload.get("webhookId"), 200) or "sha256:" + hashlib.sha256(body).hexdigest()
    etype = clip(payload.get("type"), 80)
    record = _claim(Provider.GOHIGHLEVEL, event_id, etype)
    if record is None:
        return Outcome(200, {"ok": True, "duplicate": True}, "duplicate")
    location = clip(payload.get("locationId"), 255)
    conns = list(IntegrationConnection.objects.filter(provider=Provider.GOHIGHLEVEL, account_id=location)
                 .exclude(status=IntegrationConnection.Status.DISCONNECTED)) if location else []
    if not conns:
        _finish(record, WebhookEvent.Outcome.IGNORED, "no_connection")
        return Outcome(200, {"ok": True}, "ignored")
    detail = ""
    for conn in conns:
        try:
            detail = _apply_ghl_event(conn, etype, payload)
        except Exception:
            log.exception("highlevel event %s failed for connection %s", etype[:40], conn.pk)
            WebhookEvent.objects.filter(pk=record.pk).delete()  # let HighLevel's retry be processed
            return Outcome(500, {"ok": False}, "failed")
        IntegrationConnection.objects.filter(pk=conn.pk).update(last_webhook_at=timezone.now())
    _finish(record, WebhookEvent.Outcome.PROCESSED if detail != "ignored" else WebhookEvent.Outcome.IGNORED, detail, conns[0])
    return Outcome(200, {"ok": True}, "processed")


def _apply_ghl_event(conn: IntegrationConnection, etype: str, p: dict) -> str:
    from .providers.gohighlevel import MISSED_CALL_STATUSES, contact_summary, record_missed_call, upsert_conversation, upsert_external

    if etype == "AppUninstall":
        from .tokens import mark_needs_reauth

        mark_needs_reauth(conn, "app_uninstalled", "The app was uninstalled in HighLevel. Reconnect to continue.")
        return "uninstalled"
    if etype in {"InboundMessage", "OutboundMessage"} and p.get("conversationId"):
        existing = InboxItem.objects.filter(connection=conn, external_id=clip(p["conversationId"], 255)).first()
        item = upsert_conversation(conn, {
            "id": p["conversationId"], "contactId": p.get("contactId"), "lastMessageBody": p.get("body") or "",
            "lastMessageType": p.get("messageTypeString") or p.get("messageType"), "dateAdded": p.get("dateAdded"),
            "unreadCount": 1 if p.get("direction") == "inbound" else 0,
            "fullName": existing.title if existing else "",
        })
        if (str(p.get("messageType") or "").upper() in {"CALL", "TYPE_CALL"} and p.get("direction") == "inbound"
                and str(p.get("callStatus") or "") in MISSED_CALL_STATUSES):
            record_missed_call(conn, item, {"id": clip(p.get("messageId") or p.get("conversationId"), 80), "date": p.get("dateAdded"),
                                            "call_status": str(p.get("callStatus"))})
        return "conversation"
    if etype in {"ContactCreate", "ContactUpdate", "ContactTagUpdate", "ContactDndUpdate"} and p.get("id"):
        if ExternalRecord.objects.filter(connection=conn, kind=ExternalRecord.Kind.CONTACT, external_id=clip(p["id"], 255)).exists():
            summary = contact_summary(p)
            upsert_external(conn, ExternalRecord.Kind.CONTACT, p["id"], summary["display_name"], summary, p.get("dateUpdated"))
            return "contact"
        return "ignored"
    if etype == "ContactDelete" and p.get("id"):
        ExternalRecord.objects.filter(connection=conn, kind=ExternalRecord.Kind.CONTACT, external_id=clip(p["id"], 255)).delete()
        return "contact_deleted"
    if etype.startswith("Opportunity") and p.get("id"):
        if etype == "OpportunityDelete":
            ExternalRecord.objects.filter(connection=conn, kind=ExternalRecord.Kind.OPPORTUNITY, external_id=clip(p["id"], 255)).delete()
            return "opportunity_deleted"
        rec = ExternalRecord.objects.filter(connection=conn, kind=ExternalRecord.Kind.OPPORTUNITY, external_id=clip(p["id"], 255)).first()
        data = dict(rec.data) if rec else {}
        for src, dst in [("name", "name"), ("status", "status"), ("monetaryValue", "monetary_value"), ("pipelineId", "pipeline_id"),
                         ("pipelineStageId", "stage_id"), ("assignedTo", "assigned_to")]:
            if src in p:
                data[dst] = p[src] if not isinstance(p[src], str) else clip(p[src], 200)
        upsert_external(conn, ExternalRecord.Kind.OPPORTUNITY, p["id"], clip(data.get("name") or (rec.title if rec else ""), 200), data,
                        p.get("dateUpdated") or p.get("dateAdded"))
        return "opportunity"
    return "ignored"
