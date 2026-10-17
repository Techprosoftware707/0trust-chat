"""Webhooks (mock-based; signatures computed locally as the providers document them):
Slack v0 HMAC within five minutes and url_verification; HighLevel Ed25519 over the raw body;
invalid, stale (replayed) and duplicate deliveries; only selected Slack channels stored."""

import base64
import json
import time
from datetime import timedelta

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.test import Client, override_settings
from django.utils import timezone

from apps.core.models import SecurityEvent
from apps.integrations.models import ExternalRecord, InboxItem, IntegrationConnection, WebhookEvent
from apps.integrations.webhooks import slack_signature

from .integrations_helpers import REAL_CONFIG, configured_fixture, connect, fake_fixture  # noqa: F401
from .nexus_helpers import business_workspace, make_user

pytestmark = pytest.mark.django_db
SLACK_URL = "/integrations/webhooks/slack/events"
GHL_URL = "/integrations/webhooks/gohighlevel"


def slack_post(payload, *, ts=None, secret=REAL_CONFIG["NEXUS_SLACK_SIGNING_SECRET"], signature=None):
    raw = json.dumps(payload).encode()
    ts = str(int(time.time()) if ts is None else ts)
    sig = signature or slack_signature(secret, ts, raw)
    return Client().post(SLACK_URL, raw, content_type="application/json", HTTP_X_SLACK_REQUEST_TIMESTAMP=ts, HTTP_X_SLACK_SIGNATURE=sig)


@pytest.fixture
def slack(fake, configured):
    owner = make_user("wh-owner", email="wh.owner@example.com")
    ws = business_workspace(owner, "Webhook Org")
    conn = connect(fake, owner, ws, "slack", account="T0MOCK0001")
    conn.settings = {**conn.settings, "channels": [{"id": "C0MOCKSALES", "name": "sales-mock", "is_private": False}]}
    conn.save()
    return conn


def event(event_id="Ev001", channel="C0MOCKSALES", text="Hello from a mock event", ts="1760000000.000100", **extra):
    return {"type": "event_callback", "team_id": "T0MOCK0001", "api_app_id": "A0MOCKAPP", "event_id": event_id, "event_time": 1760000000,
            "event": {"type": "message", "channel": channel, "user": "U0MOCKA01", "text": text, "ts": ts, "channel_type": "channel", **extra}}


def test_url_verification_needs_a_valid_signature(slack):
    r = slack_post({"type": "url_verification", "challenge": "chal-123", "token": "legacy"})
    assert r.status_code == 200 and r.content == b"chal-123" and r["Content-Type"].startswith("text/plain")
    r = slack_post({"type": "url_verification", "challenge": "chal-123"}, signature="v0=" + "0" * 64)
    assert r.status_code == 401 and b"chal-123" not in r.content


def test_valid_event_is_stored_once(slack):
    r = slack_post(event())
    assert r.status_code == 200
    item = InboxItem.objects.get(connection=slack)
    assert item.kind == "slack_message" and item.snippet == "Hello from a mock event" and item.visibility == "workspace"
    assert WebhookEvent.objects.get(provider="slack", event_id="Ev001").outcome == "processed"
    # Slack retries deliver the same event_id: deduplicated.
    r = slack_post(event())
    assert r.status_code == 200 and r.json()["duplicate"] is True
    assert InboxItem.objects.filter(connection=slack).count() == 1
    assert WebhookEvent.objects.get(provider="slack", event_id="Ev001").duplicates == 1


def test_same_message_from_two_events_is_one_item(slack):
    slack_post(event(event_id="Ev1"))
    slack_post(event(event_id="Ev2", text="edited"))
    assert InboxItem.objects.filter(connection=slack).count() == 1


def test_invalid_signature_is_rejected_and_logged(slack):
    r = slack_post(event(), secret="wrong-secret")
    assert r.status_code == 401
    assert not InboxItem.objects.exists() and not WebhookEvent.objects.exists()
    assert SecurityEvent.objects.filter(kind="webhook_rejected").exists()


def test_stale_timestamp_is_rejected_as_replay(slack):
    old = int(time.time()) - 301
    r = slack_post(event(), ts=old)
    assert r.status_code == 401 and not InboxItem.objects.exists()
    r = slack_post(event(), ts=int(time.time()) + 400)
    assert r.status_code == 401


def test_missing_headers_and_unconfigured(slack):
    r = Client().post(SLACK_URL, json.dumps(event()), content_type="application/json")
    assert r.status_code == 401
    with override_settings(NEXUS_SLACK_SIGNING_SECRET=""):
        assert slack_post(event()).status_code == 404


def test_unselected_channel_is_not_stored(slack):
    slack_post(event(event_id="Ev9", channel="C0MOCKRANDOM"))
    assert not InboxItem.objects.exists()
    assert WebhookEvent.objects.get(event_id="Ev9").outcome == "ignored"


def test_edit_and_delete_events(slack):
    slack_post(event())
    slack_post({**event(event_id="Ev2"), "event": {"type": "message", "subtype": "message_changed", "channel": "C0MOCKSALES",
                                                     "message": {"type": "message", "user": "U0MOCKA01", "text": "Edited text", "ts": "1760000000.000100"}}})
    assert InboxItem.objects.get().snippet == "Edited text"
    slack_post({**event(event_id="Ev3"), "event": {"type": "message", "subtype": "message_deleted", "channel": "C0MOCKSALES",
                                                     "deleted_ts": "1760000000.000100"}})
    assert not InboxItem.objects.exists()


