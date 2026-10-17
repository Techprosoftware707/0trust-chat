"""Website messaging (Matrix, WireGuard, "new"), the console's WireGuard page and template hygiene."""

import re

import pytest
from django.test import Client

from apps.core.templatetags.lumen import count_where, isodate, megabytes, seconds_ago

from .factories import ensure_plans, make_user, ops_client

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def plans():
    ensure_plans()


def _no_inline_code(html: str, where: str) -> None:
    assert not re.search(r"<script(?![^>]*\bsrc=)(?![^>]*application/json)[^>]*>", html), where
    assert " style=" not in html, where
    assert not re.search(r"\son[a-z]+=", html, re.I), where


class TestWebsiteMessaging:
    def test_home_highlights_new_matrix_and_wireguard(self):
        html = Client().get("/").content.decode()
        assert 'class="pill-tag">New</span> Secure messaging built on Matrix' in html
        assert 'id="matrix"' in html and "An open standard, not a walled garden" in html
        assert 'id="wireguard"' in html and "Private administration with WireGuard" in html
        assert "trust-strip" in html and "Hybrid post-quantum TLS" in html and "Self-hostable" in html

    @pytest.mark.parametrize("path", ["/", "/features/", "/security/", "/zero-trust/", "/federation/", "/download/", "/docs/self-hosting/"])
    def test_truthful_claims(self, path):
        html = Client().get(path).content.decode().lower()
        # No licence has been chosen yet, and WireGuard never carries users' chats.
        assert "open source" not in html and "open-source" not in html, path
        for claim in ("messages travel over wireguard", "vpn for users", "built-in vpn", "quantum-safe messag", "post-quantum end-to-end"):
            assert claim not in html, (path, claim)
        _no_inline_code(Client().get(path).content.decode(), path)

    def test_wireguard_is_described_as_admin_only(self):
        html = Client().get("/").content.decode()
        assert "It doesn't carry your chats" in html
        assert "Do my messages go through WireGuard?" in html

    def test_calls_copy_follows_the_server_setting(self, settings):
        settings.CALLS_ENABLED = False
        html = Client().get("/features/").content.decode()
        assert "Calls are turned off on this server" in html
        settings.CALLS_ENABLED = True
        html = Client().get("/features/").content.decode()
        assert "Per-frame end-to-end encryption" in html

    def test_error_pages_render_calmly(self):
        r = Client().get("/no-such-page/")
        assert r.status_code == 404
        body = r.content.decode()
        assert "We couldn't find that page" in body and 'id="main"' in body and 'name="robots" content="noindex"' in body


class TestPortalPages:
    def test_dashboard_matrix_card_and_greeting(self):
        u = make_user("greta", display_name="Greta")
        c = Client()
        c.force_login(u)
        html = c.get("/portal/dashboard/").content.decode()
        assert "Your account runs on Matrix" in html and "server-name" in html
        assert "Welcome, Greta" in html
        assert 'name="robots" content="noindex, nofollow"' in html
        _no_inline_code(html, "dashboard")

    def test_portal_pages_have_no_inline_code(self):
        u = make_user("hygiene")
        c = Client()
        c.force_login(u)
        for path in ["/portal/workspaces/", "/portal/profile/", "/portal/privacy/", "/portal/support/", "/portal/security/"]:
            r = c.get(path)
            assert r.status_code == 200, path
            _no_inline_code(r.content.decode(), path)


FIRST_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG="
OTHER_KEY = "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxwVUT="


def _status(**extra):
    base = {
        "interface": "wg0",
        "up": True,
        "address": "10.77.0.1/24",
        "listen_port": 51820,
        "public_key": "SERVERPUBLICKEYabcdefghijklmnopqrstuvwxyz0=",
        "key_created_at": "2026-10-15T01:35:08+00:00",
        "state": "enabled",
        "unavailable_reason": "",
        "endpoint": "vpn.example.com:51820",
        "first_device": {},
        "peers": [
            {"public_key": FIRST_KEY, "name": "operator-laptop", "allowed_ips": "10.77.0.2/32", "latest_handshake": 1, "handshake_age_s": 12, "rx_bytes": 2048, "tx_bytes": 4096, "preshared_key": True},
            {"public_key": OTHER_KEY, "name": "alice-phone", "allowed_ips": "10.77.0.3/32", "latest_handshake": 0, "handshake_age_s": 0, "rx_bytes": 0, "tx_bytes": 0, "preshared_key": True},
        ],
        # Fields a page must never print, even if an agent ever returned them.
        "private_key": "PRIVATE-KEY-MATERIAL-NEVER-RENDER",
        "preshared_key_value": "PSK-MATERIAL-NEVER-RENDER",
    }
    base.update(extra)
    return base


