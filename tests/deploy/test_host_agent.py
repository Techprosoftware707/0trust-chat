"""Unit tests for the host agent's WireGuard code (deploy/host-agent/lumen_agent.py).

    python3 -m unittest discover -s tests/deploy -v

Pure unit tests: every path points into a temporary directory, `wg`/`ip` are replaced by
fakes, and no network interface is ever created, changed or inspected (a test that tried to
run anything else would fail).
"""
from __future__ import annotations

import atexit
import base64
import contextlib
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
        self._saved = {k: getattr(agent, k) for k in ("CONF_PATH", "STATE_PATH", "WG_DIR", "WG_CONF", "WG_IF", "run", "interface_exists",
                                                      "tunnel_dns_ready", "tunnel_dns_check", "dns_query", "HOST_RESOLV", "RESOLVED_UPSTREAM")}
        agent.CONF_PATH = self.tmp / "lumen.conf"
        agent.STATE_PATH = self.tmp / "state.json"
        agent.WG_DIR = self.tmp / "etc-lumen" / "wireguard"
        agent.WG_CONF = self.tmp / "etc-wireguard" / "wg0.conf"
        agent.WG_IF = "lumen-unit-test-none"
        agent.run = self.host.run
        agent.interface_exists = lambda: self.iface
        # The tunnel DNS probe sends a real query: replaced (answering unless a test says otherwise).
        self.dns_answers = True
        agent.tunnel_dns_ready = lambda c=None, timeout=1.0: self.dns_answers
        agent.tunnel_dns_check = lambda c=None, timeout=1.0: {"console": self.dns_answers, "forwarding": self.dns_answers, "detail": "fake"}

        def no_network(*a, **kw):
            raise AssertionError("a unit test tried to send a DNS query")
        agent.dns_query = no_network
        agent.HOST_RESOLV = self.tmp / "etc-resolv.conf"
        agent.RESOLVED_UPSTREAM = self.tmp / "run-systemd-resolve-resolv.conf"
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


def profile_sections(text: str) -> dict[str, dict[str, list[str]]]:
    """[Interface]/[Peer] key -> values of a WireGuard profile (comments ignored)."""
    out: dict[str, dict[str, list[str]]] = {}
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line.strip("[]")
            out.setdefault(section, {})
            continue
        k, _, v = line.partition("=")
        out.setdefault(section, {}).setdefault(k.strip(), []).append(v.strip())
    return out