def test_tokens_revoked_moves_to_needs_reauth(slack):
    slack_post({"type": "event_callback", "team_id": "T0MOCK0001", "event_id": "EvR", "event": {"type": "tokens_revoked"}})
    slack.refresh_from_db()
    assert slack.status == "needs_reauth"


def test_other_team_is_ignored(slack):
    payload = event(event_id="EvX")
    payload["team_id"] = "T0OTHER"
    assert slack_post(payload).status_code == 200
    assert not InboxItem.objects.exists()


# --- HighLevel -------------------------------------------------------------------------------------------


@pytest.fixture
def ghl_key():
    key = Ed25519PrivateKey.generate()
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    with override_settings(NEXUS_GHL_WEBHOOK_PUBLIC_KEY=pem):
        yield key


@pytest.fixture
def ghl(fake, configured, ghl_key):
    owner = make_user("ghlwh-owner", email="ghlwh.owner@example.com")
    ws = business_workspace(owner, "GHL Webhook Org")
    return connect(fake, owner, ws, "gohighlevel", account="mockLocation001")


def ghl_post(key, payload, *, raw=None, signature=None):
    raw = raw if raw is not None else json.dumps(payload).encode()
    sig = signature if signature is not None else base64.b64encode(key.sign(raw)).decode()
    return Client().post(GHL_URL, raw, content_type="application/json", HTTP_X_GHL_SIGNATURE=sig)


def inbound(webhook_id="wh-1", **extra):
    return {"type": "InboundMessage", "locationId": "mockLocation001", "conversationId": "convWH1", "contactId": "mockContact01",
            "body": "Synthetic inbound SMS", "direction": "inbound", "messageType": "SMS", "dateAdded": timezone.now().isoformat(),
            "timestamp": timezone.now().isoformat(), "webhookId": webhook_id, **extra}


def test_ghl_valid_signature_processed_once(ghl, ghl_key):
    r = ghl_post(ghl_key, inbound())
    assert r.status_code == 200
    item = InboxItem.objects.get(connection=ghl, external_id="convWH1")
    assert item.kind == "ghl_conversation" and item.snippet == "Synthetic inbound SMS"
    r = ghl_post(ghl_key, inbound())
    assert r.json()["duplicate"] is True
    assert WebhookEvent.objects.get(provider="gohighlevel", event_id="wh-1").duplicates == 1


def test_ghl_signature_is_over_the_raw_body(ghl, ghl_key):
    raw = json.dumps(inbound()).encode()
    sig = base64.b64encode(ghl_key.sign(raw)).decode()
    altered = raw.replace(b"Synthetic inbound SMS", b"Tampered inbound SMS")
    assert ghl_post(ghl_key, None, raw=altered, signature=sig).status_code == 401
    other = Ed25519PrivateKey.generate()
    assert ghl_post(other, inbound(webhook_id="wh-2")).status_code == 401
    assert ghl_post(ghl_key, inbound(webhook_id="wh-3"), signature="").status_code == 401
    assert not InboxItem.objects.filter(connection=ghl, external_id="convWH1").exists()


def test_ghl_legacy_rsa_header_alone_is_not_accepted(ghl, ghl_key):
    raw = json.dumps(inbound()).encode()
    r = Client().post(GHL_URL, raw, content_type="application/json", HTTP_X_WH_SIGNATURE="c2lnbmF0dXJl")
    assert r.status_code == 401


def test_ghl_stale_timestamp_rejected(ghl, ghl_key):
    payload = inbound(webhook_id="wh-old", timestamp=(timezone.now() - timedelta(days=2)).isoformat())
    assert ghl_post(ghl_key, payload).status_code == 400


def test_ghl_dedup_without_webhook_id_uses_the_signed_body(ghl, ghl_key):
    payload = inbound()
    payload.pop("webhookId")
    raw = json.dumps(payload).encode()
    assert ghl_post(ghl_key, None, raw=raw).status_code == 200
    assert ghl_post(ghl_key, None, raw=raw).json()["duplicate"] is True


def test_ghl_missed_call_and_uninstall(ghl, ghl_key):
    ghl_post(ghl_key, inbound(webhook_id="wh-call", messageType="CALL", callStatus="voicemail", messageId="callMsg1", body=""))
    assert InboxItem.objects.filter(connection=ghl, kind="missed_call").count() == 1
    ghl_post(ghl_key, {"type": "AppUninstall", "locationId": "mockLocation001", "webhookId": "wh-un", "timestamp": timezone.now().isoformat()})
    ghl.refresh_from_db()
    assert ghl.status == "needs_reauth" and ghl.last_error_code == "app_uninstalled"


def test_ghl_opportunity_update_refreshes_mirror(ghl, ghl_key):
    from apps.integrations.sync import sync_connection

    sync_connection(ghl)
    ghl_post(ghl_key, {"type": "OpportunityStatusUpdate", "locationId": "mockLocation001", "id": "mockOpp01", "status": "won",
                       "webhookId": "wh-opp", "timestamp": timezone.now().isoformat()})
    assert ExternalRecord.objects.get(connection=ghl, kind="opportunity", external_id="mockOpp01").data["status"] == "won"


def test_ghl_unknown_location_ignored(ghl, ghl_key):
    payload = inbound(webhook_id="wh-z", locationId="someoneElse")
    assert ghl_post(ghl_key, payload).status_code == 200
    assert not InboxItem.objects.filter(external_id="convWH1").exists()
    assert IntegrationConnection.objects.get(pk=ghl.pk).status == "connected"
