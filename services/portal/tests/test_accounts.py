import json
import re

import pytest
from django.core.exceptions import ValidationError
from django.test import Client, override_settings
from hypothesis import given, settings as hsettings, strategies as st

from apps.accounts.models import AccountStatus, RetiredUsername, User
from apps.accounts.validators import USERNAME_RE, validate_username_available, validate_username_format
from apps.core.models import SecurityEvent

from .factories import PASSWORD, ensure_plans, make_user, mark_recent_auth

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def plans():
    ensure_plans()


def csrf_client():
    return Client(enforce_csrf_checks=True)


def get_csrf(client, url):
    r = client.get(url)
    m = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', r.content.decode())
    return m.group(1)


class TestUsernames:
    @pytest.mark.parametrize("name", ["alice", "bob.smith", "a_1", "x-y-z", "abc"])
    def test_valid(self, name):
        validate_username_format(name)

    @pytest.mark.parametrize("name", ["Alice", "ab", "-abc", "abc-", "a b", "a@b", "a" * 33, "a..b", "émile", "a/b", "_abc"])
    def test_invalid(self, name):
        with pytest.raises(ValidationError):
            validate_username_format(name)
            validate_username_available(name)

    def test_reserved_and_retired(self):
        with pytest.raises(ValidationError):
            validate_username_available("admin")
        RetiredUsername.objects.create(username="gone")
        with pytest.raises(ValidationError):
            validate_username_available("gone")

    @hsettings(max_examples=300, deadline=None)
    @given(st.text(min_size=0, max_size=40))
    def test_fuzz_never_accepts_invalid_matrix_localpart(self, s):
        """Whatever passes validation must be a legal, lowercase Matrix localpart."""
        try:
            validate_username_format(s)
        except ValidationError:
            return
        assert re.fullmatch(r"[a-z0-9._=/-]+", s), s
        assert 3 <= len(s) <= 32
        assert USERNAME_RE.match(s)