class DeviceProfiles(AgentTestCase):
    """What a device profile tells the device: DNS through the tunnel, split tunnel unchanged."""

    def setUp(self):
        super().setUp()
        agent.ensure_wireguard_server_key()

    def test_profile_sets_the_tunnel_dns_and_keeps_the_split_tunnel(self):
        result = agent.op_wg_add_peer({"name": "alice-phone"}, "alice")
        s = profile_sections(result["config"])
        self.assertEqual(s["Interface"]["DNS"], ["10.77.0.1"])  # in [Interface], once
        self.assertEqual(s["Interface"]["Address"], ["10.77.0.2/32"])
        self.assertNotIn("DNS", s["Peer"])
        # Only the server's tunnel address goes into the tunnel: not the endpoint, not everything.
        self.assertEqual(s["Peer"]["AllowedIPs"], ["10.77.0.1/32"])
        self.assertEqual(s["Peer"]["Endpoint"], ["example.com:51820"])
        self.assertEqual(result["dns"], "10.77.0.1")
        self.assertEqual(result["allowed_ips"], "10.77.0.1/32")
        text = result["config"]
        self.assertIn("no hosts-file edit needed", text)
        self.assertIn("sends ALL its", text)  # says plainly that every lookup goes to the server
        self.assertIn('Delete the DNS line and add "10.77.0.1 ops.example.com" to the hosts file', text)
        self.assertIn("Console: https://ops.example.com:8443/", text)
        self.assertNotIn("Add to /etc/hosts", text)
        self.assertEqual(agent.wg_peers()[0]["profile_dns"], "10.77.0.1")
        self.assertEqual(agent.devices_without_dns(agent.wg_peers()), [])

    def test_dns_follows_the_subnet_and_the_console_name(self):
        self.write_conf("WG_SUBNET=10.78.0.0/24\nLUMEN_OPS_DOMAIN=console.example.net\nLUMEN_OPS_PORT=9443\n")
        agent.ensure_wireguard_server_key()
        text = agent.op_wg_add_peer({"name": "laptop"}, "alice")["config"]
        s = profile_sections(text)
        self.assertEqual(s["Interface"]["DNS"], ["10.78.0.1"])
        self.assertEqual(s["Peer"]["AllowedIPs"], ["10.78.0.1/32"])
        self.assertIn("answers console.example.net with 10.78.0.1", text)
        self.assertIn("https://console.example.net:9443/", text)

    def test_no_dns_line_while_the_forwarder_does_not_answer(self):
        # A DNS server that doesn't answer would leave the device without name resolution.
        self.dns_answers = False
        result = agent.op_wg_add_peer({"name": "laptop"}, "alice")
        s = profile_sections(result["config"])
        self.assertNotIn("DNS", s["Interface"])
        self.assertEqual(s["Peer"]["AllowedIPs"], ["10.77.0.1/32"])
        self.assertEqual(result["dns"], "")
        self.assertIn('add "10.77.0.1 ops.example.com" to', result["config"])
        self.assertIn("C:\\Windows\\System32\\drivers\\etc\\hosts", result["config"])
        self.assertEqual(agent.devices_without_dns(agent.wg_peers()), ["laptop"])

    def test_first_device_header_needs_no_hosts_file(self):
        profile = agent.WG_DIR / "first-device.conf"
        agent.ensure_first_device("alice-device", profile)
        text = profile.read_text()
        header = text.split("# Lumen operator access", 1)[0]
        self.assertIn("Import it into the WireGuard app on your phone or computer", header)
        self.assertIn("sudo ./lumenctl wireguard show-profile", header)
        self.assertIn("sudo ./lumenctl wireguard forget-profile", header)
        self.assertNotIn("hosts", header)  # the old hosts-file step is gone from the steps
        self.assertEqual(profile_sections(text)["Interface"]["DNS"], ["10.77.0.1"])
        self.assertIn("no hosts-file edit needed", text)
        self.assertIn('"10.77.0.1 ops.example.com"', text)  # the hosts line only as the fallback

    def test_first_device_without_tunnel_dns_explains_the_hosts_line(self):
        self.dns_answers = False
        profile = agent.WG_DIR / "first-device.conf"
        agent.ensure_first_device("alice-device", profile)
        text = profile.read_text()
        self.assertNotIn("DNS", profile_sections(text)["Interface"])
        self.assertIn("/etc/hosts (Linux, macOS)", text)

    def test_client_generated_key_gets_the_rest_of_the_configuration(self):
        pub = b64key(b"device-made-key")
        with self.assertLogs("lumen-agent", level="INFO") as logs:
            resp = agent.handle_request(json.dumps({"op": "wg.add_peer", "args": {"name": "desk", "public_key": pub}, "actor": "alice"}).encode(), 10001)
        result = resp["result"]
        self.assertNotIn("config", result)  # no private key exists on the server
        s = profile_sections(result["client_config"])
        self.assertEqual(s["Interface"]["DNS"], ["10.77.0.1"])
        self.assertEqual(s["Interface"]["PrivateKey"], ["<the private key you generated on the device>"])
        self.assertEqual(s["Peer"]["PresharedKey"], [result["psk"]])
        self.assertEqual(s["Peer"]["AllowedIPs"], ["10.77.0.1/32"])
        logged = "\n".join(logs.output)
        self.assertNotIn(result["psk"], logged)
        self.assertNotIn("PresharedKey", logged)  # the configuration text is never logged
        self.assertIsNone(agent.wg_peers()[0]["profile_dns"])
        self.assertEqual(agent.devices_without_dns(agent.wg_peers()), [])  # its owner writes the profile

    def test_devices_from_before_tunnel_dns_are_reported(self):
        agent.op_wg_add_peer({"name": "new-phone"}, "alice")
        peers = agent.wg_peers()
        legacy = dict(peers[0], name="old-laptop", public_key=b64key(b"old"), address="10.77.0.9", id="legacy1")
        legacy.pop("profile_dns")  # peers.json written by a version without tunnel DNS
        (agent.WG_DIR / "psk" / "legacy1.psk").write_text(b64key(b"psk") + "\n")
        agent.wg_save_peers(peers + [legacy])
        self.assertEqual(agent.devices_without_dns(agent.wg_peers()), ["old-laptop"])
        agent.STATE_PATH.write_text(json.dumps({"wireguard": "enabled", "wireguard_dns": "enabled"}))
        st = agent.op_wg_status({})
        self.assertEqual(st["devices_without_dns"], ["old-laptop"])
        flags = {p["name"]: p["dns_in_profile"] for p in st["peers"]}
        self.assertEqual(flags, {"new-phone": True, "old-laptop": False})
        self.assertEqual(st["dns"]["server"], "10.77.0.1")
        self.assertEqual(st["dns"]["name"], "ops.example.com")
        self.assertEqual(st["dns"]["state"], "enabled")

    def test_add_device_stores_a_root_only_profile(self):
        info = agent.add_stored_device("alice-phone")
        path = agent.WG_DIR / "profiles" / "alice-phone.conf"
        self.assertEqual(info["profile"], str(path))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        text = path.read_text()
        self.assertIn("sudo ./lumenctl wireguard show-profile alice-phone", text)
        self.assertIn("sudo ./lumenctl wireguard forget-profile alice-phone", text)
        self.assertEqual(profile_sections(text)["Interface"]["DNS"], ["10.77.0.1"])
        self.assertEqual(info["dns"], "10.77.0.1")
        private = profile_sections(text)["Interface"]["PrivateKey"][0]
        self.assertNotIn(private, json.dumps(info))
        self.assertNotIn(private, agent.WG_CONF.read_text())
        with self.assertRaises(agent.OpError):
            agent.add_stored_device("alice-phone")  # never replaced, never a second key pair
        self.assertEqual(path.read_text(), text)
        agent.STATE_PATH.write_text(json.dumps({"wireguard": "enabled"}))
        self.assertEqual(agent.op_wg_status({})["stored_profiles"], ["alice-phone"])

    def test_add_device_rejects_bad_names(self):
        for bad in ("..", ".", "../etc", "a/b", "x" * 33, ""):
            with self.assertRaises(agent.OpError, msg=bad):
                agent.add_stored_device(bad)
        self.assertEqual(agent.wg_peers(), [])

    def test_add_device_command_line_prints_no_key_material(self):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = agent.cli(["wg-add-device", "--name", "lab-phone"])
        self.assertEqual(rc, 0)
        printed = out.getvalue()
        self.assertTrue(printed.startswith("created lab-phone 10.77.0.2 "), printed)
        self.assertIn(" 10.77.0.1 ", printed)  # the DNS server in the profile
        for line in (agent.WG_DIR / "profiles" / "lab-phone.conf").read_text().splitlines():
            if line.startswith(("PrivateKey", "PresharedKey")):
                self.assertNotIn(line.split(" = ", 1)[1], printed)


