"""Unit tests for the host agent's WireGuard code (deploy/host-agent/lumen_agent.py).

    python3 -m unittest discover -s tests/deploy -v

Pure unit tests: every path points into a temporary directory, `wg`/`ip` are replaced by
fakes, and no network interface is ever created, changed or inspected (a test that tried to
run anything else would fail).
"""
from __future__ import annotations

import atexit
import base64
import hashlib
import io
import ipaddress
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_SANDBOX = Path(tempfile.mkdtemp(prefix="lumen-agent-import-"))
atexit.register(shutil.rmtree, _SANDBOX, True)
# Defaults the module reads at import time: never the real /etc paths.
os.environ.update({"LUMEN_CONF": str(_SANDBOX / "lumen.conf"), "LUMEN_STATE": str(_SANDBOX / "state.json"),
                   "LUMEN_WG_DIR": str(_SANDBOX / "wireguard"), "LUMEN_WG_CONF": str(_SANDBOX / "wg0.conf"),
                   "LUMEN_AGENT_DIR": str(_SANDBOX / "run")})
sys.path.insert(0, str(REPO / "deploy" / "host-agent"))
import lumen_agent as agent  # noqa: E402

sys.path.insert(0, str(REPO / "deploy" / "lib"))
import render  # noqa: E402

BASE_CONF = """LUMEN_PRIMARY_DOMAIN=example.com
ADMIN_EMAIL=admin@example.com
OPERATOR_USERNAME=alice
"""


