"""Bearer authentication of the Nexus API and the first-party SPA client (nexus-web)."""

import base64
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from allauth.idp.oidc.models import Client as OidcClient
from allauth.idp.oidc.models import Token
from django.conf import settings
from django.core.management import call_command
from django.test import Client
from django.utils import timezone

from apps.accounts.models import AccountStatus
from apps.api.auth import TokenPolicy, authenticate_bearer
from apps.api.errors import InsufficientScope, Unauthenticated

from .factories import ensure_plans, make_user
from .nexus_helpers import Api, api_for, body, business_workspace, issue_token

pytestmark = pytest.mark.django_db
SPA = "https://app.lumen.test"
REDIRECT = f"{SPA}/oauth/callback"


@pytest.fixture(autouse=True)
def setup():
    ensure_plans()
    call_command("lumen_bootstrap", verbosity=0)


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize(client, challenge, **extra):
    params = {"response_type": "code", "client_id": "nexus-web", "redirect_uri": REDIRECT, "scope": "workspace:read workspace:write",
              "state": "st-1", "code_challenge_method": "S256", "code_challenge": challenge}
    params.update(extra)
    return client.get("/identity/o/authorize", params)


def exchange(code, verifier, **extra):
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "code_verifier": verifier, "client_id": "nexus-web"}
    data.update(extra)
    return Client().post("/identity/o/api/token", data, HTTP_ORIGIN=SPA)


# --- the client registration ------------------------------------------------------------------


def test_nexus_web_client_is_public_pkce_first_party():
    cl = OidcClient.objects.get(id="nexus-web")
    assert cl.type == OidcClient.Type.PUBLIC
    assert cl.get_redirect_uris() == [REDIRECT]
    assert set(cl.get_grant_types()) == {"authorization_code", "refresh_token"}
    assert cl.get_response_types() == ["code"]
    assert set(cl.get_scopes()) == {"workspace:read", "workspace:write"}
    assert cl.get_cors_origins() == [SPA]
    assert cl.skip_consent and not cl.allow_uri_wildcards
    assert not cl.check_secret("") and not cl.check_secret("anything")
    call_command("lumen_bootstrap", verbosity=0)  # idempotent
    assert OidcClient.objects.filter(id="nexus-web").count() == 1