class TunnelDnsForwarder(AgentTestCase):
    """The forwarder's configuration: tunnel address only, the console's name, the upstream."""

    def lines(self, text: str) -> list[str]:
        return [line for line in text.splitlines() if line and not line.startswith("#")]

    def test_listens_on_the_tunnel_address_only(self):
        agent.HOST_RESOLV.write_text("nameserver 192.0.2.53\n")
        cfg = self.lines(agent.dns_config())
        listen = [line for line in cfg if line.startswith("listen-address=")]
        self.assertEqual(listen, ["listen-address=10.77.0.1"])
        self.assertIn("bind-interfaces", cfg)  # binds that address, not the wildcard
        self.assertIn("port=53", cfg)
        for opt in ("interface=", "except-interface=", "bind-dynamic", "dhcp-range", "auth-server", "conf-dir", "addn-hosts", "log-queries"):
            self.assertFalse([line for line in cfg if line.startswith(opt)], opt)
        self.assertIn("no-hosts", cfg)
        self.assertIn("resolv-file=" + str(agent.HOST_RESOLV), cfg)

    def test_answers_the_console_name_with_the_tunnel_address(self):
        cfg = self.lines(agent.dns_config())
        self.assertIn("address=/ops.example.com/10.77.0.1", cfg)
        # dnsmasq >= 2.86 would forward AAAA/HTTPS for that name upstream (and return the public
        # IPv6 address): local= keeps every other type an empty local answer.
        self.assertIn("local=/ops.example.com/", cfg)
        self.write_conf("WG_SUBNET=10.199.77.0/24\nLUMEN_OPS_DOMAIN=ops.mylumen.duckdns.org\n")
        cfg = self.lines(agent.dns_config())
        self.assertIn("listen-address=10.199.77.1", cfg)
        self.assertIn("address=/ops.mylumen.duckdns.org/10.199.77.1", cfg)
        self.assertIn("local=/ops.mylumen.duckdns.org/", cfg)

    def test_a_console_name_that_could_inject_options_is_refused(self):
        for bad in ("ops.example.com/#/203.0.113.1", "ops.example.com listen-address=0.0.0.0", "-ops.example.com"):
            self.write_conf(f"LUMEN_OPS_DOMAIN={bad}\n")
            with self.assertRaises(agent.OpError, msg=bad):
                agent.dns_config()

    def test_written_root_only_and_only_when_changed(self):
        agent.ensure_wireguard_server_key()
        first = agent.write_dns_config()
        path = agent.WG_DIR / "dnsmasq.conf"
        self.assertEqual(first["CHANGED"], "1")
        self.assertEqual((first["LISTEN"], first["NAME"], first["CONF"]), ("10.77.0.1", "ops.example.com", str(path)))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertTrue(path.read_text().startswith(agent.WG_MARKER))
        self.assertEqual(agent.write_dns_config()["CHANGED"], "0")  # re-runs restart nothing
        self.write_conf("LUMEN_OPS_DOMAIN=console.example.com\n")
        self.assertEqual(agent.write_dns_config()["CHANGED"], "1")

    def test_not_written_when_wireguard_is_off(self):
        self.write_conf("WIREGUARD_ENABLED=false\n")
        with self.assertRaises(agent.OpError):
            agent.write_dns_config()
        self.assertFalse((agent.WG_DIR / "dnsmasq.conf").exists())

    def test_cli_prints_the_facts(self):
        agent.ensure_wireguard_server_key()
        agent.HOST_RESOLV.write_text("nameserver 192.0.2.53\n")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(agent.cli(["wg-dns-setup"]), 0)
        facts = dict(line.split("=", 1) for line in out.getvalue().splitlines())
        self.assertEqual(facts["LISTEN"], "10.77.0.1")
        self.assertEqual(facts["UPSTREAMS"], "192.0.2.53")
        self.assertEqual(facts["CHANGED"], "1")