def b64key(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


class FakeHost:
    """Stands in for `wg` and `ip`. Anything else (wg-quick, syncconf, ...) is a test failure."""

    def __init__(self):
        self.routes: list[dict] = [{"dst": "default", "gateway": "192.0.2.1", "dev": "eth0"},
                                   {"dst": "192.0.2.0/24", "dev": "eth0"}]
        self.addrs: list[dict] = [{"ifname": "lo", "addr_info": [{"family": "inet", "local": "127.0.0.1", "prefixlen": 8}]},
                                  {"ifname": "eth0", "addr_info": [{"family": "inet", "local": "192.0.2.2", "prefixlen": 24}]}]
        self.calls: list[list[str]] = []

    def run(self, argv, timeout=30, input_text=None):
        self.calls.append(list(argv))
        out = ""
        if argv[:2] == ["wg", "genkey"] or argv[:2] == ["wg", "genpsk"]:
            out = b64key(os.urandom(32)) + "\n"
        elif argv[:2] == ["wg", "pubkey"]:
            out = b64key(b"pub:" + (input_text or "").strip().encode()) + "\n"
        elif argv[:5] == ["ip", "-j", "-4", "route", "show"]:
            out = json.dumps(self.routes)
        elif argv[:4] == ["ip", "-j", "-4", "addr"]:
            out = json.dumps(self.addrs)
        elif argv[:3] == ["ip", "-j", "addr"]:
            out = json.dumps(self.addrs)
        else:
            raise AssertionError(f"unexpected command in a unit test: {argv}")
        return subprocess.CompletedProcess(argv, 0, out, "")


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-agent-"))
        self.host = FakeHost()
        self.iface = False
        self._saved = {k: getattr(agent, k) for k in ("CONF_PATH", "STATE_PATH", "WG_DIR", "WG_CONF", "WG_IF", "run", "interface_exists")}
        agent.CONF_PATH = self.tmp / "lumen.conf"
        agent.STATE_PATH = self.tmp / "state.json"
        agent.WG_DIR = self.tmp / "etc-lumen" / "wireguard"
        agent.WG_CONF = self.tmp / "etc-wireguard" / "wg0.conf"
        agent.WG_IF = "lumen-unit-test-none"
        agent.run = self.host.run
        agent.interface_exists = lambda: self.iface
        self.write_conf("")

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(agent, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_conf(self, extra: str):
        agent.CONF_PATH.write_text(BASE_CONF + extra)

    def snapshot(self) -> dict[str, bytes]:
        files = {}
        for root in (agent.WG_DIR, agent.WG_CONF.parent):
            if root.exists():
                for f in sorted(root.rglob("*")):
                    if f.is_file() and f.name != ".lock":
                        files[str(f)] = f.read_bytes()
        return files


class SubnetChoice(AgentTestCase):
    def nets(self, *items):
        return [(ipaddress.ip_network(n), dev) for n, dev in items]

    def test_default_kept_when_free(self):
        self.assertEqual(agent.choose_subnet("10.77.0.0/24", self.nets(("192.0.2.0/24", "eth0"))), ("10.77.0.0/24", ""))

    def test_first_free_candidate_on_overlap(self):
        subnet, note = agent.choose_subnet("10.77.0.0/24", self.nets(("10.77.0.0/16", "eth1")))
        self.assertEqual(subnet, "10.78.0.0/24")
        self.assertIn("10.77.0.0/16 on eth1", note)

    def test_skips_every_overlapping_candidate(self):
        used = self.nets(("10.77.0.0/24", "wg9"), ("10.78.0.5/32", "tun0"), ("10.79.0.0/20", "docker1"))
        self.assertEqual(agent.choose_subnet("10.77.0.0/24", used)[0], "10.177.0.0/24")

    def test_explicit_subnet_moved_only_when_it_overlaps(self):
        self.assertEqual(agent.choose_subnet("10.66.0.0/24", self.nets(("10.77.0.0/24", "x")))[0], "10.66.0.0/24")
        self.assertEqual(agent.choose_subnet("10.66.0.0/24", self.nets(("10.66.0.0/24", "x")))[0], "10.77.0.0/24")

    def test_no_free_candidate_is_an_error(self):
        with self.assertRaises(agent.OpError):
            agent.choose_subnet("10.77.0.0/24", self.nets(("10.0.0.0/8", "vpc"), ("192.168.0.0/16", "lan")))

    def test_host_networks_reads_routes_and_addresses(self):
        self.host.routes += [{"type": "broadcast", "dst": "10.1.255.255", "dev": "eth1"},
                             {"dst": "10.77.0.0/24", "dev": "tailscale0"}]
        self.host.addrs.append({"ifname": "br0", "addr_info": [{"family": "inet", "local": "172.20.0.1", "prefixlen": 16}]})
        nets = {str(n): dev for n, dev in agent.host_networks()}
        self.assertNotIn("0.0.0.0/0", nets)  # the default route overlaps everything: ignored
        self.assertNotIn("10.1.255.255/32", nets)  # broadcast entries: ignored
        self.assertEqual(nets["10.77.0.0/24"], "tailscale0")
        self.assertEqual(nets["172.20.0.0/16"], "br0")

    def test_plan_picks_a_free_subnet_on_a_new_host(self):
        self.host.routes.append({"dst": "10.77.0.0/24", "dev": "wg-other"})
        plan = agent.wg_plan("203.0.113.9", "192.0.2.2")
        self.assertEqual(plan["SUBNET"], "10.78.0.0/24")
        self.assertIn("wg-other", plan["SUBNET_NOTE"])
        self.assertEqual(plan["FOREIGN"], "")

    def test_plan_never_moves_lumens_live_subnet(self):
        # A re-run with a lumen.conf that lost WG_SUBNET (install.sh --config copies the file again):
        # the subnet of Lumen's own wg0.conf wins, although its own route overlaps it.
        self.write_conf("WG_SUBNET=10.77.0.0/24\n")
        agent.WG_CONF.parent.mkdir(parents=True)
        agent.WG_CONF.write_text(f"{agent.WG_MARKER}. Manual edits are overwritten.\n[Interface]\nAddress = 10.78.0.1/24\n")
        self.host.routes.append({"dst": "10.78.0.0/24", "dev": "wg0"})
        plan = agent.wg_plan("", "192.0.2.2")
        self.assertEqual(plan["SUBNET"], "10.78.0.0/24")

    def test_plan_keeps_the_subnet_of_restored_peers(self):
        self.write_conf("WG_SUBNET=10.79.0.0/24\n")
        agent.WG_DIR.mkdir(parents=True)
        (agent.WG_DIR / "peers.json").write_text(json.dumps([{"id": "x", "name": "a", "public_key": "k", "address": "10.79.0.2"}]))
        self.host.routes.append({"dst": "10.79.0.0/16", "dev": "eth9"})
        self.assertEqual(agent.wg_plan("", "")["SUBNET"], "10.79.0.0/24")


class EndpointChoice(AgentTestCase):
    def choose(self, explicit="", names=("chat.example.org",), public="", lan="", local=(), dns=None):
        dns = dns or {}
        return agent.choose_endpoint(explicit, list(names), public, lan, set(local), resolver=lambda n: set(dns.get(n, ())))

    def test_explicit_wins(self):
        self.assertEqual(self.choose(explicit="vpn.example.org", public="203.0.113.9")[0], "vpn.example.org")

    def test_name_resolving_to_public_ip_behind_nat(self):
        # Cloud NAT: the public address is on no interface; the name points at it.
        ep, note = self.choose(public="203.0.113.9", local=("10.0.0.5",), dns={"chat.example.org": ["203.0.113.9"]})
        self.assertEqual(ep, "chat.example.org")
        self.assertIn("resolves to this server", note)

    def test_name_resolving_to_an_interface_address(self):
        self.assertEqual(self.choose(local=("172.17.0.2",), dns={"chat.example.org": ["172.17.0.2"]})[0], "chat.example.org")

    def test_name_pointing_elsewhere_falls_back_to_public_ip(self):
        self.assertEqual(self.choose(public="203.0.113.9", dns={"chat.example.org": ["198.51.100.1"]})[0], "203.0.113.9")

    def test_loopback_hosts_entry_is_not_an_endpoint(self):
        # /etc/hosts maps the name to 127.0.0.1 on the server itself: useless for a device.
        ep = self.choose(public="203.0.113.9", local=("127.0.0.1",), dns={"chat.example.org": ["127.0.0.1"]})[0]
        self.assertEqual(ep, "203.0.113.9")

    def test_lan_address_last(self):
        ep, note = self.choose(lan="192.168.1.20", dns={})
        self.assertEqual(ep, "192.168.1.20")
        self.assertIn("WG_ENDPOINT", note)

    def test_nothing_known(self):
        self.assertEqual(self.choose(), ("", ""))

    def test_plan_keeps_the_first_endpoint(self):
        # install.sh --config copies the operator's file again, without the WG_ENDPOINT the first
        # run wrote; the endpoint already in device profiles must stay, not be detected anew.
        self.write_conf("WG_ENDPOINT=198.51.100.7\n")
        agent.ensure_wireguard_server_key()
        self.write_conf("")
        plan = agent.wg_plan("203.0.113.99", "10.0.0.5")
        self.assertEqual(plan["ENDPOINT"], "198.51.100.7")
        self.assertIn("kept", plan["ENDPOINT_NOTE"])
        self.write_conf("WG_ENDPOINT=vpn.example.org\n")  # an explicit setting still wins
        self.assertEqual(agent.wg_plan("203.0.113.99", "")["ENDPOINT"], "vpn.example.org")

    def test_plan_uses_the_primary_domain(self):
        self.write_conf("LUMEN_PRIMARY_DOMAIN=mylumen.duckdns.org\n")
        saved = agent.resolve
        agent.resolve = lambda n: {"203.0.113.9"} if n == "mylumen.duckdns.org" else set()
        try:
            self.assertEqual(agent.wg_plan("203.0.113.9", "10.0.0.5")["ENDPOINT"], "mylumen.duckdns.org")
        finally:
            agent.resolve = saved


class FirstDevice(AgentTestCase):
    def setUp(self):
        super().setUp()
        agent.ensure_wireguard_server_key()
        self.profile = agent.WG_DIR / "first-device.conf"

    def test_created_once_with_root_only_profile(self):
        status, info = agent.ensure_first_device("alice-device", self.profile)
        self.assertEqual(status, "created")
        self.assertEqual(info["name"], "alice-device")
        self.assertEqual(stat.S_IMODE(self.profile.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(agent.WG_DIR.stat().st_mode), 0o700)
        text = self.profile.read_text()
        for needle in ("[Interface]", "PrivateKey = ", "PresharedKey = ", "Endpoint = example.com:51820",
                       "10.77.0.1 ops.example.com", "PRIVATE KEY", "forget-profile", "show-profile"):
            self.assertIn(needle, text)
        peers = agent.wg_peers()
        self.assertEqual([p["name"] for p in peers], ["alice-device"])
        self.assertEqual(peers[0]["created_by"], "installer")
        psk = (agent.WG_DIR / "psk" / f"{peers[0]['id']}.psk").read_text().strip()
        self.assertIn(f"PresharedKey = {psk}", text)  # a per-peer preshared key, the same on both ends
        self.assertIn(peers[0]["public_key"], agent.WG_CONF.read_text())
        client_priv = next(line.split(" = ", 1)[1] for line in text.splitlines() if line.startswith("PrivateKey"))
        self.assertNotIn(client_priv, agent.WG_CONF.read_text())  # the server never keeps the device key
        self.assertNotIn(client_priv, json.dumps(info))

    def test_reruns_add_nothing_and_rotate_nothing(self):
        agent.ensure_first_device("alice-device", self.profile)
        before = self.snapshot()
        for _ in range(3):
            agent.ensure_wireguard_server_key()  # what every install/update run does first
            status, _ = agent.ensure_first_device("alice-device", self.profile)
            self.assertEqual(status, "exists")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(agent.wg_peers()), 1)

    def test_not_recreated_after_forget_or_revoke(self):
        agent.ensure_first_device("alice-device", self.profile)
        self.profile.unlink()  # lumenctl wireguard forget-profile
        self.assertEqual(agent.ensure_first_device("alice-device", self.profile)[0], "exists")
        self.assertFalse(self.profile.exists())
        agent.op_wg_remove_peer({"public_key": agent.wg_peers()[0]["public_key"]}, "alice")
        self.assertEqual(agent.ensure_first_device("alice-device", self.profile)[0], "exists")
        self.assertEqual(agent.wg_peers(), [])

    def test_skipped_when_devices_exist_already(self):
        agent.op_wg_add_peer({"name": "laptop"}, "alice")
        status, info = agent.ensure_first_device("alice-device", self.profile)
        self.assertEqual(status, "skipped")
        self.assertFalse(self.profile.exists())
        self.assertEqual([p["name"] for p in agent.wg_peers()], ["laptop"])

    def test_profile_only_inside_the_wireguard_directory(self):
        with self.assertRaises(agent.OpError):
            agent.ensure_first_device("alice-device", self.tmp / "elsewhere.conf")
        self.assertEqual(agent.wg_peers(), [])

    def test_command_line_prints_no_key_material(self):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = agent.cli(["wg-first-peer", "--name", "alice-device", "--out", str(self.profile)])
        self.assertEqual(rc, 0)
        printed = out.getvalue()
        self.assertTrue(printed.startswith("created alice-device 10.77.0.2 "))
        for line in self.profile.read_text().splitlines():
            if line.startswith(("PrivateKey", "PresharedKey")):
                self.assertNotIn(line.split(" = ", 1)[1], printed)
        self.assertNotIn((agent.WG_DIR / "server.key").read_text().strip(), printed)

    def test_status_reports_the_stored_profile(self):
        agent.ensure_first_device("alice-device", self.profile)
        agent.STATE_PATH.write_text(json.dumps({"wireguard": "enabled"}))
        st = agent.op_wg_status({})
        self.assertEqual(st["state"], "enabled")
        self.assertEqual(st["first_device"]["name"], "alice-device")
        self.assertTrue(st["first_device"]["profile_stored"])
        self.assertNotIn("PrivateKey", json.dumps(st))

    def test_add_peer_response_is_redacted_in_the_log(self):
        with self.assertLogs("lumen-agent", level="INFO") as logs:
            resp = agent.handle_request(json.dumps({"op": "wg.add_peer", "args": {"name": "phone"}, "actor": "alice"}).encode(), 0)
        self.assertTrue(resp["ok"])
        priv = next(line.split(" = ", 1)[1] for line in resp["result"]["config"].splitlines() if line.startswith("PrivateKey"))
        self.assertNotIn(priv, "\n".join(logs.output))
        self.assertIn("[secret]", "\n".join(logs.output))


class ForeignWireGuard(AgentTestCase):
    FOREIGN = "[Interface]\nAddress = 10.77.0.1/24\nListenPort = 51820\nPrivateKey = someone-elses-key\n"

    def setUp(self):
        super().setUp()
        agent.WG_CONF.parent.mkdir(parents=True)
        agent.WG_CONF.write_text(self.FOREIGN)

    def test_detected(self):
        self.assertIn("not written by Lumen", agent.foreign_reason())
        self.assertIn("not written by Lumen", agent.wg_plan("", "")["FOREIGN"])

    def test_console_subnet_avoids_the_foreign_vpn(self):
        # The foreign wg0 is up on 10.77.0.0/24: Lumen's (unused) subnet, which the console's
        # allow-list admits, must not be that network.
        self.host.routes.append({"dst": "10.77.0.0/24", "dev": "wg0"})
        plan = agent.wg_plan("", "")
        self.assertTrue(plan["FOREIGN"])
        self.assertEqual(plan["SUBNET"], "10.78.0.0/24")

    def test_never_overwritten(self):
        for attempt in (lambda: agent.wg_write_config([]), agent.ensure_wireguard_server_key,
                        lambda: agent.ensure_first_device("alice-device", agent.WG_DIR / "first-device.conf"),
                        lambda: agent.op_wg_add_peer({"name": "laptop"}, "alice")):
            with self.assertRaises(agent.OpError):
                attempt()
            self.assertEqual(agent.WG_CONF.read_text(), self.FOREIGN)
        self.assertEqual(agent.wg_peers(), [])
        self.assertFalse((agent.WG_DIR / "first-device.conf").exists())

    def test_console_gets_a_clear_error(self):
        resp = agent.handle_request(json.dumps({"op": "wg.add_peer", "args": {"name": "laptop"}, "actor": "alice"}).encode(), 10001)
        self.assertFalse(resp["ok"])
        self.assertIn("refusing to overwrite", resp["error"])
        self.assertEqual(agent.WG_CONF.read_text(), self.FOREIGN)

    def test_lumens_own_file_is_fine(self):
        agent.WG_CONF.write_text(f"{agent.WG_MARKER}. Manual edits are overwritten.\n[Interface]\n")
        self.assertEqual(agent.foreign_reason(), "")
        agent.ensure_wireguard_server_key()
        self.assertTrue(agent.WG_CONF.read_text().startswith(agent.WG_MARKER))

    def test_interface_without_lumen_config(self):
        agent.WG_CONF.unlink()
        self.iface = True
        self.assertIn("did not create", agent.foreign_reason())


class Defaults(AgentTestCase):
    def test_on_when_the_key_is_absent(self):
        self.assertTrue(agent.wg_enabled())

    def test_explicit_off_is_respected(self):
        self.write_conf("WIREGUARD_ENABLED=false\n")
        self.assertFalse(agent.wg_enabled())
        with self.assertRaises(agent.OpError):
            agent.op_wg_add_peer({"name": "laptop"}, "alice")

    def render(self, extra: str) -> Path:
        conf = self.tmp / "render.conf"
        conf.write_text("LUMEN_PRIMARY_DOMAIN=example.com\nADMIN_EMAIL=admin@example.com\nTLS_MODE=acme\n" + extra)
        (self.tmp / "secrets").mkdir(exist_ok=True)
        out = self.tmp / "out"
        shutil.rmtree(out, ignore_errors=True)
        rc = render.main(["--conf", str(conf), "--secrets", str(self.tmp / "secrets"), "--repo", str(REPO), "--out", str(out)])
        self.assertEqual(rc, 0)
        return out

    def test_console_allow_list_includes_the_subnet_by_default(self):
        self.assertIn("10.77.0.0/24", (self.render("") / "caddy" / "Caddyfile").read_text())
        self.assertIn("10.78.0.0/24", (self.render("WG_SUBNET=10.78.0.0/24\n") / "caddy" / "Caddyfile").read_text())
        self.assertNotIn("10.77.0.0/24", (self.render("WIREGUARD_ENABLED=false\n") / "caddy" / "Caddyfile").read_text())

    def test_endpoint_validation(self):
        for ok in ("chat.example.org", "203.0.113.9", "2001:db8::1"):
            cfg = render.load_config(self._conf(f"WG_ENDPOINT={ok}\n"))
            self.assertEqual(cfg["WG_ENDPOINT"], ok)
        with self.assertRaises(render.ConfigError):
            render.load_config(self._conf("WG_ENDPOINT=chat.example.org:51820\n"))

    def _conf(self, extra: str) -> Path:
        conf = self.tmp / "v.conf"
        conf.write_text("LUMEN_PRIMARY_DOMAIN=example.com\nADMIN_EMAIL=admin@example.com\n" + extra)
        return conf


if __name__ == "__main__":
    unittest.main()
