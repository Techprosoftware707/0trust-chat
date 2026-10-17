"""OIDC provider used by the homeserver: claims, policy gate, client auth."""

import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from django.core.management import call_command
from django.test import Client

from apps.billing.models import Plan
from apps.billing.services import assign_manual_plan
from apps.core.models import SecurityEvent
from apps.workspaces import services as ws_services

from .factories import ensure_plans, make_user

pytestmark = pytest.mark.django_db
REDIRECT = "https://matrix.lumen.test/_synapse/client/oidc/callback"


@pytest.fixture(autouse=True)
def setup():
    ensure_plans()
    call_command("lumen_bootstrap", verbosity=0)


def authorize(client, scope="openid profile email"):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    r = client.get(
        "/identity/o/authorize",
        {"response_type": "code", "client_id": "lumen-synapse", "redirect_uri": REDIRECT, "scope": scope, "state": "st", "nonce": "nn", "code_challenge_method": "S256", "code_challenge": challenge},
    )
    return r, verifier


def token(code, verifier, **extra):
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "code_verifier": verifier, "client_id": "lumen-synapse", "client_secret": "test-oidc-client-secret"}
    data.update(extra)
    return Client().post("/identity/o/api/token", data)


def test_discovery_and_jwks():
    d = Client().get("/.well-known/openid-configuration").json()
    assert d["issuer"] == "https://lumen.test"
    # "none" exists for registered PUBLIC clients (the workspace SPA, PKCE-only); every
    # confidential client still has to post its secret (test_confidential_client_needs_secret).
    assert d["token_endpoint_auth_methods_supported"] == ["client_secret_post", "none"]
    assert "S256" in d["code_challenge_methods_supported"]
    keys = Client().get("/.well-known/jwks.json").json()["keys"]
    assert keys and "d" not in keys[0]  # no private material


def test_anonymous_redirected_to_login():
    r, _ = authorize(Client())
    assert r.status_code == 302 and "/accounts/login/" in r["Location"]


def test_full_code_flow_claims():
    u = make_user("zoe", display_name="Zoë")
    c = Client(); c.force_login(u)
    r, verifier = authorize(c)
    assert r.status_code == 302 and r["Location"].startswith(REDIRECT)
    code = parse_qs(urlparse(r["Location"]).query)["code"][0]
    t = token(code, verifier)
    assert t.status_code == 200, t.content
    body = t.json()
    claims = jwt.decode(body["id_token"], options={"verify_signature": False})
    assert claims["sub"] == str(u.public_id)  # random, non-enumerable
    assert claims["preferred_username"] == "zoe" and claims["name"] == "Zoë"
    assert claims["nonce"] == "nn" and claims["aud"] == "lumen-synapse"
    assert SecurityEvent.objects.filter(user=u, kind="oidc_granted").exists()
    # authorization codes are single-use
    assert token(code, verifier).status_code == 400


def test_pkce_verifier_required():
    u = make_user()
    c = Client(); c.force_login(u)
    r, _ = authorize(c)
    code = parse_qs(urlparse(r["Location"]).query)["code"][0]
    assert token(code, "wrong-verifier-" + "x" * 40).status_code == 400


def test_wrong_client_secret_rejected():
    u = make_user()
    c = Client(); c.force_login(u)
    r, v = authorize(c)
    code = parse_qs(urlparse(r["Location"]).query)["code"][0]
    assert token(code, v, client_secret="nope").status_code == 401


def test_client_secret_stored_hashed():
    from allauth.idp.oidc.models import Client as OidcClient

    cl = OidcClient.objects.get(id="lumen-synapse")
    assert "test-oidc-client-secret" not in cl.secret and cl.check_secret("test-oidc-client-secret")


def test_unregistered_redirect_uri_rejected():
    u = make_user()
    c = Client(); c.force_login(u)
    r = c.get("/identity/o/authorize", {"response_type": "code", "client_id": "lumen-synapse", "redirect_uri": "https://evil.example/cb", "scope": "openid", "code_challenge_method": "S256", "code_challenge": "x" * 43})
    # allauth renders an error page (status 200) instead of redirecting: the
    # important property is that nothing is sent to the unregistered URI.
    assert r.status_code in (200, 400) and "Location" not in r
    assert b"evil.example" not in r.content or b"redirect" in r.content.lower()


def test_workspace_mfa_policy_blocks_chat_signin():
    owner = make_user("boss", mfa=True)
    ws = ws_services.create_workspace(owner, "Strict Org")
    assign_manual_plan(ws, Plan.objects.get(code="pro"))
    ws_services.update_settings(owner, ws.pk, name=ws.name, require_mfa=True, allow_member_invites=False)
    from apps.workspaces.models import Membership

    no_mfa = make_user("lax")
    Membership.objects.create(workspace=ws, user=no_mfa)
    c = Client(); c.force_login(no_mfa)
    r, _ = authorize(c)
    assert r.status_code == 403 and b"two-factor" in r.content
    assert SecurityEvent.objects.filter(user=no_mfa, kind="oidc_denied").exists()
    c2 = Client(); c2.force_login(owner)
    r2, _ = authorize(c2)
    assert r2.status_code == 302 and "code=" in r2["Location"]


def test_pending_deletion_blocks_chat_signin():
    from apps.accounts.models import AccountStatus

    u = make_user()
    u.set_status(AccountStatus.PENDING_DELETION); u.save()
    c = Client(); c.force_login(u)
    r, _ = authorize(c)
    assert r.status_code == 403


def test_confidential_client_needs_secret():
    """Offering "none" for public clients must not let the homeserver's confidential
    client redeem a code without its secret."""
    u = make_user()
    c = Client(); c.force_login(u)
    r, v = authorize(c)
    code = parse_qs(urlparse(r["Location"]).query)["code"][0]
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "code_verifier": v, "client_id": "lumen-synapse"}
    assert Client().post("/identity/o/api/token", data).status_code == 401
    assert token(code, v).status_code == 200  # the code is still unused, and works with the secret


def test_chat_login_times_only_for_homeserver_client():
    """Authorizing the workspace SPA (nexus-web) is not a chat sign-in."""
    u = make_user()
    c = Client(); c.force_login(u)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    r = c.get("/identity/o/authorize", {"response_type": "code", "client_id": "nexus-web", "redirect_uri": "https://app.lumen.test/oauth/callback",
                                        "scope": "workspace:read workspace:write", "state": "s", "code_challenge_method": "S256", "code_challenge": challenge})
    assert r.status_code == 302 and "code=" in r["Location"]
    u.refresh_from_db()
    assert u.chat_last_login_at is None