class DnsUpstream(AgentTestCase):
    """Which resolv file the forwarder follows (dnsmasq re-reads it when it changes)."""

    STUB = "# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n"

    def choose(self):
        return agent.choose_dns_upstream("10.77.0.1")

    def test_systemd_resolved_uses_the_real_upstream_servers(self):
        agent.HOST_RESOLV.write_text(self.STUB)
        agent.RESOLVED_UPSTREAM.write_text("# managed by systemd-resolved\nnameserver 10.0.0.2\nnameserver 2001:db8::53\nsearch internal\n")
        path, servers, note = self.choose()
        self.assertEqual(path, agent.RESOLVED_UPSTREAM)
        self.assertEqual(servers, ["10.0.0.2", "2001:db8::53"])
        self.assertIn("systemd-resolved", note)
        self.assertIn(f"resolv-file={agent.RESOLVED_UPSTREAM}", agent.dns_config())

    def test_plain_resolv_conf(self):
        agent.HOST_RESOLV.write_text("nameserver 192.0.2.53\nnameserver 198.51.100.53\noptions timeout:2\n")
        agent.RESOLVED_UPSTREAM.write_text("nameserver 10.0.0.2\n")  # stale: resolved isn't in use
        self.assertEqual(self.choose()[:2], (agent.HOST_RESOLV, ["192.0.2.53", "198.51.100.53"]))

    def test_resolved_without_upstream_falls_back_to_its_stub(self):
        agent.HOST_RESOLV.write_text(self.STUB)
        path, servers, note = self.choose()  # /run/systemd/resolve/resolv.conf missing
        self.assertEqual((path, servers), (agent.HOST_RESOLV, ["127.0.0.53"]))
        self.assertIn("stub", note)
        agent.RESOLVED_UPSTREAM.write_text("# no servers yet\n")
        self.assertEqual(self.choose()[0], agent.HOST_RESOLV)

    def test_never_forwards_to_itself(self):
        agent.HOST_RESOLV.write_text("nameserver 10.77.0.1\nnameserver 192.0.2.53\n")
        self.assertEqual(self.choose()[1], ["192.0.2.53"])
        agent.HOST_RESOLV.write_text("nameserver 10.77.0.1\n")
        agent.RESOLVED_UPSTREAM.write_text("nameserver 10.77.0.1\nnameserver 127.0.0.53\nnameserver 0.0.0.0\n")
        path, servers, note = self.choose()
        self.assertEqual(servers, [])
        self.assertIn("no upstream", note)

    def test_odd_lines_and_scoped_addresses(self):
        agent.HOST_RESOLV.write_text("nameserver\nnameserver not-an-ip\n#nameserver 1.1.1.1\nnameserver fe80::1%eth0\n domain x\n")
        self.assertEqual(self.choose()[1], ["fe80::1%eth0"])


