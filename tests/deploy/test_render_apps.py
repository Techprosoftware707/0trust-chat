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


def rendered(extra: str = "", secret_files: dict[str, str] | None = None) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="lumen-render-"))
    conf = tmp / "lumen.conf"
    conf.write_text(BASE + extra)
    secrets = tmp / "secrets"
    secrets.mkdir()
    for name, content in (secret_files or {}).items():
        (secrets / name).write_text(content)
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
        self.assertEqual(app["account_delete_url"], "https://example.com/portal/privacy/delete/")
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

    def test_call_widget_is_served_where_wellknown_points(self):
        caddy = (rendered() / "caddy" / "Caddyfile").read_text()
        block = re.search(r"handle /widget/call/\* \{(.*?)\n\t\}", caddy, re.S).group(1)
        self.assertIn("try_files {path} /widget/call/index.html", block)
        self.assertIn('@widget_html path /widget/call/ /widget/call/index.html', block)
        self.assertIn('header @widget_html Cache-Control "no-cache"', block)

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

    PUSH_CONF = "PUSH_ENABLED=true\nPUSH_FCM_PROJECT_ID=lumen-test-1\nPUSH_APNS_TEAM_ID=ABCDE12345\nPUSH_APNS_KEY_ID=KEY1234567\n"
    # Placeholders: the renderer only checks that the credential files exist and aren't empty.
    CREDS = {"push_fcm_service_account": '{"type": "service_account"}', "push_apns_key": "placeholder"}

    def test_push_enabled_route_only_from_private_ranges(self):
        out = rendered(self.PUSH_CONF, self.CREDS)
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

    def test_platform_without_its_credential_is_left_out(self):
        # Sygnal refuses to start when a configured platform's credential file is empty
        # (seen on a fresh install), and apps must not be told about a gateway that can't deliver.
        out = rendered(self.PUSH_CONF)
        # No credential at all: Sygnal won't start without an app, so no config is written
        # (the installer then doesn't start the gateway) and the route answers 404.
        self.assertFalse((out / "sygnal" / "sygnal.yaml").exists())
        caddy = (out / "caddy" / "Caddyfile").read_text()
        self.assertNotIn("push_gateway_url", json.dumps(wellknown(caddy)))
        self.assertIn("respond @push_off 404", caddy)
        self.assertNotIn("reverse_proxy 127.0.0.1:5000", caddy)

        out = rendered(self.PUSH_CONF, {"push_apns_key": "placeholder", "push_fcm_service_account": ""})
        syg = (out / "sygnal" / "sygnal.yaml").read_text()
        self.assertNotIn('type: "gcm"', syg)
        self.assertIn('io.lumen.secure.ios:\n    type: "apns"', syg)
        self.assertIn("push_gateway_url", wellknown((out / "caddy" / "Caddyfile").read_text())["io.lumen.app"])

    def test_push_needs_a_platform(self):
        self.assertIn("PUSH_ENABLED needs", config_error("PUSH_ENABLED=true\n"))
        self.assertIn("needed together", config_error("PUSH_ENABLED=true\nPUSH_APNS_TEAM_ID=ABCDE12345\n"))



class TestNoDomainTestSetup(unittest.TestCase):
    TEST = ("LUMEN_TEST_SETUP=true\nLUMEN_PRIMARY_DOMAIN=172-17-0-4.sslip.io\nADMIN_EMAIL=admin@172-17-0-4.sslip.io\n"
            "TLS_MODE=internal\nFEDERATION_MODE=closed\nCALLS_PUBLIC_IP=172.17.0.4\nCALLS_ALLOW_PRIVATE_NODE_IP=true\n")

    def render_test(self, extra: str = "") -> str:
        tmp = Path(tempfile.mkdtemp(prefix="lumen-render-"))
        (tmp / "lumen.conf").write_text(self.TEST + extra)  # replaces BASE: its own domain
        (tmp / "secrets").mkdir()
        rc = render.main(["--conf", str(tmp / "lumen.conf"), "--secrets", str(tmp / "secrets"), "--repo", str(REPO), "--out", str(tmp / "out")])
        self.assertEqual(rc, 0)
        return (tmp / "out" / "caddy" / "Caddyfile").read_text()

    def test_test_ca_offered_over_http_only_the_root_certificate(self):
        caddy = self.render_test()
        block = re.search(r"http://172-17-0-4\.sslip\.io \{(.*?)\n\}", caddy, re.S).group(1)
        self.assertIn("handle /lumen-test-ca.crt {", block)
        self.assertIn("root * /data/caddy/pki/authorities/local", block)
        self.assertIn("rewrite * /root.crt", block, "the rewrite pins the one public file; keys are never served")
        self.assertNotIn(".key", block)
        self.assertIn("redir https://{host}{uri} 308", block, "everything else still goes to https")
        self.assertIn("http://app.172-17-0-4.sslip.io, http://matrix.172-17-0-4.sslip.io", caddy)
        self.assertIn("tls internal", caddy)

    def test_no_ca_download_with_public_certificates_or_outside_test_setups(self):
        self.assertNotIn("lumen-test-ca.crt", self.render_test("TLS_MODE=acme\n"))
        self.assertNotIn("lumen-test-ca.crt", (rendered("TLS_MODE=internal\n") / "caddy" / "Caddyfile").read_text())