class TestSignupAndLogin:
    def test_signup_creates_account_and_requires_email_verification(self):
        from django.core import mail

        c = csrf_client()
        token = get_csrf(c, "/accounts/signup/")
        r = c.post(
            "/accounts/signup/",
            {
                "csrfmiddlewaretoken": token,
                "username": "newbie",
                "display_name": "New Bie",
                "email": "newbie@example.org",
                "password1": PASSWORD,
                "password2": PASSWORD,
                "accept_terms": "on",
            },
        )
        # Email delivery is enabled in tests, so verification is mandatory.
        assert r.status_code == 302 and r["Location"] == "/accounts/confirm-email/"
        assert len(mail.outbox) == 1 and mail.outbox[0].to == ["newbie@example.org"]
        link = re.search(r"https?://[^\s]+/accounts/confirm-email/[^\s]+", mail.outbox[0].body).group(0)
        path = "/" + link.split("/", 3)[3]
        token = get_csrf(c, path)
        r = c.post(path, {"csrfmiddlewaretoken": token})
        assert r.status_code == 302
        u = User.objects.get(username="newbie")
        from allauth.account.models import EmailAddress

        assert EmailAddress.objects.get(user=u).verified
        assert u.display_name == "New Bie"
        assert u.password.startswith("argon2")
        assert not u.is_superuser

    def test_signup_requires_terms_and_strong_password(self):
        c = Client()
        r = c.post("/accounts/signup/", {"username": "weak", "email": "w@example.org", "password1": "password", "password2": "password"})
        assert r.status_code == 200
        assert not User.objects.filter(username="weak").exists()

    def test_signup_rejects_uppercase_reserved(self):
        c = Client()
        for name in ["admin", "Root"]:
            c.post("/accounts/signup/", {"username": name, "email": f"{name}@example.org", "password1": PASSWORD, "password2": PASSWORD, "accept_terms": "on"})
        assert not User.objects.filter(username__in=["admin", "root"]).exists()

    def test_post_without_csrf_rejected(self):
        c = csrf_client()
        r = c.post("/accounts/login/", {"login": "x", "password": "y"})
        assert r.status_code == 403

    def test_login_failure_recorded(self):
        make_user("carol")
        c = Client()
        c.post("/accounts/login/", {"login": "carol", "password": "wrong password!!"})
        assert SecurityEvent.objects.filter(kind="login_failed", user__username="carol").exists()

    def test_suspended_user_cannot_login(self):
        u = make_user("dave")
        u.set_status(AccountStatus.SUSPENDED, "abuse")
        u.save()
        c = Client()
        r = c.post("/accounts/login/", {"login": "dave", "password": PASSWORD})
        assert "_auth_user_id" not in c.session
        assert r.status_code in (200, 302)

    def test_suspended_session_is_terminated(self):
        u = make_user("erin")
        c = Client()
        c.force_login(u)
        assert c.get("/portal/dashboard/").status_code == 200
        u.set_status(AccountStatus.SUSPENDED, "abuse")
        u.save()
        r = c.get("/portal/dashboard/")
        assert r.status_code == 302
        assert c.get("/portal/dashboard/").status_code == 302

    @override_settings(SESSION_IDLE_TIMEOUT=1)
    def test_idle_timeout(self):
        u = make_user("frank")
        c = Client()
        c.force_login(u)
        s = c.session
        s["_lumen_last_seen"] = 1
        s.save()
        r = c.get("/portal/dashboard/")
        assert r.status_code == 302 and "/accounts/login/" in r["Location"]

    def test_no_superuser_ever(self):
        u = make_user("gina")
        u.is_superuser = True
        u.save()
        u.refresh_from_db()
        assert u.is_superuser is False
        with pytest.raises(RuntimeError):
            User.objects.create_superuser("root2", "r@example.org", PASSWORD)

    @pytest.mark.parametrize("email_enabled", [False, True])
    def test_mfa_enrolment_and_email_verification(self, settings, email_enabled):
        """Without SMTP no email can be verified, which must not block MFA enrolment.
        With SMTP, allauth's verified-email guard stays in place."""
        from allauth.account.models import EmailAddress

        from lumen import settings as lumen_settings

        assert lumen_settings.MFA_ALLOW_UNVERIFIED_EMAIL is (not lumen_settings.EMAIL_ENABLED)
        settings.MFA_ALLOW_UNVERIFIED_EMAIL = not email_enabled
        u = make_user(f"hana{int(email_enabled)}")
        EmailAddress.objects.filter(user=u).update(verified=False)
        c = Client()
        c.force_login(u)
        mark_recent_auth(c)
        r = c.get("/accounts/2fa/totp/activate/")
        if email_enabled:
            assert r.status_code == 302 and r["Location"] == "/accounts/2fa/"
        else:
            assert r.status_code == 200 and b'id="authenticator_secret"' in r.content


class TestPrivacy:
    def test_export_contains_only_own_data(self):
        a = make_user("hank")
        make_user("ivy")
        c = Client()
        c.force_login(a)
        r = c.get("/portal/privacy/export/")
        data = json.loads(r.content)
        assert data["account"]["username"] == "hank"
        assert "ivy" not in r.content.decode()
        assert "password" not in json.dumps(data["account"])

    def test_deletion_requires_reauth_and_confirmation(self):
        from .factories import mark_recent_auth

        u = make_user("jack")
        c = Client()
        c.force_login(u)
        r = c.post("/portal/privacy/delete/", {"confirm_username": "jack"})
        assert r.status_code in (302, 303) and "reauthenticate" in r["Location"]
        mark_recent_auth(c)
        c.post("/portal/privacy/delete/", {"confirm_username": "wrong"})
        u.refresh_from_db()
        assert u.status == AccountStatus.ACTIVE
        c.post("/portal/privacy/delete/", {"confirm_username": "jack"})
        u.refresh_from_db()
        assert u.status == AccountStatus.PENDING_DELETION and u.deletion_scheduled_for
        c.post("/portal/privacy/delete/cancel/")
        u.refresh_from_db()
        assert u.status == AccountStatus.ACTIVE

    def test_display_name_is_escaped(self):
        u = make_user("kim", display_name='<script>alert(1)</script>')
        c = Client()
        c.force_login(u)
        body = c.get("/portal/dashboard/").content.decode()
        assert "<script>alert(1)</script>" not in body
        assert "&lt;script&gt;" in body