class DnsSelfCheck(AgentTestCase):
    """The real check (console name, then forwarding), with dns_query answered by a fake server."""

    def setUp(self):
        super().setUp()
        self.answers: dict[str, object] = {}
        self.asked: list[str] = []
        agent.tunnel_dns_check = self._saved["tunnel_dns_check"]
        agent.tunnel_dns_ready = self._saved["tunnel_dns_ready"]

        def fake(server, name, qtype=1, *, timeout=1.0, tcp=False):
            self.assertEqual(server, "10.77.0.1")  # only ever the tunnel address
            self.asked.append(name)
            a = self.answers.get(name, OSError("timed out"))
            if isinstance(a, Exception):
                raise a
            return a
        agent.dns_query = fake

    def test_console_name_and_forwarding(self):
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": (0, ["93.184.215.14"])}
        self.assertEqual(agent.tunnel_dns_check(), {"console": True, "forwarding": True, "detail": "example.com -> 93.184.215.14"})
        self.assertTrue(agent.tunnel_dns_ready())
        self.assertEqual(self.asked[:2], ["ops.example.com", "example.com"])

    def test_nxdomain_from_upstream_proves_forwarding(self):
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": (3, [])}
        self.assertTrue(agent.tunnel_dns_check()["forwarding"])

    def test_never_probes_this_servers_own_names(self):
        # Through systemd-resolved's stub those can come from /etc/hosts: no proof of forwarding.
        self.write_conf("LUMEN_PRIMARY_DOMAIN=mylumen.duckdns.org\n")
        self.answers = {"ops.mylumen.duckdns.org": (0, ["10.77.0.1"]), "mylumen.duckdns.org": (0, ["127.0.1.1"]),
                        "example.com": (5, []), "iana.org": (5, [])}
        check = agent.tunnel_dns_check()
        self.assertFalse(check["forwarding"])
        self.assertNotIn("mylumen.duckdns.org", self.asked[1:])

    def test_refused_servfail_or_silence_is_not_forwarding(self):
        for upstream, expect in (((5, []), "REFUSED"), ((2, []), "SERVFAIL"), (OSError("timed out"), "no answer")):
            self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": upstream, "iana.org": upstream}
            check = agent.tunnel_dns_check()
            self.assertTrue(check["console"])
            self.assertFalse(check["forwarding"])
            self.assertIn(expect, check["detail"])
            self.assertFalse(agent.tunnel_dns_ready())  # so no profile gets a DNS line

    def test_a_second_probe_name_when_the_first_fails(self):
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": OSError("timed out"), "iana.org": (0, ["192.0.43.8"])}
        check = agent.tunnel_dns_check()
        self.assertTrue(check["forwarding"])
        self.assertEqual(check["detail"], "iana.org -> 192.0.43.8")

    def test_console_name_wrong_or_silent(self):
        self.answers = {"ops.example.com": (0, ["203.0.113.9"])}
        self.assertEqual(agent.tunnel_dns_check()["console"], False)
        self.answers = {}
        check = agent.tunnel_dns_check()
        self.assertEqual((check["console"], check["forwarding"]), (False, False))
        self.assertEqual(self.asked[-1], "ops.example.com")  # nothing else asked without an answer

    def test_probe_names_never_the_console(self):
        self.assertEqual(agent.dns_probe_names({"LUMEN_PRIMARY_DOMAIN": "example.org"}), ["example.com", "iana.org"])
        self.assertEqual(agent.dns_probe_names({"LUMEN_PRIMARY_DOMAIN": "x.example.com", "LUMEN_OPS_DOMAIN": "example.com"}), ["iana.org"])

    def test_profile_has_no_dns_line_while_forwarding_fails(self):
        agent.ensure_wireguard_server_key()
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": (5, []), "iana.org": (5, [])}
        result = agent.op_wg_add_peer({"name": "phone"}, "alice")
        self.assertNotIn("DNS", profile_sections(result["config"])["Interface"])
        self.assertEqual(result["dns"], "")
        self.assertEqual(agent.devices_without_dns(agent.wg_peers()), ["phone"])

    def test_cli_exit_codes(self):
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": (5, []), "iana.org": (5, [])}
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(agent.cli(["wg-dns-check"]), 3)
        self.assertIn("forwarding fails: iana.org: REFUSED", err.getvalue())
        self.answers = {}
        with redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(agent.cli(["wg-dns-check"]), 2)
        self.answers = {"ops.example.com": (0, ["10.77.0.1"]), "example.com": (0, ["93.184.215.14"])}
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(agent.cli(["wg-dns-check"]), 0)
        self.assertIn("forwarding: example.com -> 93.184.215.14", out.getvalue())


