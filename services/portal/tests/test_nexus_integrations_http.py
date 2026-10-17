"""Provider HTTP handling (mock-based, scripted fake transport): 401 refresh, 403 scope and
Google rate-limit reasons, 429 with Retry-After, 5xx and network errors with backoff, no
retries of non-idempotent requests, and how sync records each outcome."""

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.integrations import http
from apps.integrations.http import (
    Headers,
    HttpResponse,
    ProviderClient,
    ProviderUnavailable,
    RateLimited,
    ReauthRequired,
    ScopeMissing,
    TransportError,
)
from apps.integrations.providers import gmail as gmail_provider
from apps.integrations.providers import slack as slack_provider
from apps.integrations.sync import sync_connection

from .integrations_helpers import configured_fixture, connect, fake_fixture  # noqa: F401
from .nexus_helpers import business_workspace, make_user

pytestmark = pytest.mark.django_db


class Script:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def send(self, req):
        self.requests.append(req)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def resp(status, data=None, headers=None):
    h = Headers({"Content-Type": "application/json", **(headers or {})})
    return HttpResponse(status=status, headers=h, body=json.dumps(data or {}).encode())


class Tokens:
    def __init__(self):
        self.refreshes = 0

    def access_token(self):
        return "tok-1" if not self.refreshes else "tok-2"

    def refresh(self):
        self.refreshes += 1
        return "tok-2"


@pytest.fixture
def sleeps():
    out = []
    with http.use_sleeper(out.append):
        yield out


def test_401_refreshes_once_then_reauth(sleeps):
    t = Tokens()
    script = Script(resp(401), resp(200, {"ok": 1}))
    with http.use_transport(script):
        assert ProviderClient("gmail", tokens=t).request("GET", "https://gmail.googleapis.com/x").json() == {"ok": 1}
    assert t.refreshes == 1 and script.requests[1].headers["Authorization"] == "Bearer tok-2"
    script = Script(resp(401), resp(401))
    with http.use_transport(script), pytest.raises(ReauthRequired):
        ProviderClient("gmail", tokens=Tokens()).request("GET", "https://gmail.googleapis.com/x")


def test_429_short_retry_after_is_waited_and_retried(sleeps):
    script = Script(resp(429, headers={"Retry-After": "2"}), resp(200, {"ok": True}))
    with http.use_transport(script):
        ProviderClient("slack", tokens=Tokens(), classify=slack_provider.classify).request("GET", "https://slack.com/api/auth.test")
    assert sleeps == [2.0]


def test_429_long_retry_after_surfaces_rate_limited(sleeps):
    script = Script(resp(429, headers={"Retry-After": "120"}))
    with http.use_transport(script), pytest.raises(RateLimited) as exc:
        ProviderClient("slack", tokens=Tokens(), classify=slack_provider.classify).request("GET", "https://slack.com/api/auth.test")
    assert exc.value.retry_after == 120 and sleeps == []


def test_5xx_retries_with_backoff_then_gives_up(sleeps):
    script = Script(resp(503), resp(502), resp(500), resp(500))
    with http.use_transport(script), pytest.raises(ProviderUnavailable):
        ProviderClient("gmail", tokens=Tokens()).request("GET", "https://gmail.googleapis.com/x")
    assert len(sleeps) == 3 and sleeps[0] >= 1 and sleeps[1] >= 2 and sleeps[2] >= 4
    script = Script(resp(503), resp(200, {"ok": True}))
    with http.use_transport(script):
        assert ProviderClient("gmail", tokens=Tokens()).request("GET", "https://gmail.googleapis.com/x").json() == {"ok": True}


def test_network_errors_are_retried_for_reads_only(sleeps):
    script = Script(TransportError("ConnectTimeout"), resp(200))
    with http.use_transport(script):
        ProviderClient("gmail", tokens=Tokens()).request("GET", "https://gmail.googleapis.com/x")
    script = Script(TransportError("ConnectTimeout"))
    with http.use_transport(script), pytest.raises(ProviderUnavailable):
        ProviderClient("gmail", tokens=Tokens()).request("POST", "https://gmail.googleapis.com/send", json={})
    assert len(script.requests) == 1


def test_non_idempotent_post_is_never_retried_on_5xx(sleeps):
    script = Script(resp(500), resp(200))
    with http.use_transport(script), pytest.raises(ProviderUnavailable):
        ProviderClient("gmail", tokens=Tokens()).request("POST", "https://gmail.googleapis.com/drafts/send", json={})
    assert len(script.requests) == 1 and sleeps == []


