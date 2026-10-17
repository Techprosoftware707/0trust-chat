"""OAuth connection flow (mock-based: the fake Google/Slack/HighLevel providers answer).

State: signed, bound to the person, the workspace and the browser session, short-lived and
single-use; PKCE for Google; token refresh, expiry and revocation (needs_reauth)."""

from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest
from django.core import signing
from django.test import Client, override_settings
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.integrations import conf, oauth
from apps.integrations.models import IntegrationConnection, IntegrationCredential, OAuthState
from apps.integrations.sync import sync_connection
from apps.workspaces.models import Membership, Role

from .integrations_helpers import begin, configured_fixture, connect, fake_fixture, ibase, portal_client, provider_params, start_flow  # noqa: F401
from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org():
    owner = make_user("intg-owner", email="owner.intg@example.com")
    ws = business_workspace(owner, "Intg Org")
    return {"ws": ws, "owner": owner, "agent": member(ws, Role.AGENT, "intg-agent"), "readonly": member(ws, Role.READONLY, "intg-ro")}


def _error(response) -> str:
    assert response.status_code == 302, response.content
    parts = urlsplit(response["Location"]).fragment.split("/")
    return parts[3] if len(parts) > 3 and parts[2] == "error" else ""


def _callback(client, provider, **params):
    return client.get(urlsplit(conf.redirect_uri(provider)).path, params)


def _code(fake, provider, p, account="owner.intg@example.com", **kw):
    return fake.provider(provider).issue_code(account=account, challenge=p.get("code_challenge", ""), method=p.get("code_challenge_method", ""),
                                             redirect_uri=conf.redirect_uri(provider), **kw)


def test_gmail_flow_uses_pkce_offline_access_and_stores_encrypted_tokens(org, fake, configured):
    client = portal_client(org["owner"])
    r = begin(client, start_flow(org["owner"], org["ws"], "gmail"))
    assert r["Location"].startswith(conf.GOOGLE_AUTHORIZE_URL)
    p = provider_params(r)
    assert p["code_challenge_method"] == "S256" and len(p["code_challenge"]) >= 43
    assert p["access_type"] == "offline" and p["prompt"] == "consent" and p["response_type"] == "code"
    assert set(p["scope"].split()) == {"https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"}
    assert p["redirect_uri"] == conf.redirect_uri("gmail")
    r = _callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])
    assert "/integrations/connected/gmail" in r["Location"]
    conn = IntegrationConnection.objects.get(workspace=org["ws"], provider="gmail")
    assert conn.status == "connected" and conn.account_id == "owner.intg@example.com" and conn.owner == org["owner"]
    assert conn.scope == "personal" and not conn.is_mock
    cred = IntegrationCredential.objects.get(connection=conn)
    # Encrypted at rest: the token value never appears in the row.
    from apps.integrations.tokens import read_tokens

    access_token, refresh_token = read_tokens(conn)
    assert access_token.startswith("mock-google-access-") and refresh_token.startswith("mock-google-refresh-")
    assert access_token.encode() not in bytes(cred.access_token) and refresh_token.encode() not in bytes(cred.refresh_token)
    assert bytes(cred.access_token)[:2] == b"v1"
    assert AuditEvent.objects.filter(action="integrations.integrationconnection.connect").exists()
    assert OAuthState.objects.get().used_at is not None


def test_pkce_verifier_must_match(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    code = fake.google.issue_code(account="owner.intg@example.com", challenge="A" * 43, method="S256", redirect_uri=conf.redirect_uri("gmail"))
    assert _error(_callback(client, "gmail", code=code, state=p["state"])) == "code_rejected"
    assert not IntegrationConnection.objects.exists()


def test_tampered_state_is_rejected(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    bad = p["state"][:-3] + ("AAA" if not p["state"].endswith("AAA") else "BBB")
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p), state=bad)) == "state_invalid"
    assert not IntegrationConnection.objects.exists()


