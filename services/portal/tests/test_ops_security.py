"""Operator console access control, audit integrity, internal API, headers."""

import pytest
from django.db import connection, transaction
from django.db.utils import DatabaseError
from django.test import Client

from apps.accounts.models import AccountStatus, User
from apps.core import ratelimit
from apps.core.audit import audit
from apps.core.auditchain import verify_chain
from apps.core.models import AuditEvent, SecurityEvent

from .factories import ensure_plans, make_user, mark_recent_auth, ops_client

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def plans():
    ensure_plans()


class TestOpsAccess:
    def test_gateway_secret_required(self):
        op = make_user("op1", staff_role="owner", mfa=True)
        c = Client(); c.force_login(op)
        assert c.get("/ops/dashboard/").status_code == 404
        c2 = Client(HTTP_X_LUMEN_GATEWAY="guess"); c2.force_login(op)
        assert c2.get("/ops/dashboard/").status_code == 404
        assert ops_client(op).get("/ops/dashboard/").status_code == 200

    def test_non_operator_forbidden_and_logged_out(self):
        u = make_user("customer")
        c = ops_client(u)
        r = c.get("/ops/dashboard/")
        assert r.status_code == 403
        assert SecurityEvent.objects.filter(kind="ops_access_denied", user=u).exists()
        assert "_auth_user_id" not in c.session

    def test_operator_without_mfa_must_enrol(self):
        op = make_user("op2", staff_role="admin", mfa=False)
        r = ops_client(op).get("/ops/users/")
        assert r.status_code == 302 and "/accounts/2fa/" in r["Location"]

    @pytest.mark.parametrize(
        "role,path,expected",
        [
            ("auditor", "/ops/audit/", 200),
            ("auditor", "/ops/security/", 200),
            ("billing", "/ops/audit/", 403),
            ("support", "/ops/plans/{plan}/", 403),
            ("billing", "/ops/plans/{plan}/", 200),
            ("support", "/ops/users/", 200),
        ],
    )
    def test_rbac_views(self, role, path, expected):
        from apps.billing.models import Plan

        op = make_user(f"r-{role}-{expected}", staff_role=role, mfa=True)
        path = path.format(plan=Plan.objects.get(code="pro").pk)
        assert ops_client(op).get(path).status_code == expected

    def test_auditor_cannot_suspend(self):
        auditor = make_user("aud", staff_role="auditor", mfa=True)
        victim = make_user("victim1")
        c = ops_client(auditor)
        mark_recent_auth(c)
        r = c.post(f"/ops/users/{victim.pk}/suspend/", {"action": "suspend", "reason": "x"})
        assert r.status_code == 403
        victim.refresh_from_db()
        assert victim.status == AccountStatus.ACTIVE

    def test_suspend_requires_step_up_and_is_audited(self):
        admin = make_user("adm", staff_role="admin", mfa=True)
        victim = make_user("victim2")
        c = ops_client(admin)
        r = c.post(f"/ops/users/{victim.pk}/suspend/", {"action": "suspend", "reason": "spam"})
        assert r.status_code == 302 and "reauthenticate" in r["Location"]
        victim.refresh_from_db()
        assert victim.status == AccountStatus.ACTIVE
        mark_recent_auth(c)
        c.post(f"/ops/users/{victim.pk}/suspend/", {"action": "suspend", "reason": "spam"})
        victim.refresh_from_db()
        assert victim.status == AccountStatus.SUSPENDED
        ev = AuditEvent.objects.filter(action="ops.user_suspend").first()
        assert ev.actor == admin and ev.metadata["reason"] == "spam"

    def test_mfa_reset_requires_typed_confirmation(self):
        owner = make_user("own", staff_role="owner", mfa=True)
        victim = make_user("victim3", mfa=True)
        c = ops_client(owner); mark_recent_auth(c)
        c.post(f"/ops/users/{victim.pk}/reset-mfa/", {"confirm": "wrong"})
        from allauth.mfa.models import Authenticator

        assert Authenticator.objects.filter(user=victim).exists()
        c.post(f"/ops/users/{victim.pk}/reset-mfa/", {"confirm": "victim3"})
        assert not Authenticator.objects.filter(user=victim).exists()

    def test_only_owner_manages_staff_and_last_owner_protected(self):
        owner = make_user("own2", staff_role="owner", mfa=True)
        admin = make_user("adm2", staff_role="admin", mfa=True)
        c = ops_client(admin); mark_recent_auth(c)
        assert c.post(f"/ops/users/{admin.pk}/role/", {"role": "owner"}).status_code == 403
        c = ops_client(owner); mark_recent_auth(c)
        c.post(f"/ops/users/{owner.pk}/role/", {"role": "admin"})
        owner.refresh_from_db()
        assert owner.staff_role == "owner"

    def test_operator_cannot_see_message_content_fields(self):
        """The console's user page renders homeserver *metadata* only."""
        op = make_user("op3", staff_role="admin", mfa=True)
        u = make_user("someone")
        body = ops_client(op).get(f"/ops/users/{u.pk}/").content.decode()
        for forbidden in ["m.room.message", "ciphertext", "session_key", "recovery key value"]:
            assert forbidden not in body