class DnsWire(unittest.TestCase):
    """The small DNS client the agent uses to check the forwarder."""

    @staticmethod
    def reply(qid=b"\x12\x34", rcode=0, answers=()):
        q = agent._dns_name("ops.example.com") + b"\x00\x01\x00\x01"
        body = b""
        for rtype, rdata in answers:
            body += b"\xc0\x0c" + rtype.to_bytes(2, "big") + b"\x00\x01" + (60).to_bytes(4, "big") + len(rdata).to_bytes(2, "big") + rdata
        flags = bytes([0x81, 0x80 | rcode])
        return qid + flags + b"\x00\x01" + len(answers).to_bytes(2, "big") + b"\x00\x00\x00\x00" + q + body

    def test_parses_a_and_aaaa_answers(self):
        data = self.reply(answers=[(1, bytes([10, 77, 0, 1])), (28, ipaddress.ip_address("2001:db8::1").packed), (5, b"\x00")])
        self.assertEqual(agent.parse_dns_response(data, b"\x12\x34"), (0, ["10.77.0.1", "2001:db8::1"]))

    def test_empty_answer_and_rcode(self):
        self.assertEqual(agent.parse_dns_response(self.reply(), b"\x12\x34"), (0, []))
        self.assertEqual(agent.parse_dns_response(self.reply(rcode=3), b"\x12\x34"), (3, []))

    def test_rejects_other_ids_and_truncated_replies(self):
        with self.assertRaises(OSError):
            agent.parse_dns_response(self.reply(), b"\x00\x00")
        with self.assertRaises(OSError):
            agent.parse_dns_response(self.reply(answers=[(1, bytes([10, 77, 0, 1]))])[:-3], b"\x12\x34")
        with self.assertRaises(OSError):
            agent.parse_dns_response(b"\x12\x34", b"\x12\x34")

    def test_name_encoding(self):
        self.assertEqual(agent._dns_name("ops.example.com."), b"\x03ops\x07example\x03com\x00")
        with self.assertRaises(ValueError):
            agent._dns_name("a..b")


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
                        lambda: agent.op_wg_add_peer({"name": "laptop"}, "alice"),
                        lambda: agent.add_stored_device("laptop"), agent.write_dns_config):
            with self.assertRaises(agent.OpError):
                attempt()
            self.assertEqual(agent.WG_CONF.read_text(), self.FOREIGN)
        self.assertEqual(agent.wg_peers(), [])
        self.assertFalse((agent.WG_DIR / "first-device.conf").exists())
        # No DNS forwarder for someone else's WireGuard either.
        self.assertFalse((agent.WG_DIR / "dnsmasq.conf").exists())
        self.assertFalse((agent.WG_DIR / "profiles").exists())

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