def test_state_forged_with_other_secret_is_rejected(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    data = signing.loads(p["state"], salt=oauth.STATE_SALT)
    forged = signing.dumps(data, key="attacker-key", salt=oauth.STATE_SALT)
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p), state=forged)) == "state_invalid"


def test_state_is_single_use(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    r = _callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])
    assert "/integrations/connected/gmail" in r["Location"]
    # Replaying the callback (same state, even with a fresh code) is refused.
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])) in {"state_used", "session_mismatch"}
    assert IntegrationConnection.objects.count() == 1


def test_begin_link_is_single_use(org, fake, configured):
    client = portal_client(org["owner"])
    url = start_flow(org["owner"], org["ws"], "gmail")
    assert begin(client, url).status_code == 302
    assert _error(begin(client, url)) == "state_used"


def test_expired_state_is_rejected(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    OAuthState.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])) == "state_expired"


def test_signature_older_than_max_age_is_rejected(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    later = timezone.now().timestamp() + oauth.STATE_MAX_AGE + 5
    with mock.patch("django.core.signing.time.time", return_value=later):
        assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])) == "state_expired"


def test_callback_in_another_session_is_rejected(org, fake, configured):
    """Login CSRF: a callback is accepted only in the browser session that began the flow."""
    p = provider_params(begin(portal_client(org["owner"]), start_flow(org["owner"], org["ws"], "gmail")))
    other_session = portal_client(org["owner"])
    assert _error(_callback(other_session, "gmail", code=_code(fake, "gmail", p), state=p["state"])) == "session_mismatch"
    assert not IntegrationConnection.objects.exists()


def test_wrong_user_at_begin_and_callback(org, fake, configured):
    url = start_flow(org["owner"], org["ws"], "gmail")
    assert _error(begin(portal_client(org["agent"]), url)) == "wrong_user"
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    victim = portal_client(org["agent"])
    assert _error(_callback(victim, "gmail", code=_code(fake, "gmail", p), state=p["state"])) == "wrong_user"


def test_start_for_other_workspace_is_404(org, fake, configured):
    other = business_workspace(make_user("intg-other"), "Other Org")
    r = api_for(org["owner"]).post(f"{ibase(other)}/connections/oauth-start", {"provider": "gmail"})
    assert r.status_code == 404


def test_removed_member_cannot_finish(org, fake, configured):
    client = portal_client(org["agent"])
    p = provider_params(begin(client, start_flow(org["agent"], org["ws"], "gmail")))
    Membership.objects.filter(workspace=org["ws"], user=org["agent"]).delete()
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p, account=org["agent"].email), state=p["state"])) == "not_allowed"
    assert not IntegrationConnection.objects.exists()