class TestAuditLog:
    def test_append_only_at_database_level(self):
        audit(None, "test.event", metadata={"a": 1})
        ev = AuditEvent.objects.first()
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cur:
                cur.execute("UPDATE core_auditevent SET action = 'tampered' WHERE id = %s", [ev.pk])
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cur:
                cur.execute("DELETE FROM core_auditevent WHERE id = %s", [ev.pk])

    def test_hash_chain_detects_gaps(self):
        for i in range(5):
            audit(None, f"chain.{i}")
        assert verify_chain()["ok"]
        middle = AuditEvent.objects.order_by("id")[2]
        with transaction.atomic():
            with connection.cursor() as cur:
                cur.execute("SET LOCAL lumen.audit_purge = 'on'")
                cur.execute("DELETE FROM core_auditevent WHERE id = %s", [middle.pk])
        result = verify_chain()
        assert not result["ok"] and result["reason"] == "prev_hash mismatch"

    def test_secrets_redacted_from_metadata(self):
        audit(None, "test.redact", metadata={"password": "hunter2", "api_token": "x", "public_key": "pub"})
        md = AuditEvent.objects.first().metadata
        assert md["password"] == "[redacted]" and md["api_token"] == "[redacted]" and md["public_key"] == "pub"


class TestInternalApi:
    def test_requires_bearer_token(self):
        c = Client()
        assert c.get("/internal/v1/media-limits?user_id=@a:lumen.test").status_code == 401
        assert c.get("/internal/v1/media-limits?user_id=@a:lumen.test", HTTP_AUTHORIZATION="Bearer wrong").status_code == 401

    def test_returns_plan_limits(self):
        u = make_user("media")
        r = Client().get(f"/internal/v1/media-limits?user_id=@media:lumen.test", HTTP_AUTHORIZATION="Bearer test-internal-token")
        d = r.json()
        assert r.status_code == 200 and d["plan"] == "free" and d["upload_max_bytes"] == 25 * 1024 * 1024
        assert d["limits"][0]["time_period_ms"] == 30 * 24 * 3600 * 1000

    def test_rejects_remote_users(self):
        r = Client().get("/internal/v1/media-limits?user_id=@x:evil.example", HTTP_AUTHORIZATION="Bearer test-internal-token")
        assert r.status_code == 400


class TestHeadersAndLimits:
    def test_security_headers(self):
        r = Client().get("/")
        csp = r["Content-Security-Policy"]
        assert "script-src 'self'" in csp and "unsafe-inline" not in csp and "frame-ancestors 'none'" in csp
        assert r["X-Frame-Options"] == "DENY"
        assert r["X-Content-Type-Options"] == "nosniff"
        assert "camera=()" in r["Permissions-Policy"]
        assert r["Cross-Origin-Opener-Policy"] == "same-origin"

    def test_authenticated_pages_not_cached(self):
        u = make_user()
        c = Client(); c.force_login(u)
        assert c.get("/portal/dashboard/")["Cache-Control"] == "no-store"

    def test_no_inline_scripts_or_styles_in_pages(self):
        import re

        u = make_user()
        c = Client(); c.force_login(u)
        for path in ["/", "/pricing/", "/security/", "/portal/dashboard/", "/portal/security/"]:
            html = (c.get(path)).content.decode()
            assert not re.search(r"<script(?![^>]*\bsrc=)(?![^>]*application/json)[^>]*>", html), path
            assert " style=" not in html, path
            assert "onclick=" not in html.lower(), path

    def test_contact_rate_limit(self):
        c = Client()
        codes = [c.post("/contact/", {"name": "n", "email": "e@example.org", "topic": "general", "subject": "s", "message": "m"}).status_code for _ in range(7)]
        assert codes[-1] == 429
        assert SecurityEvent.objects.filter(kind="rate_limited").exists()

    def test_ratelimit_counter_is_atomic(self):
        import threading

        results = []

        def worker():
            from django.db import connection as conn

            results.append(ratelimit.hit("atomic-test", 1000, 3600).count)
            conn.close()

        threads = [threading.Thread(target=worker) for _ in range(20)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert sorted(results) == list(range(1, 21))

    def test_public_surface_hides_ops_and_internal(self):
        # The test surface mounts everything; the guard mirrors production routing.
        from django.test import override_settings

        with override_settings(SURFACE="public"):
            assert Client().get("/ops/dashboard/").status_code == 404
            assert Client().get("/internal/v1/healthz").status_code == 404

    def test_security_txt(self):
        body = Client().get("/.well-known/security.txt").content.decode()
        assert "Contact: mailto:" in body and "Expires:" in body


class TestCryptoPosture:
    def test_negotiated_group_parsing(self, monkeypatch):
        import subprocess

        from apps.ops import probes

        class Done:
            def __init__(self, out):
                self.stdout, self.stderr = out, b""

        monkeypatch.setattr(probes.os.path, "exists", lambda p: True)
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: Done(b"Protocol version: TLSv1.3\nNegotiated TLS1.3 group: X25519MLKEM768\n"))
        assert probes.negotiated_group("lumen.test") == "X25519MLKEM768"
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: Done(b"Negotiated TLS1.3 group: X25519\n"))
        assert probes.negotiated_group("lumen.test") == "X25519"
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: Done(b"connect:errno=111\n"))
        assert probes.negotiated_group("lumen.test") is None

    def test_console_reports_measured_transport_and_classical_e2ee(self):
        from apps.core.models import HealthSnapshot

        op = make_user("crypto-op", staff_role="auditor", mfa=True)
        HealthSnapshot.objects.create(
            component="tls",
            status="ok",
            summary="valid",
            detail={
                "lumen.test": {"seconds_left": 99999, "tls_version": "TLSv1.3", "key_exchange": "X25519MLKEM768"},
                "matrix.lumen.test": {"seconds_left": 99999, "tls_version": "TLSv1.3", "key_exchange": "X25519"},
            },
        )
        body = ops_client(op).get("/ops/security/").content.decode()
        assert "Cryptography in use" in body
        assert body.count("Hybrid</span>") == 1  # only the host that negotiated ML-KEM
        assert "classical; no interoperable PQ Matrix protocol exists yet" in body