class TestConsoleWireGuard:
    @pytest.fixture
    def admin(self):
        return make_user("wg-admin", staff_role="admin", mfa=True)

    def _get(self, monkeypatch, admin, status, error=""):
        from apps.ops import agent

        monkeypatch.setattr(agent, "safe_call", lambda op, *a, **kw: (status, error))
        r = ops_client(admin).get("/ops/wireguard/")
        assert r.status_code == 200
        html = r.content.decode()
        assert "NEVER-RENDER" not in html
        _no_inline_code(html, "wireguard")
        return html

    def test_requires_operator_session(self):
        assert Client().get("/ops/wireguard/").status_code == 404  # no gateway secret: not even a login page
        r = ops_client().get("/ops/wireguard/")
        assert r.status_code in (302, 403) and "WireGuard" not in r.content.decode()
        customer = make_user("wg-customer")
        assert ops_client(customer).get("/ops/wireguard/").status_code == 403

    def test_state_off(self, monkeypatch, admin, settings):
        settings.WIREGUARD_ENABLED = False
        html = self._get(monkeypatch, admin, None, "WireGuard is disabled on this server")
        assert "WireGuard is off on this server" in html
        assert "New installations have it on by default" in html
        assert "sudo ./lumenctl wireguard enable" in html
        assert "WIREGUARD_ENABLED=true" not in html
        assert 'id="add-peer"' not in html

    def test_state_unavailable(self, monkeypatch, admin, settings):
        settings.WIREGUARD_ENABLED = True
        html = self._get(monkeypatch, admin, _status(state="unavailable", unavailable_reason="the kernel has no WireGuard module", up=False, peers=[]))
        assert "WireGuard couldn't be set up on this server" in html
        assert "the kernel has no WireGuard module" in html
        assert "sudo ./lumenctl admin-tunnel" in html and "sudo ./lumenctl wireguard enable" in html
        assert "Tunnel is down" not in html
        assert 'id="add-peer"' not in html

    def test_state_enabled_with_stored_first_device_profile(self, monkeypatch, admin, settings):
        settings.WIREGUARD_ENABLED = True
        first = {"name": "operator-laptop", "public_key": FIRST_KEY, "profile_stored": True, "profile_path": "/etc/lumen/wireguard/first-device.conf"}
        html = self._get(monkeypatch, admin, _status(first_device=first))
        assert "The installer created a profile for “operator-laptop”" in html
        assert "/etc/lumen/wireguard/first-device.conf" in html
        assert "sudo ./lumenctl wireguard show-profile" in html and "sudo ./lumenctl wireguard forget-profile" in html
        assert html.count("first device (installer)") == 1
        assert "Tunnel is up" in html and "Devices dial" in html and "vpn.example.com:51820" in html
        assert "allow UDP 51820 there" in html
        assert "2 of 2" in html  # preshared keys
        assert 'id="add-peer"' in html

    def test_state_enabled_without_stored_profile(self, monkeypatch, admin, settings):
        settings.WIREGUARD_ENABLED = True
        html = self._get(monkeypatch, admin, _status())
        assert "The installer created a profile" not in html
        assert "first device (installer)" not in html
        assert "operator-laptop" in html and "alice-phone" in html
        assert "Never connected" in html and "Connected" in html
        # Public keys appear only shortened; nothing else of the keys is printed.
        assert FIRST_KEY not in html.replace(f'value="{FIRST_KEY}"', "")

    def test_empty_peer_list_has_a_friendly_action(self, monkeypatch, admin, settings):
        settings.WIREGUARD_ENABLED = True
        html = self._get(monkeypatch, admin, _status(peers=[]))
        assert "No operator devices yet" in html and 'href="#add-peer"' in html


class TestFilters:
    def test_filters(self):
        assert megabytes(100) == "100 MB" and megabytes(10240) == "10 GB" and megabytes(1536) == "1.5 GB"
        assert seconds_ago(12) == "12 s" and seconds_ago(600) == "10 min" and seconds_ago(7200) == "2 h" and seconds_ago(86400) == "1 day"
        assert count_where([{"a": True}, {"a": False}, {}], "a") == 1
        assert isodate("2026-10-17T00:22:33Z").year == 2026 and isodate("not a date") == "not a date" and isodate("") == ""


class TestPlanEditor:
    def test_marketing_bullets_are_one_per_line(self):
        from apps.billing.models import Plan

        plan = Plan.objects.exclude(features=[]).first()
        assert plan is not None
        admin = make_user("plan-admin", staff_role="owner", mfa=True)
        html = ops_client(admin).get(f"/ops/plans/{plan.pk}/").content.decode()
        assert "plan.features" not in html  # the template tag must not leak into the textarea
        body = html.split('name="features"', 1)[1].split("</textarea>", 1)[0]
        assert body.split(">", 1)[1].splitlines()[0].strip() == str(plan.features[0]).replace("&", "&amp;").replace("'", "&#x27;").replace('"', "&quot;")