def test_google_403_reasons(sleeps):
    rate = resp(403, {"error": {"code": 403, "errors": [{"reason": "userRateLimitExceeded"}], "status": "PERMISSION_DENIED"}})
    script = Script(rate, resp(200))
    with http.use_transport(script):
        ProviderClient("gmail", tokens=Tokens(), classify=gmail_provider.classify).request("GET", "https://gmail.googleapis.com/x")
    assert len(sleeps) == 1
    scope = resp(403, {"error": {"code": 403, "errors": [{"reason": "insufficientPermissions"}], "status": "PERMISSION_DENIED"}})
    with http.use_transport(Script(scope)), pytest.raises(ScopeMissing):
        ProviderClient("gmail", tokens=Tokens(), classify=gmail_provider.classify).request("GET", "https://gmail.googleapis.com/x")
    daily = resp(403, {"error": {"code": 403, "errors": [{"reason": "dailyLimitExceeded"}]}})
    with http.use_transport(Script(daily)), pytest.raises(RateLimited) as exc:
        ProviderClient("gmail", tokens=Tokens(), classify=gmail_provider.classify).request("GET", "https://gmail.googleapis.com/x")
    assert exc.value.retry_after == 3600


def test_slack_errors_in_200_responses(sleeps):
    with http.use_transport(Script(resp(200, {"ok": False, "error": "missing_scope"}))), pytest.raises(ScopeMissing):
        ProviderClient("slack", tokens=Tokens(), classify=slack_provider.classify).request("GET", "https://slack.com/api/conversations.list")
    t = Tokens()
    with http.use_transport(Script(resp(200, {"ok": False, "error": "token_expired"}), resp(200, {"ok": True}))):
        ProviderClient("slack", tokens=t, classify=slack_provider.classify).request("GET", "https://slack.com/api/auth.test")
    assert t.refreshes == 1


# --- how sync records outcomes -------------------------------------------------------------------------


@pytest.fixture
def conn(fake, configured):
    owner = make_user("http-owner", email="http.owner@example.com")
    ws = business_workspace(owner, "Http Org")
    return connect(fake, owner, ws, "gmail")


def _force(fake, response):
    from apps.integrations.mock.providers import _json

    fake.google.interceptors.append(lambda req: _json(*response) if "gmail.googleapis.com" in req.url else None)


def test_sync_rate_limited_reschedules_without_failure(fake, conn):
    from apps.integrations.mock.providers import _json

    fake.google.interceptors.append(lambda req: _json(429, {}, {"Retry-After": "900"}) if "gmail.googleapis.com" in req.url else None)
    out = sync_connection(conn)
    conn.refresh_from_db()
    assert out["code"] == "rate_limited" and conn.status == "connected" and conn.failure_count == 0
    assert conn.next_sync_at >= timezone.now() + timedelta(seconds=850) and conn.last_error_code == "rate_limited"


def test_sync_outage_backs_off_then_error_after_three(fake, conn):
    _force(fake, (503, {"error": {"code": 503, "message": "Backend Error"}}))
    for n in range(1, 4):
        conn.refresh_from_db()
        IntegrationConnectionModel().objects.filter(pk=conn.pk).update(sync_lease_until=None)
        out = sync_connection(conn)
        conn.refresh_from_db()
        assert out["code"] == "provider_unavailable" and conn.failure_count == n
    assert conn.status == "error" and conn.next_sync_at > timezone.now()
    fake.google.interceptors.clear()
    assert sync_connection(conn)["ok"]
    conn.refresh_from_db()
    assert conn.status == "connected" and conn.failure_count == 0 and conn.last_error_code == ""


def test_sync_scope_missing_is_an_error_state(fake, conn):
    _force(fake, (403, {"error": {"code": 403, "errors": [{"reason": "insufficientPermissions"}]}}))
    assert sync_connection(conn)["code"] == "scope_missing"
    conn.refresh_from_db()
    assert conn.status == "error"


def test_only_one_sync_runs_at_a_time(fake, conn):
    IntegrationConnectionModel().objects.filter(pk=conn.pk).update(sync_lease_until=timezone.now() + timedelta(minutes=1))
    assert sync_connection(conn) == {"ok": False, "code": "sync_running"}


def IntegrationConnectionModel():
    from apps.integrations.models import IntegrationConnection

    return IntegrationConnection
