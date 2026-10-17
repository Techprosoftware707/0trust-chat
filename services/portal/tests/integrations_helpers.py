"""Helpers for the integrations tests. Every provider call goes to the local fake providers
(``apps.integrations.mock.providers``) through ``http.use_transport``: these tests are
mock-based and never reach a live provider."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from django.test import Client, override_settings

from apps.integrations import http
from apps.integrations.mock.providers import FakeProviderTransport
from apps.integrations.models import IntegrationConnection

from .nexus_helpers import api_for, body

REAL_CONFIG = {
    "NEXUS_GOOGLE_CLIENT_ID": "test-google-client.apps.example",
    "NEXUS_GOOGLE_CLIENT_SECRET": "test-google-secret-value",
    "NEXUS_SLACK_CLIENT_ID": "1111.2222",
    "NEXUS_SLACK_CLIENT_SECRET": "test-slack-secret-value",
    "NEXUS_SLACK_SIGNING_SECRET": "test-slack-signing-secret",
    "NEXUS_GHL_CLIENT_ID": "test-ghl-client",
    "NEXUS_GHL_CLIENT_SECRET": "test-ghl-secret-value",
}


@pytest.fixture(name="fake")
def fake_fixture():
    """A fresh set of fake providers for this test, and no real sleeping in backoff."""
    transport = FakeProviderTransport()
    sleeps: list[float] = []
    with http.use_transport(transport), http.use_sleeper(sleeps.append):
        transport.sleeps = sleeps
        yield transport


@pytest.fixture(name="configured")
def configured_fixture():
    """Providers configured as on a real install (credentials present), still mock transport."""
    with override_settings(**REAL_CONFIG):
        yield


def ibase(ws) -> str:
    return f"/api/v1/workspaces/{ws.pk}/integrations"


def portal_client(user) -> Client:
    c = Client()
    c.force_login(user)
    return c


def start_flow(user, ws, provider, *, api=None, options=None, reconnect_id=None):
    api = api or api_for(user)
    payload = {"provider": provider}
    if options:
        payload["options"] = options
    if reconnect_id:
        payload["reconnect_id"] = reconnect_id
    r = api.post(f"{ibase(ws)}/connections/oauth-start", payload)
    assert r.status_code == 201, r.content
    return body(r)["data"]["authorize_url"]


def begin(client: Client, authorize_url: str):
    u = urlsplit(authorize_url)
    r = client.get(u.path + "?" + u.query)
    return r


def provider_params(response) -> dict:
    assert response.status_code == 302, response.content
    q = parse_qs(urlsplit(response["Location"]).query)
    return {k: v[0] for k, v in q.items()}


def connect(fake_transport, user, ws, provider, *, account=None, scope=None, client=None) -> IntegrationConnection:
    """Runs the whole OAuth flow against the fakes and returns the new connection."""
    client = client or portal_client(user)
    r = begin(client, start_flow(user, ws, provider))
    p = provider_params(r)
    fakeprov = fake_transport.provider(provider)
    from apps.integrations import conf

    code = fakeprov.issue_code(account=account or user.email, challenge=p.get("code_challenge", ""), method=p.get("code_challenge_method", ""),
                               redirect_uri=conf.redirect_uri(provider), extra={"scope": scope} if scope else None)
    cb = urlsplit(conf.redirect_uri(provider)).path
    r = client.get(cb, {"code": code, "state": p.get("state", "")})
    assert r.status_code == 302, r.content
    assert "/integrations/connected/" in r["Location"], r["Location"]
    return IntegrationConnection.objects.filter(workspace=ws, provider=provider).exclude(status="disconnected").latest("created_at")