def test_code_flow_with_pkce_refresh_rotation_and_cors():
    u = make_user("spa-user")
    c = Client(); c.force_login(u)
    verifier, challenge = pkce()
    r = authorize(c, challenge)
    assert r.status_code == 302 and r["Location"].startswith(REDIRECT + "?")  # consent skipped
    q = parse_qs(urlparse(r["Location"]).query)
    assert q["state"] == ["st-1"]
    t = exchange(q["code"][0], verifier)
    assert t.status_code == 200, t.content
    assert t["Access-Control-Allow-Origin"] == SPA
    tokens = t.json()
    assert tokens["token_type"].lower() == "bearer" and tokens["expires_in"] == 300
    assert set(tokens["scope"].split()) == {"workspace:read", "workspace:write"}
    assert "id_token" not in tokens  # no openid scope requested
    me = Api(tokens["access_token"]).get("/api/v1/me")
    assert me.status_code == 200 and body(me)["data"]["user"]["username"] == "spa-user"
    # Refresh: rotation issues a new refresh token and the old one stops working.
    r1 = Client().post("/identity/o/api/token", {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": "nexus-web"},
                       HTTP_ORIGIN=SPA)
    assert r1.status_code == 200 and r1["Access-Control-Allow-Origin"] == SPA
    new = r1.json()
    assert new["refresh_token"] != tokens["refresh_token"]
    again = Client().post("/identity/o/api/token", {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": "nexus-web"},
                          HTTP_ORIGIN=SPA)
    assert again.status_code in (400, 401)
    assert again["Access-Control-Allow-Origin"] == SPA  # errors are readable by the SPA too
    assert Api(new["access_token"]).get("/api/v1/me").status_code == 200


def test_pkce_is_required_for_the_public_client():
    u = make_user()
    c = Client(); c.force_login(u)
    r = c.get("/identity/o/authorize", {"response_type": "code", "client_id": "nexus-web", "redirect_uri": REDIRECT,
                                        "scope": "workspace:read", "state": "s"})
    assert not (r.status_code == 302 and "code=" in r.get("Location", ""))
    verifier, challenge = pkce()
    r = authorize(c, challenge)
    code = parse_qs(urlparse(r["Location"]).query)["code"][0]
    assert exchange(code, "x" * 50).status_code == 400  # wrong verifier
    assert exchange(code, verifier).status_code == 200


def test_exact_redirect_uri_only():
    u = make_user()
    c = Client(); c.force_login(u)
    _, challenge = pkce()
    for bad in ("https://app.lumen.test/oauth/callback/../x", "https://evil.example/oauth/callback", "https://app.lumen.test/"):
        r = authorize(c, challenge, redirect_uri=bad)
        assert not (r.status_code == 302 and r.get("Location", "").startswith(bad.split("?")[0]) and "code=" in r["Location"])


def test_scopes_outside_the_client_are_refused():
    u = make_user()
    c = Client(); c.force_login(u)
    _, challenge = pkce()
    r = authorize(c, challenge, scope="workspace:read admin:everything")
    assert "code=" not in r.get("Location", "")


def test_untrusted_origin_gets_no_cors_on_token_endpoint():
    r = Client().post("/identity/o/api/token", {"grant_type": "refresh_token", "refresh_token": "x", "client_id": "nexus-web"},
                      HTTP_ORIGIN="https://evil.example")
    assert "Access-Control-Allow-Origin" not in r


def test_logout_revokes_spa_tokens():
    u = make_user()
    token = issue_token(u)
    c = Client(); c.force_login(u)
    c.post("/accounts/logout/")
    assert Api(token).get("/api/v1/me").status_code == 401
    assert not Token.objects.filter(user=u, client_id="nexus-web").exists()


# --- bearer validation --------------------------------------------------------------------------


def test_valid_token_and_environment_header():
    u = make_user()
    r = api_for(u).get("/api/v1/me")
    assert r.status_code == 200
    assert r["X-Nexus-Environment"] == "test"
    assert r["Cache-Control"] == "no-store"
    data = body(r)["data"]
    assert data["environment"] == "test" and data["user"]["id"] == str(u.public_id)


def test_missing_token_is_401_with_challenge():
    r = Api(None).get("/api/v1/me")
    assert r.status_code == 401
    assert r["WWW-Authenticate"].startswith('Bearer realm="nexus-api"')
    err = body(r)["error"]
    assert err["code"] == "unauthenticated" and err["request_id"]


@pytest.mark.parametrize("header", ["Basic dXNlcjpwYXNz", "Bearer", "Bearer short", "Token abcdefghijklmnopqrstuvwxyz", "Bearer a b c d e f g h i j k l"])
def test_malformed_authorization_header(header):
    r = Client().get("/api/v1/me", HTTP_AUTHORIZATION=header)
    assert r.status_code == 401 and body(r)["error"]["code"] == "unauthenticated"


def test_invalid_token():
    r = Api(secrets.token_urlsafe(64)).get("/api/v1/me")
    assert r.status_code == 401 and 'error="invalid_token"' in r["WWW-Authenticate"]


def test_expired_token():
    u = make_user()
    token = issue_token(u)
    Token.objects.filter(user=u).update(expires_at=timezone.now() - timedelta(seconds=1))
    r = Api(token).get("/api/v1/me")
    assert r.status_code == 401 and 'error="invalid_token"' in r["WWW-Authenticate"]


def test_wrong_scope():
    owner = make_user()
    ws = business_workspace(owner)
    read_only = Api(issue_token(owner, scopes=["workspace:read"]))
    assert read_only.get(f"/api/v1/workspaces/{ws.pk}/crm/contacts").status_code == 200
    r = read_only.post(f"/api/v1/workspaces/{ws.pk}/crm/contacts", {"first_name": "A"})
    assert r.status_code == 403 and body(r)["error"]["code"] == "insufficient_scope"
    assert 'error="insufficient_scope"' in r["WWW-Authenticate"] and "workspace:write" in r["WWW-Authenticate"]
    no_scope = Api(issue_token(owner, scopes=["openid"]))
    assert no_scope.get("/api/v1/me").status_code == 403


def test_token_of_another_client_is_refused():
    """The homeserver's tokens (or any other client's) are not API tokens."""
    u = make_user()
    r = Api(issue_token(u, client_id="lumen-synapse")).get("/api/v1/me")
    assert r.status_code == 401


def test_resource_bound_tokens_need_the_right_audience():
    u = make_user()
    wrong = issue_token(u, client_id="some-mcp-client", resources=["https://lumen.test/mcp"])
    assert Api(wrong).get("/api/v1/me").status_code == 401
    right = issue_token(u, client_id="some-mcp-client", resources=[settings.NEXUS_API_RESOURCE])
    assert Api(right).get("/api/v1/me").status_code == 200


def test_policy_is_reusable_for_another_resource(rf):
    """The MCP team's pattern: their own resource, scopes and resource-bound tokens only."""
    u = make_user()
    mcp = TokenPolicy(name="mcp", resource="https://lumen.test/mcp", allowed_client_ids=None, realm="nexus-mcp")
    good = issue_token(u, client_id="claude-mcp", scopes=["mcp:read"], resources=["https://lumen.test/mcp"])
    req = rf.get("/mcp/", HTTP_AUTHORIZATION=f"Bearer {good}")
    ctx = authenticate_bearer(req, policy=mcp, scopes=["mcp:read"])
    assert ctx.user == u and ctx.client_id == "claude-mcp" and req.user == u
    with pytest.raises(InsufficientScope):
        authenticate_bearer(rf.get("/mcp/", HTTP_AUTHORIZATION=f"Bearer {good}"), policy=mcp, scopes=["mcp:write"])
    spa = issue_token(u)  # first-party token without resources: not accepted by a resource-only policy
    with pytest.raises(Unauthenticated):
        authenticate_bearer(rf.get("/mcp/", HTTP_AUTHORIZATION=f"Bearer {spa}"), policy=mcp, scopes=[])


def test_token_in_query_string_is_refused():
    u = make_user()
    token = issue_token(u)
    r = Client().get(f"/api/v1/me?access_token={token}")
    assert r.status_code == 401
    r = Client().get(f"/api/v1/me?access_token={token}", HTTP_AUTHORIZATION=f"Bearer {token}")
    assert r.status_code == 401


def test_session_cookie_alone_is_not_enough():
    """CSRF safety: the API never authenticates with the portal session."""
    u = make_user()
    c = Client(); c.force_login(u)
    assert c.get("/api/v1/me").status_code == 401
    ws = business_workspace(u)
    r = c.post(f"/api/v1/workspaces/{ws.pk}/crm/contacts", '{"first_name": "X"}', content_type="application/json")
    assert r.status_code == 401


@pytest.mark.parametrize("status", [AccountStatus.SUSPENDED, AccountStatus.PENDING_DELETION])
def test_inactive_accounts_are_refused(status):
    u = make_user()
    token = issue_token(u)
    u.set_status(status); u.save()
    assert Api(token).get("/api/v1/me").status_code == 401


def test_failed_attempts_are_rate_limited_per_ip():
    limit, _ = settings.NEXUS_API_RATE_LIMITS["auth_failures"]
    for _ in range(limit):
        assert Api("x" * 40).get("/api/v1/me").status_code == 401
    r = Api("x" * 40).get("/api/v1/me")
    assert r.status_code == 429 and body(r)["error"]["code"] == "rate_limited" and r["Retry-After"]
    # Even a valid token is held back while the IP is over its failure budget.
    assert api_for(make_user()).get("/api/v1/me").status_code == 429


def test_cors_preflight_and_headers():
    allowed = Client().options("/api/v1/me", HTTP_ORIGIN=SPA, HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
                               HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization")
    assert allowed.status_code == 204 and allowed["Access-Control-Allow-Origin"] == SPA
    assert "Authorization" in allowed["Access-Control-Allow-Headers"]
    assert "Access-Control-Allow-Credentials" not in allowed
    denied = Client().options("/api/v1/me", HTTP_ORIGIN="https://evil.example", HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET")
    assert "Access-Control-Allow-Origin" not in denied
    u = make_user()
    r = Api(issue_token(u)).get("/api/v1/me", HTTP_ORIGIN=SPA)
    assert r["Access-Control-Allow-Origin"] == SPA and "X-Nexus-Environment" in r["Access-Control-Expose-Headers"]


def test_unknown_api_paths_and_methods_use_the_error_format():
    u = make_user()
    api = api_for(u)
    r = api.get("/api/v1/nope")
    assert r.status_code == 404 and body(r)["error"]["code"] == "not_found"
    r = api.post("/api/v1/me", {})
    assert r.status_code == 405 and body(r)["error"]["code"] == "method_not_allowed" and "GET" in r["Allow"]
    assert Client().get("/api/v2/me").status_code == 404
