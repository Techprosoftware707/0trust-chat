"""Renderer tests for the client-app and push-gateway configuration.

    python3 -m unittest discover -s tests/deploy -v

Pure unit tests: render.py into a temporary directory and inspect the output.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "lib"))
import render  # noqa: E402

BASE = """LUMEN_PRIMARY_DOMAIN=example.com
ADMIN_EMAIL=admin@example.com
TLS_MODE=acme
"""
FP = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"


def rendered(extra: str = "") -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="lumen-render-"))
    conf = tmp / "lumen.conf"
    conf.write_text(BASE + extra)
    secrets = tmp / "secrets"
    secrets.mkdir()
    out = tmp / "out"
    rc = render.main(["--conf", str(conf), "--secrets", str(secrets), "--repo", str(REPO), "--out", str(out)])
    if rc != 0:
        raise AssertionError(f"render failed with {rc}")
    return out


def wellknown(caddyfile: str) -> dict:
    m = re.search(r"handle /\.well-known/matrix/client \{.*?respond `([^`]*)` 200", caddyfile, re.S)
    assert m, "client well-known not found"
    return json.loads(m.group(1))


def config_error(extra: str) -> str:
    tmp = Path(tempfile.mkdtemp(prefix="lumen-render-"))
    conf = tmp / "lumen.conf"
    conf.write_text(BASE + extra)
    try:
        render.load_config(conf)
    except render.ConfigError as exc:
        return str(exc)
    raise AssertionError("expected a configuration error")


class TestDiscovery(unittest.TestCase):
    def test_wellknown_has_homeserver_and_lumen_block(self):
        wk = wellknown((rendered() / "caddy" / "Caddyfile").read_text())
        self.assertEqual(wk["m.homeserver"]["base_url"], "https://matrix.example.com")
        app = wk["io.lumen.app"]
        self.assertEqual(app["version"], 1)
        self.assertEqual(app["portal_url"], "https://example.com")
        self.assertEqual(app["signup_url"], "https://example.com/accounts/signup/")
        self.assertEqual(app["sso_idp_id"], "oidc-lumen")
        self.assertEqual(app["call_widget_url"], "https://app.example.com/widget/call/")
        self.assertNotIn("push_gateway_url", app, "no push gateway advertised unless enabled")
        for k, v in app.items():
            if k.endswith("_url"):
                self.assertTrue(v.startswith("https://"), k)

    def test_closed_registration_hides_signup(self):
        wk = wellknown((rendered("REGISTRATION_MODE=closed\n") / "caddy" / "Caddyfile").read_text())
        self.assertNotIn("signup_url", wk["io.lumen.app"])

    def test_calls_off_hides_widget(self):
        wk = wellknown((rendered("CALLS_ENABLED=false\n") / "caddy" / "Caddyfile").read_text())
        self.assertNotIn("call_widget_url", wk["io.lumen.app"])

    def test_wellknown_contains_no_secret_like_values(self):
        text = (rendered("PUSH_ENABLED=true\nPUSH_FCM_PROJECT_ID=lumen-test-1\n") / "caddy" / "Caddyfile").read_text()
        wk = json.dumps(wellknown(text))
        self.assertNotRegex(wk, r"(?i)secret|private|token|password|BEGIN")


class TestSsoAndAppLinks(unittest.TestCase):
    def test_app_scheme_is_whitelisted_for_sso(self):
        hs = (rendered() / "synapse" / "homeserver.yaml").read_text()
        self.assertIn('"io.lumen.secure:/sso-callback"', hs)
        self.assertIn('"https://app.example.com/"', hs)

    def test_app_links_only_when_configured(self):
        caddy = (rendered() / "caddy" / "Caddyfile").read_text()
        self.assertNotIn("assetlinks.json", caddy)
        self.assertNotIn("apple-app-site-association", caddy)
        caddy = (rendered(f"APP_LINKS_ANDROID_SHA256={FP}\nAPP_LINKS_APPLE_TEAM_ID=ABCDE12345\n") / "caddy" / "Caddyfile").read_text()
        m = re.search(r"assetlinks\.json \{.*?respond `([^`]*)`", caddy, re.S)
        links = json.loads(m.group(1))
        self.assertEqual(links[0]["target"]["package_name"], "io.lumen.secure")
        self.assertEqual(links[0]["target"]["sha256_cert_fingerprints"], [FP])
        m = re.search(r"apple-app-site-association \{.*?respond `([^`]*)`", caddy, re.S)
        aasa = json.loads(m.group(1))
        self.assertEqual(aasa["applinks"]["details"][0]["appIDs"], ["ABCDE12345.io.lumen.secure"])

    def test_bad_identifiers_rejected(self):
        self.assertIn("APP_LINKS_ANDROID_SHA256", config_error("APP_LINKS_ANDROID_SHA256=AA:BB\n"))
        self.assertIn("APP_LINKS_APPLE_TEAM_ID", config_error("APP_LINKS_APPLE_TEAM_ID=abc\n"))
        self.assertIn("APP_URL_SCHEME", config_error("APP_URL_SCHEME=javascript\n"))


class TestPush(unittest.TestCase):
    def test_push_never_includes_content(self):
        hs = (rendered() / "synapse" / "homeserver.yaml").read_text()
        self.assertRegex(hs, r"push:\n  include_content: false")

    def test_push_disabled_route_is_404(self):
        caddy = (rendered() / "caddy" / "Caddyfile").read_text()
        self.assertIn("respond @push_off 404", caddy)
        self.assertNotIn("reverse_proxy 127.0.0.1:5000", caddy)

    def test_push_enabled_route_only_from_private_ranges(self):
        out = rendered("PUSH_ENABLED=true\nPUSH_FCM_PROJECT_ID=lumen-test-1\nPUSH_APNS_TEAM_ID=ABCDE12345\nPUSH_APNS_KEY_ID=KEY1234567\n")
        caddy = (out / "caddy" / "Caddyfile").read_text()
        block = re.search(r"@push_gw \{(.*?)\}", caddy, re.S).group(1)
        self.assertIn("path /_matrix/push/v1/notify", block)
        self.assertIn("remote_ip private_ranges", block)
        self.assertIn("respond @push_other 404", caddy)
        wk = wellknown(caddy)
        self.assertEqual(wk["io.lumen.app"]["push_gateway_url"], "https://matrix.example.com/_matrix/push/v1/notify")
        syg = (out / "sygnal" / "sygnal.yaml").read_text()
        self.assertIn('io.lumen.secure.android:\n    type: "gcm"', syg)
        self.assertIn('api_version: "v1"', syg)
        self.assertIn('io.lumen.secure.ios:\n    type: "apns"', syg)
        self.assertIn('platform: "production"', syg)
        self.assertIn('topic: "io.lumen.secure"', syg)
        self.assertIn('- "127.0.0.1"', syg)
        self.assertIn('level: "WARNING"', syg, "push keys and room IDs are not logged at INFO")
        self.assertNotRegex(syg, r"BEGIN|private_key\"?:")

    def test_push_needs_a_platform(self):
        self.assertIn("PUSH_ENABLED needs", config_error("PUSH_ENABLED=true\n"))
        self.assertIn("needed together", config_error("PUSH_ENABLED=true\nPUSH_APNS_TEAM_ID=ABCDE12345\n"))


if __name__ == "__main__":
    unittest.main()