class TestNexusWorkspace(unittest.TestCase):
    """Nexus (test/unified-business-workspace): the chat app's workspace API block, the
    environment banner setting and the temporary test brand."""

    def test_chat_config_has_workspace_and_environment(self):
        out = rendered()
        cfg = json.loads((out / "chat" / "config.json").read_text())
        self.assertEqual(cfg["workspace"], {"api_url": "https://example.com/api/v1", "client_id": "nexus-web"})
        self.assertEqual(cfg["environment"], "test")
        self.assertEqual(cfg["brand"]["name"], "Nexus Office AI")
        env = (out / "app.env").read_text()
        self.assertIn("NEXUS_ENVIRONMENT=test\n", env)

    def test_production_environment_and_validation(self):
        out = rendered("NEXUS_ENVIRONMENT=production\nBRAND_NAME=Acme Chat\n")
        cfg = json.loads((out / "chat" / "config.json").read_text())
        self.assertEqual(cfg["environment"], "production")
        self.assertEqual(cfg["brand"]["name"], "Acme Chat")
        self.assertIn("NEXUS_ENVIRONMENT must be", config_error("NEXUS_ENVIRONMENT=staging\n"))


class TestNexusIntegrations(unittest.TestCase):
    """Nexus integrations: client IDs reach app.env, secrets never do, mock mode is refused in production."""

    def test_client_ids_in_app_env_and_mock_off_by_default(self):
        env = (rendered("NEXUS_GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com\nNEXUS_SLACK_CLIENT_ID=111.222\n") / "app.env").read_text()
        self.assertIn("NEXUS_GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com\n", env)
        self.assertIn("NEXUS_SLACK_CLIENT_ID=111.222\n", env)
        self.assertIn("NEXUS_INTEGRATIONS_MOCK=false\n", env)
        self.assertNotIn("SECRET", "".join(line for line in env.splitlines() if line.startswith("NEXUS_")))

    def test_mock_refused_in_production_and_ids_validated(self):
        self.assertIn("NEXUS_INTEGRATIONS_MOCK", config_error("NEXUS_ENVIRONMENT=production\nNEXUS_INTEGRATIONS_MOCK=true\n"))
        self.assertIn("NEXUS_GHL_CLIENT_ID", config_error("NEXUS_GHL_CLIENT_ID=bad id;rm\n"))
        rendered("NEXUS_ENVIRONMENT=test\nNEXUS_INTEGRATIONS_MOCK=true\n")


class TestNexusAi(unittest.TestCase):
    """Nexus AI assistant and Claude connector: settings reach app.env, the key never does,
    the connector is closed at the edge unless enabled, invalid settings are refused."""

    def test_defaults_connector_off_at_the_edge(self):
        out = rendered()
        env = (out / "app.env").read_text()
        self.assertIn("NEXUS_MCP_ENABLED=false\n", env)
        self.assertIn("AI_PROVIDER=\n", env)
        self.assertIn("AI_MODEL=\n", env)
        caddy = (out / "caddy" / "Caddyfile").read_text()
        self.assertIn("@mcp_off path /mcp /mcp/* /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/*", caddy)
        self.assertIn("respond @mcp_off 404", caddy)

    def test_enabled_connector_and_anthropic_provider(self):
        out = rendered("NEXUS_MCP_ENABLED=true\nAI_PROVIDER=anthropic\nAI_MODEL=example-model-id\n"
                       "NEXUS_MCP_EXTRA_REDIRECT_URIS=https://client.example.com/oauth/callback\n")
        env = (out / "app.env").read_text()
        self.assertIn("NEXUS_MCP_ENABLED=true\n", env)
        self.assertIn("AI_PROVIDER=anthropic\nAI_MODEL=example-model-id\n", env)
        self.assertIn("NEXUS_MCP_EXTRA_REDIRECT_URIS=https://client.example.com/oauth/callback\n", env)
        self.assertNotIn("AI_API_KEY", env)
        caddy = (out / "caddy" / "Caddyfile").read_text()
        self.assertNotIn("@mcp_off", caddy)
        compose = (REPO / "docker-compose.yml").read_text()
        self.assertIn("AI_API_KEY_FILE: /run/secrets/ai_api_key", compose)

    def test_invalid_ai_settings_are_refused(self):
        self.assertIn("AI_PROVIDER must be", config_error("AI_PROVIDER=openai\n"))
        self.assertIn("needs AI_MODEL", config_error("AI_PROVIDER=anthropic\n"))
        self.assertIn("AI_PROVIDER=dev", config_error("NEXUS_ENVIRONMENT=production\nAI_PROVIDER=dev\n"))
        self.assertIn("AI_MODEL contains", config_error("AI_MODEL=bad model;rm\n"))
        self.assertIn("NEXUS_MCP_EXTRA_REDIRECT_URIS", config_error("NEXUS_MCP_EXTRA_REDIRECT_URIS=http://insecure.example.com/cb\n"))
        self.assertIn("NEXUS_MCP_EXTRA_REDIRECT_URIS", config_error("NEXUS_MCP_EXTRA_REDIRECT_URIS=https://x.example.com/cb?a=1\n"))
        self.assertIn("NEXUS_MCP_ENABLED must be", config_error("NEXUS_MCP_ENABLED=maybe\n"))
        rendered("NEXUS_ENVIRONMENT=production\nAI_PROVIDER=none\n")


if __name__ == "__main__":
    unittest.main()