def test_state_for_another_provider_is_rejected(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    assert _error(_callback(client, "slack", code="x", state=p["state"])) == "state_invalid"


def test_missing_state_rejected_for_gmail(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    assert _error(_callback(client, "gmail", code=_code(fake, "gmail", p))) == "state_missing"


def test_highlevel_without_state_accepts_only_the_session_bound_flow(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gohighlevel")))
    assert "code_challenge" not in p  # HighLevel documents no PKCE
    # A different session can't complete it without the state.
    other = portal_client(org["owner"])
    assert _error(_callback(other, "gohighlevel", code=_code(fake, "gohighlevel", p))) == "state_invalid"
    r = _callback(client, "gohighlevel", code=_code(fake, "gohighlevel", p))
    assert "/integrations/connected/gohighlevel" in r["Location"]
    conn = IntegrationConnection.objects.get(provider="gohighlevel")
    assert conn.account_id == "mockLocation001" and conn.scope == "workspace"


def test_access_denied_spends_the_state(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "slack")))
    assert _error(_callback(client, "slack", error="access_denied", state=p["state"])) == "access_denied"
    assert _error(_callback(client, "slack", code="mock-code-x", state=p["state"])) in {"state_used", "session_mismatch"}


def test_begin_requires_portal_sign_in(org, fake, configured):
    url = start_flow(org["owner"], org["ws"], "gmail")
    u = urlsplit(url)
    r = Client().get(u.path + "?" + u.query)
    assert r.status_code == 302 and "/accounts/login/" in r["Location"]


def test_roles_who_may_connect(org, fake, configured):
    agent = api_for(org["agent"])
    r = agent.post(f"{ibase(org['ws'])}/connections/oauth-start", {"provider": "slack"})
    assert r.status_code == 403
    assert agent.post(f"{ibase(org['ws'])}/connections/oauth-start", {"provider": "gmail"}).status_code == 201
    ro = api_for(org["readonly"])
    assert ro.post(f"{ibase(org['ws'])}/connections/oauth-start", {"provider": "gmail"}).status_code == 403


def test_not_configured_and_no_key(org, fake):
    r = api_for(org["owner"]).post(f"{ibase(org['ws'])}/connections/oauth-start", {"provider": "gmail"})
    assert r.status_code == 409 and body(r)["error"]["code"] == "not_configured"
    with override_settings(NEXUS_INTEGRATIONS_KEYS=[]):
        r = api_for(org["owner"]).post(f"{ibase(org['ws'])}/connections/oauth-start", {"provider": "gmail"})
        assert body(r)["error"]["code"] == "encryption_key_missing"


def test_mock_mode_refused_in_production(org, fake):
    with override_settings(NEXUS_INTEGRATIONS_MOCK=True, NEXUS_ENVIRONMENT="production"):
        assert conf.mock_mode() is False and conf.mock_refused() is True
        r = api_for(org["owner"]).get(f"{ibase(org['ws'])}/providers")
        gmail = next(x for x in body(r)["data"] if x["id"] == "gmail")
        assert gmail["mock"] is False and gmail["mock_refused"] is True and gmail["configured"] is False
        assert Client().get("/integrations/mock/google/authorize").status_code == 404


def test_mock_mode_flow_is_labelled(org, fake):
    with override_settings(NEXUS_INTEGRATIONS_MOCK=True):
        client = portal_client(org["owner"])
        r = begin(client, start_flow(org["owner"], org["ws"], "gmail"))
        loc = r["Location"]
        assert loc.startswith(f"{conf.base_url()}/integrations/mock/google/authorize")
        page = client.get(urlsplit(loc).path + "?" + urlsplit(loc).query)
        assert b"Mock provider (development)" in page.content
        params = dict(parse_qs(urlsplit(loc).query))
        form = {k: v[0] for k, v in params.items()} | {"decision": "allow"}
        r = client.post(urlsplit(loc).path, form)
        cb = urlsplit(r["Location"])
        r = client.get(cb.path + "?" + cb.query)
        assert "/integrations/connected/gmail" in r["Location"]
        conn = IntegrationConnection.objects.get(provider="gmail")
        assert conn.is_mock and conn.is_demo
        data = body(api_for(org["owner"]).get(f"{ibase(org['ws'])}/connections/{conn.pk}"))["data"]
        assert data["mock_label"] == "Mock provider (development)"


# --- tokens: refresh, expiry, revocation -----------------------------------------------------------------


@pytest.fixture
def gmail(org, fake, configured):
    return connect(fake, org["owner"], org["ws"], "gmail", account="owner.intg@example.com")


def test_expired_access_token_is_refreshed_before_use(org, fake, configured, gmail):
    cred = IntegrationCredential.objects.get(connection=gmail)
    IntegrationCredential.objects.filter(pk=cred.pk).update(access_expires_at=timezone.now() - timedelta(minutes=1))
    assert sync_connection(gmail)["ok"]
    assert fake.google.refresh_count == 1
    cred2 = IntegrationCredential.objects.get(connection=gmail)
    assert cred2.version == cred.version + 1 and cred2.access_expires_at > timezone.now()


def test_401_triggers_one_refresh_and_retry(org, fake, configured, gmail):
    state = {"n": 0}

    def once_401(req):
        if "gmail.googleapis.com" in req.url and state["n"] == 0:
            state["n"] += 1
            from apps.integrations.mock.providers import _json

            return _json(401, {"error": {"code": 401, "message": "Invalid Credentials"}})
        return None

    fake.google.interceptors.append(once_401)
    assert sync_connection(gmail)["ok"]
    assert fake.google.refresh_count == 1


def test_revoked_refresh_token_moves_to_needs_reauth(org, fake, configured, gmail):
    fake.google.refresh_rejected = True
    fake.google.access_rejected = True
    out = sync_connection(gmail)
    assert out == {"ok": False, "code": "reauth_required"}
    gmail.refresh_from_db()
    assert gmail.status == "needs_reauth" and gmail.last_error_code
    data = body(api_for(org["owner"]).get(f"{ibase(org['ws'])}/connections/{gmail.pk}"))["data"]
    assert data["status"] == "needs_reauth" and data["actions"]["reconnect"] is True
    # API calls that need the provider now answer with a clear reauth error.
    r = api_for(org["owner"]).get(f"{ibase(org['ws'])}/gmail/search", {"q": "mock"})
    assert r.status_code in (200, 409)
    sync_connection(gmail)  # no provider call while needs_reauth
    assert fake.google.refresh_count == 0


def test_token_without_refresh_expires_to_needs_reauth(org, fake, configured):
    conn = connect(fake, org["owner"], org["ws"], "slack", account="T0MOCK0001")
    IntegrationCredential.objects.filter(connection=conn).update(access_expires_at=timezone.now() - timedelta(minutes=1))
    assert sync_connection(conn)["code"] == "reauth_required"
    conn.refresh_from_db()
    assert conn.status == "needs_reauth"


def test_reconnect_restores_and_wrong_account_is_refused(org, fake, configured, gmail):
    IntegrationConnection.objects.filter(pk=gmail.pk).update(status="needs_reauth")
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail", reconnect_id=str(gmail.pk))))
    assert p["login_hint"] == "owner.intg@example.com"
    r = _callback(client, "gmail", code=_code(fake, "gmail", p, account="someone.else@example.com"), state=p["state"])
    assert _error(r) == "wrong_account"
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail", reconnect_id=str(gmail.pk))))
    r = _callback(client, "gmail", code=_code(fake, "gmail", p), state=p["state"])
    assert "/integrations/connected/gmail" in r["Location"]
    gmail.refresh_from_db()
    assert gmail.status == "connected" and IntegrationConnection.objects.filter(provider="gmail").count() == 1


def test_denied_read_scope_cannot_connect_and_compose_is_optional(org, fake, configured):
    client = portal_client(org["owner"])
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    code = _code(fake, "gmail", p, extra={"scope": "https://www.googleapis.com/auth/gmail.compose"})
    assert _error(_callback(client, "gmail", code=code, state=p["state"])) == "scope_denied"
    p = provider_params(begin(client, start_flow(org["owner"], org["ws"], "gmail")))
    code = _code(fake, "gmail", p, extra={"scope": "https://www.googleapis.com/auth/gmail.readonly"})
    assert "/integrations/connected/gmail" in _callback(client, "gmail", code=code, state=p["state"])["Location"]
    data = body(api_for(org["owner"]).get(f"{ibase(org['ws'])}/connections"))["data"][0]
    assert data["missing_scopes"] == ["https://www.googleapis.com/auth/gmail.compose"]


def test_same_mailbox_cannot_be_connected_by_two_people(org, fake, configured, gmail):
    client = portal_client(org["agent"])
    p = provider_params(begin(client, start_flow(org["agent"], org["ws"], "gmail")))
    r = _callback(client, "gmail", code=_code(fake, "gmail", p, account="owner.intg@example.com"), state=p["state"])
    assert _error(r) == "account_in_use"
