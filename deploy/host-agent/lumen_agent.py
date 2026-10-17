#!/usr/bin/env python3
"""lumen-agent: allow-listed host operations for the Lumen operator console.

Runs as root under systemd and listens on a Unix socket that is bind-mounted
into the `ops` container. It is the ONLY path from a container to the host:
the Docker socket is never mounted into any container.

Protocol: one JSON object per line → one JSON object per line.
  request  {"id": "...", "op": "wg.status", "args": {...}, "actor": "alice"}
  response {"id": "...", "ok": true, "result": {...}} | {"ok": false, "error": "..."}

Security properties
  * peer credentials (SO_PEERCRED) must be root or the app UID (10001);
  * operations come from a fixed allow-list with strict argument validation;
  * subprocesses use argv lists (never a shell) with timeouts;
  * WireGuard private keys generated here are returned once and never stored
    or logged; every operation is logged without secrets. The one exception is
    the installer's first operator device (`wg-first-peer`, run as root from
    the command line, not over the socket): its profile is written to a
    root-only file (0600 in a 0700 directory) for the operator to import and
    then delete (`lumenctl wireguard forget-profile`).

  * DNS inside the tunnel: a dnsmasq forwarder (lumen-wg-dns.service) listens on
    the server's tunnel address only. It answers the console's name with that
    address and forwards everything else to this host's upstream resolvers, so
    devices whose profile says `DNS = <tunnel address>` reach the console by name
    without a hosts-file edit. It never listens on any other address.

Command line (root, used by the installer; never reachable from a container):
  lumen_agent.py                      run the socket server
  lumen_agent.py init-wireguard       server key + wg0.conf; prints the public key
  lumen_agent.py wg-plan [--public-ip A] [--lan-ip A]
                                      KEY=VALUE lines: a non-Lumen wg0 (FOREIGN), the
                                      subnet to use and the endpoint devices dial
  lumen_agent.py wg-first-peer --name N --out FILE
                                      the first operator device, once (never a second
                                      one, never new keys); prints no secrets
  lumen_agent.py wg-add-device --name N
                                      a new device whose profile is stored root-only in
                                      WG_DIR/profiles/N.conf (lumenctl show-profile N
                                      shows it as a QR code); prints no secrets
  lumen_agent.py wg-dns-setup         write the tunnel DNS forwarder's configuration;
                                      KEY=VALUE lines (CHANGED, LISTEN, NAME, UPSTREAMS...)
  lumen_agent.py wg-dns-check [--wait S]
                                      exit 0 when the forwarder answers the console's
                                      name with the tunnel address
  lumen_agent.py wg-dns-info          KEY=VALUE lines for summaries and the health check
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import grp
import ipaddress
import json
import logging
import os
import pwd
import re
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

CONF_PATH = Path(os.environ.get("LUMEN_CONF", "/etc/lumen/lumen.conf"))
STATE_PATH = Path(os.environ.get("LUMEN_STATE", "/etc/lumen/state.json"))
SOCKET_DIR = Path(os.environ.get("LUMEN_AGENT_DIR", "/run/lumen-agent"))
SOCKET_PATH = SOCKET_DIR / "agent.sock"
WG_DIR = Path(os.environ.get("LUMEN_WG_DIR", "/etc/lumen/wireguard"))
WG_CONF = Path(os.environ.get("LUMEN_WG_CONF", "/etc/wireguard/wg0.conf"))
WG_IF = "wg0"
ALLOWED_UIDS = {0, 10001}
SOCKET_GID = 10300
MAX_REQUEST = 64 * 1024
RESTARTABLE = {"portal", "worker", "synapse", "caddy", "livekit", "lkjwt", "ops"}

log = logging.getLogger("lumen-agent")


def conf() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for raw in CONF_PATH.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def repo_dir() -> Path:
    try:
        return Path(json.loads(STATE_PATH.read_text()).get("repo_dir") or "/opt/lumen")
    except (OSError, ValueError):
        return Path("/opt/lumen")


def run(argv: list[str], timeout: int = 30, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, input=input_text, check=False)


class OpError(Exception):
    pass


# --------------------------------------------------------------------------------
# Host status
# --------------------------------------------------------------------------------


def op_host_status(args: dict) -> dict:
    c = conf()
    mem = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) // 1024 if v.strip() else 0
    total, avail = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    data_dir = c.get("LUMEN_DATA_DIR", "/var/lib/lumen")
    du = shutil.disk_usage(data_dir if os.path.isdir(data_dir) else "/")
    load = os.getloadavg()
    uptime = float(Path("/proc/uptime").read_text().split()[0])
    os_name = ""
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                os_name = line.split("=", 1)[1].strip('"')
    except OSError:
        pass
    updates = {"pending": None, "security": None}
    if Path("/usr/lib/update-notifier/apt-check").exists():
        r = run(["/usr/lib/update-notifier/apt-check"], timeout=60)
        m = re.match(r"(\d+);(\d+)", (r.stderr or "").strip())
        if m:
            updates = {"pending": int(m.group(1)), "security": int(m.group(2))}
    unattended = False
    try:
        unattended = 'Unattended-Upgrade "1"' in Path("/etc/apt/apt.conf.d/20auto-upgrades").read_text()
    except OSError:
        pass
    firewall = "unknown"
    if shutil.which("ufw"):
        r = run(["ufw", "status"], timeout=10)
        firewall = (r.stdout.splitlines() or ["unknown"])[0].replace("Status: ", "ufw ")
    return {
        "os": os_name,
        "cpus": os.cpu_count(),
        "load": [round(x, 2) for x in load],
        "memory": {"total_mb": total, "available_mb": avail, "used_pct": round(100 * (total - avail) / total, 1) if total else None},
        "disk": {"path": data_dir, "free_gb": round(du.free / 1e9, 1), "used_pct": round(100 * du.used / du.total, 1)},
        "uptime_days": round(uptime / 86400, 1),
        "reboot_required": Path("/var/run/reboot-required").exists(),
        "updates": updates,
        "unattended_upgrades": unattended,
        "firewall": firewall,
        "containers": containers(),
    }


def compose_argv(*args: str) -> list[str]:
    c = conf()
    rendered = Path(c.get("LUMEN_CONFIG_DIR", "/etc/lumen")) / "rendered" / "compose.env"
    repo = repo_dir()
    argv = ["docker", "compose", "--project-directory", str(repo), "--env-file", str(rendered), "-f", str(repo / "docker-compose.yml")]
    if c.get("CALLS_ENABLED", "true").lower() in {"1", "true", "yes", "on"}:
        argv += ["--profile", "calls"]
    return argv + list(args)


def containers() -> list[dict]:
    if not shutil.which("docker"):
        return []
    r = run(compose_argv("ps", "--all", "--format", "json"), timeout=20)
    out = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items = json.loads(line)
        except ValueError:
            continue
        for item in items if isinstance(items, list) else [items]:
            out.append({"service": item.get("Service"), "state": item.get("State"), "health": item.get("Health", "")})
    return out


# --------------------------------------------------------------------------------
# WireGuard
# --------------------------------------------------------------------------------

KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
HOST_RE = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
# First line of every wg0.conf Lumen writes. A wg0.conf without it belongs to someone else and
# is never overwritten, started or stopped by Lumen.
WG_MARKER = "# Managed by Lumen (lumen-agent)"
DEFAULT_SUBNET = "10.77.0.0/24"
# Tried in this order when WG_SUBNET overlaps a network this host already uses.
SUBNET_CANDIDATES = ("10.77.0.0/24", "10.78.0.0/24", "10.79.0.0/24", "10.177.0.0/24", "10.199.77.0/24", "192.168.177.0/24")
_wg_lock = threading.Lock()


def truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def wg_enabled() -> bool:
    # On by default: the installer writes the key explicitly; absent means a hand-written lumen.conf.
    return truthy(conf().get("WIREGUARD_ENABLED", "true") or "true")


@contextlib.contextmanager
def wg_locked():
    """One writer at a time, across the socket server and the installer's command line."""
    with _wg_lock:
        WG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(WG_DIR, 0o700)
        fd = os.open(WG_DIR / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def write_private(path: Path, text: str) -> None:
    """Atomically write a root-only file (0600); callers keep it inside WG_DIR (0700)."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def wg_peers() -> list[dict]:
    try:
        return json.loads((WG_DIR / "peers.json").read_text())
    except (OSError, ValueError):
        return []


def wg_save_peers(peers: list[dict]) -> None:
    write_private(WG_DIR / "peers.json", json.dumps(peers, indent=2))


def wg_meta() -> dict:
    try:
        data = json.loads((WG_DIR / "server.json").read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def wg_save_meta(meta: dict) -> None:
    write_private(WG_DIR / "server.json", json.dumps(meta, indent=2))


def wg_conf_is_lumen() -> bool:
    try:
        with WG_CONF.open() as fh:
            head = [fh.readline() for _ in range(3)]
    except OSError:
        return False
    return any(line.startswith(WG_MARKER) for line in head)


def foreign_reason() -> str:
    """Why this host's wg0 is not Lumen's to manage ('' when it is, or when there is none)."""
    if WG_CONF.exists() and not wg_conf_is_lumen():
        return f"{WG_CONF} exists and was not written by Lumen (left untouched)"
    if not WG_CONF.exists() and interface_exists():
        return f"a network interface {WG_IF} exists that Lumen did not create (left untouched)"
    return ""


def wg_write_config(peers: list[dict]) -> None:
    """Regenerate wg0.conf from the server key and peer list (mode 0600)."""
    if WG_CONF.exists() and not wg_conf_is_lumen():
        raise OpError(f"{WG_CONF} was not written by Lumen; refusing to overwrite it")
    c = conf()
    net = ipaddress.ip_network(c.get("WG_SUBNET", DEFAULT_SUBNET))
    server_ip = next(net.hosts())
    private = (WG_DIR / "server.key").read_text().strip()
    lines = [
        f"{WG_MARKER}. Manual edits are overwritten.",
        "[Interface]",
        f"Address = {server_ip}/{net.prefixlen}",
        f"ListenPort = {c.get('WG_PORT', '51820')}",
        f"PrivateKey = {private}",
        "",
    ]
    for p in peers:
        lines += [
            f"# {p['name']} (added {p.get('created_at', '')} by {p.get('created_by', '')})",
            "[Peer]",
            f"PublicKey = {p['public_key']}",
            f"PresharedKey = {(WG_DIR / 'psk' / (p['id'] + '.psk')).read_text().strip()}",
            f"AllowedIPs = {p['address']}/32",
            "",
        ]
    WG_CONF.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = WG_CONF.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(lines))
    os.replace(tmp, WG_CONF)


def wg_sync() -> None:
    """Apply wg0.conf to the live interface without dropping existing sessions."""
    if not interface_exists():
        return
    stripped = run(["wg-quick", "strip", str(WG_CONF)], timeout=15)
    if stripped.returncode != 0:
        raise OpError("wg-quick strip failed")
    tmp = WG_DIR / ".sync.conf"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(stripped.stdout)
    try:
        r = run(["wg", "syncconf", WG_IF, str(tmp)], timeout=15)
        if r.returncode != 0:
            raise OpError(f"wg syncconf failed: {r.stderr.strip()[:200]}")
    finally:
        tmp.unlink(missing_ok=True)


def interface_exists() -> bool:
    return Path(f"/sys/class/net/{WG_IF}").exists()


def server_public_key() -> str:
    private = (WG_DIR / "server.key").read_text().strip()
    return run(["wg", "pubkey"], input_text=private + "\n").stdout.strip()


def install_state() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def first_device_profile() -> Path:
    return WG_DIR / "first-device.conf"


def stored_profiles_dir() -> Path:
    """Profiles of devices added with `lumenctl wireguard add-device` (root only, 0600 in 0700)."""
    return WG_DIR / "profiles"


def tunnel_ip(c: dict | None = None) -> str:
    """The server's own address in the tunnel (the first host of WG_SUBNET)."""
    c = conf() if c is None else c
    return str(next(ipaddress.ip_network(c.get("WG_SUBNET", DEFAULT_SUBNET) or DEFAULT_SUBNET).hosts()))


def ops_domain(c: dict | None = None) -> str:
    c = conf() if c is None else c
    return c.get("LUMEN_OPS_DOMAIN") or f"ops.{c.get('LUMEN_PRIMARY_DOMAIN', '')}"


# --------------------------------------------------------------------------------
# DNS inside the tunnel (split DNS)
# --------------------------------------------------------------------------------
# The console's name resolves publicly to the server's public address, from which the console
# refuses connections. A device whose profile says `DNS = <tunnel address>` asks a small
# forwarder (dnsmasq, lumen-wg-dns.service) on that address instead: it answers the console's
# name with the tunnel address and forwards every other query to this host's own upstream
# resolvers. It listens on the tunnel address only, so it is never an open resolver.

HOST_RESOLV = Path("/etc/resolv.conf")
# systemd-resolved's list of the real upstream servers; /etc/resolv.conf then names only its
# local stub (127.0.0.53), which the forwarder does not use while real servers are known.
RESOLVED_UPSTREAM = Path("/run/systemd/resolve/resolv.conf")
RESOLVED_STUBS = {"127.0.0.53", "127.0.0.54"}


def dns_conf_path() -> Path:
    return WG_DIR / "dnsmasq.conf"


def resolv_nameservers(path: Path) -> list[str]:
    """The `nameserver` addresses of a resolv.conf-style file ([] if it can't be read)."""
    try:
        text = path.read_text()
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            try:
                ipaddress.ip_address(parts[1].split("%")[0])
            except ValueError:
                continue
            out.append(parts[1])
    return out


def choose_dns_upstream(tunnel: str, host_resolv: Path | None = None, resolved: Path | None = None) -> tuple[Path, list[str], str]:
    """(resolv file the forwarder reads, the upstream servers in it, note).

    With systemd-resolved, /etc/resolv.conf names only its local stub: the forwarder reads
    resolved's own upstream list instead. Otherwise /etc/resolv.conf. dnsmasq re-reads the
    chosen file whenever it changes (DHCP), and never forwards to the tunnel address itself."""
    host_resolv = host_resolv or HOST_RESOLV
    resolved = resolved or RESOLVED_UPSTREAM

    def usable(servers: list[str]) -> list[str]:
        out = []
        for s in servers:
            a = ipaddress.ip_address(s.split("%")[0])
            if str(a) != tunnel and not a.is_unspecified:
                out.append(s)
        return out

    host = usable(resolv_nameservers(host_resolv))
    if not host or any(s in RESOLVED_STUBS for s in host):
        real = [s for s in usable(resolv_nameservers(resolved)) if s not in RESOLVED_STUBS]
        if real:
            return resolved, real, "systemd-resolved's upstream servers"
    if host:
        if all(s in RESOLVED_STUBS for s in host):
            return host_resolv, host, "systemd-resolved's local stub (it lists no upstream server)"
        return host_resolv, host, "this host's resolvers"
    return host_resolv, [], "no upstream DNS server found; only the console's name is answered until one is configured"


def dns_user() -> tuple[str, str]:
    """The unprivileged user dnsmasq switches to after binding port 53."""
    for name in ("dnsmasq", "nobody"):
        try:
            pw = pwd.getpwnam(name)
        except KeyError:
            continue
        try:
            return name, grp.getgrgid(pw.pw_gid).gr_name
        except KeyError:
            return name, "nogroup"
    return "nobody", "nogroup"


def dns_config(c: dict | None = None, upstream: tuple[Path, list[str], str] | None = None) -> str:
    """dnsmasq configuration for the tunnel DNS forwarder (only this file is read)."""
    c = conf() if c is None else c
    server, name = tunnel_ip(c), ops_domain(c)
    if not HOST_RE.match(name):
        raise OpError(f"the console's name {name!r} is not a valid host name (LUMEN_OPS_DOMAIN)")
    resolv, servers, note = upstream or choose_dns_upstream(server)
    user, group = dns_user()
    return "\n".join([
        f"{WG_MARKER}. Manual edits are overwritten.",
        "# DNS for WireGuard devices (split DNS): the console's name resolves to the tunnel address,",
        "# every other name is forwarded to this host's upstream resolvers. Queries are not logged.",
        "# Listens on the tunnel address only (never on a public interface): not an open resolver.",
        f"listen-address={server}",
        "bind-interfaces",
        "port=53",
        "# Nothing else is read: not /etc/dnsmasq.conf, not /etc/hosts. No dhcp-range: no DHCP.",
        "no-hosts",
        f"# Upstream: {note} ({' '.join(servers) or 'none'} when this file was written).",
        f"resolv-file={resolv}",
        "# The console: its A record is answered here, every other type (AAAA, HTTPS, ...) gets an",
        "# empty answer, so a device never learns the public address of this name.",
        f"local=/{name}/",
        f"address=/{name}/{server}",
        "domain-needed",
        "bogus-priv",
        "cache-size=1000",
        "edns-packet-max=1232",
        f"user={user}",
        f"group={group}",
        "",
    ])


def write_dns_config() -> dict[str, str]:
    """Write the forwarder's configuration (only when it changed). Returns KEY=VALUE facts."""
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    reason = foreign_reason()
    if reason:
        raise OpError(reason)
    c = conf()
    server = tunnel_ip(c)
    upstream = choose_dns_upstream(server)
    text = dns_config(c, upstream)
    path = dns_conf_path()
    with wg_locked():
        try:
            old = path.read_text()
        except OSError:
            old = None
        if old != text:
            write_private(path, text)
    return {"CONF": str(path), "CHANGED": "1" if old != text else "0", "LISTEN": server, "NAME": ops_domain(c),
            "UPSTREAM_FILE": str(upstream[0]), "UPSTREAMS": " ".join(upstream[1]) or "none", "UPSTREAM_NOTE": upstream[2]}


def _dns_name(name: str) -> bytes:
    out = b""
    for label in name.rstrip(".").split("."):
        raw = label.encode("idna")
        if not raw or len(raw) > 63:
            raise ValueError(f"invalid DNS name {name!r}")
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def _dns_skip_name(data: bytes, i: int) -> int:
    while True:
        n = data[i]
        if n & 0xC0 == 0xC0:
            return i + 2
        if n == 0:
            return i + 1
        i += n + 1


def parse_dns_response(data: bytes, qid: bytes | None = None) -> tuple[int, list[str]]:
    """(rcode, the A/AAAA addresses in the answer section) of a DNS response."""
    try:
        if len(data) < 12 or (qid is not None and data[:2] != qid) or not data[2] & 0x80:
            raise OSError("not a reply to this query")
        qdcount, ancount = struct.unpack(">HH", data[4:8])
        i = 12
        for _ in range(qdcount):
            i = _dns_skip_name(data, i) + 4
        addrs = []
        for _ in range(ancount):
            i = _dns_skip_name(data, i)
            rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", data[i:i + 10])
            i += 10
            rdata = data[i:i + rdlen]
            i += rdlen
            if len(rdata) != rdlen:
                raise IndexError
            if rtype == 1 and rdlen == 4:
                addrs.append(socket.inet_ntop(socket.AF_INET, rdata))
            elif rtype == 28 and rdlen == 16:
                addrs.append(socket.inet_ntop(socket.AF_INET6, rdata))
        return data[3] & 0x0F, addrs
    except (IndexError, struct.error) as exc:
        raise OSError("truncated DNS reply") from exc


def dns_query(server: str, name: str, qtype: int = 1, *, timeout: float = 1.0, tcp: bool = False) -> tuple[int, list[str]]:
    """One DNS query to server:53 (UDP, or TCP) -> (rcode, addresses). OSError if no reply."""
    qid = os.urandom(2)
    msg = qid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + _dns_name(name) + struct.pack(">HH", qtype, 1)
    family = socket.AF_INET6 if ":" in server else socket.AF_INET
    if tcp:
        with socket.create_connection((server, 53), timeout=timeout) as s:
            s.sendall(struct.pack(">H", len(msg)) + msg)
            buf = b""
            while len(buf) < 2 or len(buf) < 2 + struct.unpack(">H", buf[:2])[0]:
                chunk = s.recv(4096)
                if not chunk:
                    raise OSError("connection closed")
                buf += chunk
            return parse_dns_response(buf[2:], qid)
    with socket.socket(family, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        s.connect((server, 53))
        s.send(msg)
        return parse_dns_response(s.recv(4096), qid)


RCODE_TEXT = {1: "FORMERR", 2: "SERVFAIL (the upstream resolvers failed)", 4: "NOTIMP",
              5: "REFUSED (no upstream resolver known: this server can't resolve names either)"}


# Public names to test forwarding with. Not this server's own names: with systemd-resolved's stub
# as the upstream, those can be answered from /etc/hosts (cloud images list the host's FQDN),
# which would prove nothing about forwarding.
DNS_PROBE_NAMES = ("example.com", "iana.org")


def dns_probe_names(c: dict) -> list[str]:
    """Names to test forwarding with; never the console's name, which the forwarder answers itself."""
    ops = ops_domain(c).lower()
    return [n for n in DNS_PROBE_NAMES if n != ops and not n.endswith("." + ops)]


def tunnel_dns_check(c: dict | None = None, timeout: float = 1.0) -> dict:
    """Ask the forwarder on the tunnel address, as a device would: the console's name must come
    back as the tunnel address, and another name must be forwarded (an upstream answer, even
    NXDOMAIN, proves forwarding; REFUSED, SERVFAIL or silence don't)."""
    c = conf() if c is None else c
    server = tunnel_ip(c)
    out = {"console": False, "forwarding": False, "detail": ""}
    try:
        rcode, addrs = dns_query(server, ops_domain(c), 1, timeout=timeout)
        out["console"] = rcode == 0 and server in addrs
    except (OSError, ValueError):
        out["detail"] = f"no answer from {server}:53"
        return out
    if not out["console"]:
        out["detail"] = f"{ops_domain(c)} -> {','.join(addrs) or RCODE_TEXT.get(rcode, f'rcode {rcode}')}"
        return out
    for name in dns_probe_names(c):
        try:
            rcode, addrs = dns_query(server, name, 1, timeout=max(timeout, 2.0))
        except (OSError, ValueError):
            out["detail"] = f"{name}: no answer (the upstream resolvers don't respond)"
            continue
        if rcode in (0, 3):
            out["forwarding"] = True
            out["detail"] = f"{name} -> {'NXDOMAIN' if rcode == 3 else ','.join(addrs) or 'no address'}"
            break
        out["detail"] = f"{name}: {RCODE_TEXT.get(rcode, f'rcode {rcode}')}"
    return out


def tunnel_dns_ready(c: dict | None = None, timeout: float = 1.0) -> bool:
    """True when the forwarder answers the console's name with the tunnel address AND forwards
    other names. Device profiles get a DNS line only then: a DNS server that doesn't answer, or
    can't forward, would leave the device unable to open anything while the tunnel is up."""
    check = tunnel_dns_check(c, timeout)
    return check["console"] and check["forwarding"]


def devices_without_dns(peers: list[dict]) -> list[str]:
    """Devices whose profile was issued without the DNS line (before tunnel DNS existed, or while
    it was unavailable). Client-generated keys (no profile issued here) are not listed."""
    return [p.get("name", "") for p in peers if p.get("profile_dns", "") == ""]


def op_wg_status(args: dict) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    c = conf()
    peers_meta = {p["public_key"]: p for p in wg_peers()}
    live: dict[str, dict] = {}
    listen_port = c.get("WG_PORT", "51820")
    up = interface_exists() and not foreign_reason()
    if up:
        r = run(["wg", "show", WG_IF, "dump"], timeout=10)
        lines = r.stdout.splitlines()
        if lines:
            listen_port = lines[0].split("\t")[2]
        now = int(time.time())
        for line in lines[1:]:
            f = line.split("\t")
            if len(f) < 8:
                continue
            hs = int(f[4] or 0)
            live[f[0]] = {
                "endpoint": f[2] if f[2] != "(none)" else "",
                "latest_handshake": hs,
                "handshake_age_s": now - hs if hs else None,
                "rx_bytes": int(f[5] or 0),
                "tx_bytes": int(f[6] or 0),
                "preshared_key": f[1] != "(none)",
            }
    peers = []
    for pub in sorted(set(peers_meta) | set(live)):
        meta = peers_meta.get(pub, {})
        # True: the profile issued here sets DNS; False: issued without it; None: the device's own key.
        dns_in_profile = None if not meta or meta.get("profile_dns", "") is None else bool(meta.get("profile_dns"))
        peers.append({"public_key": pub, "name": meta.get("name", ""), "allowed_ips": f"{meta.get('address', '?')}/32", "dns_in_profile": dns_in_profile,
                      **live.get(pub, {"latest_handshake": 0, "rx_bytes": 0, "tx_bytes": 0, "preshared_key": bool(meta)})})
    net = ipaddress.ip_network(c.get("WG_SUBNET", DEFAULT_SUBNET))
    key_meta = wg_meta()
    state = install_state()
    first = key_meta.get("first_device") or {}
    profile = first_device_profile()
    dns_state = state.get("wireguard_dns", "")
    dns_check = tunnel_dns_check(c, timeout=0.5) if up and dns_state == "enabled" else {"console": False, "forwarding": False, "detail": ""}
    stored = sorted(p.stem for p in stored_profiles_dir().glob("*.conf")) if stored_profiles_dir().is_dir() else []
    return {
        "interface": WG_IF,
        "up": up,
        # enabled | unavailable (with the installer's reason) | "" before the first install
        "state": state.get("wireguard", ""),
        "unavailable_reason": state.get("wireguard_reason", "") if state.get("wireguard") == "unavailable" else "",
        "address": f"{next(net.hosts())}/{net.prefixlen}",
        "listen_port": listen_port,
        "endpoint": f"{c.get('WG_ENDPOINT', '')}:{c.get('WG_PORT', '51820')}" if c.get("WG_ENDPOINT") else "",
        "public_key": server_public_key() if (WG_DIR / "server.key").exists() else "",
        "key_created_at": key_meta.get("created_at", ""),
        # The installer's first device; its profile file stays on the server until forgotten.
        "first_device": {"name": first.get("name", ""), "public_key": first.get("public_key", ""),
                         "profile_stored": profile.exists(), "profile_path": str(profile) if profile.exists() else ""} if first else {},
        # DNS inside the tunnel: profiles say `DNS = server`; the forwarder answers `name` with it.
        "dns": {"server": tunnel_ip(c), "name": ops_domain(c), "state": dns_state,
                "unavailable_reason": state.get("wireguard_dns_reason", "") if dns_state == "unavailable" else "",
                # answering: the console's name; forwarding: other names (devices browse through it).
                "answering": dns_check["console"], "forwarding": dns_check["forwarding"], "detail": dns_check["detail"]},
        "devices_without_dns": devices_without_dns(wg_peers()),
        # Profiles of `lumenctl wireguard add-device` still stored on the server (names only).
        "stored_profiles": stored,
        "peers": peers,
    }


def device_profile(*, name: str, private_key: str, address: str, server_public_key: str, psk: str, endpoint: str,
                   server_ip: str, ops: str, ops_port: str, dns: str) -> str:
    """A device's WireGuard profile. Split tunnel: only the server's tunnel address is routed into
    the tunnel (never the endpoint, which would break the handshake). With `dns`, the device asks
    the server's tunnel DNS, which points the console's name into the tunnel."""
    lines = [
        f"# Lumen operator access for {name}. Contains a PRIVATE KEY - keep it secret.",
        f"# Console: https://{ops}:{ops_port}/ (while this tunnel is connected)",
    ]
    if dns:
        lines += [
            f"# DNS = {dns}: no hosts-file edit needed. While the tunnel is up, this device sends ALL its",
            f"#   DNS lookups through the tunnel to your Lumen server, which answers {ops} with {server_ip}",
            "#   and forwards every other lookup to its own resolvers (Lumen does not log them).",
            f'#   Prefer a hosts file? Delete the DNS line and add "{server_ip} {ops}" to the hosts file.',
        ]
    else:
        lines += [
            f'# The console\'s name must lead into the tunnel on this device: add "{server_ip} {ops}" to',
            "#   /etc/hosts (Linux, macOS) or C:\\Windows\\System32\\drivers\\etc\\hosts (Windows).",
            "#   (This server's DNS in the tunnel did not answer when this profile was made.)",
        ]
    lines += ["[Interface]", f"PrivateKey = {private_key}", f"Address = {address}/32"]
    if dns:
        lines.append(f"DNS = {dns}")
    lines += [
        "",
        "[Peer]",
        f"PublicKey = {server_public_key}",
        f"PresharedKey = {psk}",
        f"Endpoint = {endpoint}",
        f"AllowedIPs = {server_ip}/32",
        "PersistentKeepalive = 25",
        "",
    ]
    return "\n".join(lines)


def _wg_add_peer_locked(name: str, client_pub: str, actor: str) -> dict:
    """Register a peer (caller holds wg_locked()). Server-generated keys unless client_pub is given."""
    peers = wg_peers()
    if any(p["name"] == name for p in peers):
        raise OpError("a peer with that name already exists")
    if client_pub and any(p["public_key"] == client_pub for p in peers):
        raise OpError("that public key is already registered")
    if WG_CONF.exists() and not wg_conf_is_lumen():
        raise OpError(f"{WG_CONF} was not written by Lumen; refusing to overwrite it")
    c = conf()
    net = ipaddress.ip_network(c.get("WG_SUBNET", DEFAULT_SUBNET))
    hosts = list(net.hosts())
    used = {p["address"] for p in peers} | {str(hosts[0])}
    address = next((str(h) for h in hosts[1:] if str(h) not in used), None)
    if address is None:
        raise OpError("no free addresses left in WG_SUBNET")
    client_priv = ""
    if not client_pub:
        client_priv = run(["wg", "genkey"]).stdout.strip()
        client_pub = run(["wg", "pubkey"], input_text=client_priv + "\n").stdout.strip()
    peer_id = base64.urlsafe_b64encode(os.urandom(9)).decode().rstrip("=")
    psk = run(["wg", "genpsk"]).stdout.strip()
    if not KEY_RE.match(client_pub) or not KEY_RE.match(psk):
        raise OpError("wg did not produce valid keys")
    server_ip = str(hosts[0])
    dns = server_ip if tunnel_dns_ready(c) else ""
    (WG_DIR / "psk").mkdir(mode=0o700, parents=True, exist_ok=True)
    psk_path = WG_DIR / "psk" / f"{peer_id}.psk"
    fd = os.open(psk_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(psk + "\n")
    peers.append(
        {
            "id": peer_id,
            "name": name,
            "public_key": client_pub,
            "address": address,
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "created_by": actor,
            "client_generated_key": not client_priv,
            # The DNS line of the profile issued here ("" = none); None: the device made its own key.
            "profile_dns": dns if client_priv else None,
        }
    )
    wg_save_peers(peers)
    wg_write_config(peers)
    wg_sync()
    endpoint_host = c.get("WG_ENDPOINT") or c.get("LUMEN_PRIMARY_DOMAIN", "")
    result = {"public_key": client_pub, "address": address, "server_public_key": server_public_key(),
              "endpoint": f"{endpoint_host}:{c.get('WG_PORT', '51820')}", "allowed_ips": f"{server_ip}/32", "dns": dns}
    profile = {"name": name, "address": address, "server_public_key": result["server_public_key"], "psk": psk,
               "endpoint": result["endpoint"], "server_ip": server_ip, "ops": ops_domain(c),
               "ops_port": c.get("LUMEN_OPS_PORT", "8443"), "dns": dns}
    if client_priv:
        result["config"] = device_profile(private_key=client_priv, **profile)
    else:
        result["psk"] = psk  # needed by the client; shown once
        # The rest of the device's configuration, for the operator to complete with its own key.
        result["client_config"] = device_profile(private_key="<the private key you generated on the device>", **profile)
    return result


def op_wg_add_peer(args: dict, actor: str) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    name = str(args.get("name", ""))
    if not NAME_RE.match(name):
        raise OpError("name must be 1-32 characters: letters, digits, '.', '_' or '-'")
    client_pub = str(args.get("public_key", "") or "").strip()
    if client_pub and not KEY_RE.match(client_pub):
        raise OpError("public_key is not a valid WireGuard key")
    with wg_locked():
        return _wg_add_peer_locked(name, client_pub, actor)


def op_wg_remove_peer(args: dict, actor: str) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    pub = str(args.get("public_key", "")).strip()
    if not KEY_RE.match(pub):
        raise OpError("public_key is not a valid WireGuard key")
    with wg_locked():
        if WG_CONF.exists() and not wg_conf_is_lumen():
            raise OpError(f"{WG_CONF} was not written by Lumen; refusing to overwrite it")
        peers = wg_peers()
        match = [p for p in peers if p["public_key"] == pub]
        if not match:
            raise OpError("unknown peer")
        peers = [p for p in peers if p["public_key"] != pub]
        (WG_DIR / "psk" / f"{match[0]['id']}.psk").unlink(missing_ok=True)
        wg_save_peers(peers)
        wg_write_config(peers)
        if interface_exists():
            run(["wg", "set", WG_IF, "peer", pub, "remove"], timeout=10)
            wg_sync()
    return {"removed": match[0]["name"]}


# --- installer helpers (command line only) ---------------------------------------


def host_networks() -> list[tuple[ipaddress.IPv4Network, str]]:
    """IPv4 networks this host already routes or has addresses in, with the device name."""
    nets: list[tuple[ipaddress.IPv4Network, str]] = []
    r = run(["ip", "-j", "-4", "route", "show", "table", "all"], timeout=10)
    try:
        routes = json.loads(r.stdout or "[]")
    except ValueError:
        routes = []
    for route in routes:
        dst = route.get("dst", "")
        if not dst or dst == "default" or route.get("type") in {"broadcast", "multicast", "unreachable", "prohibit", "blackhole"}:
            continue
        try:
            net = ipaddress.ip_network(dst if "/" in dst else f"{dst}/32", strict=False)
        except ValueError:
            continue
        if net.version == 4 and net.prefixlen > 0:
            nets.append((net, route.get("dev", "")))
    r = run(["ip", "-j", "-4", "addr", "show"], timeout=10)
    try:
        links = json.loads(r.stdout or "[]")
    except ValueError:
        links = []
    for link in links:
        for a in link.get("addr_info", []):
            try:
                net = ipaddress.ip_network(f"{a['local']}/{a.get('prefixlen', 32)}", strict=False)
            except (KeyError, ValueError):
                continue
            if net.version == 4:
                nets.append((net, link.get("ifname", "")))
    return nets


def host_addresses() -> set[str]:
    """Addresses assigned to this host's interfaces (any family)."""
    out: set[str] = set()
    r = run(["ip", "-j", "addr", "show"], timeout=10)
    try:
        links = json.loads(r.stdout or "[]")
    except ValueError:
        return out
    for link in links:
        for a in link.get("addr_info", []):
            if a.get("local"):
                out.add(a["local"])
    return out


def choose_subnet(current: str, in_use: list[tuple[ipaddress.IPv4Network, str]], candidates=SUBNET_CANDIDATES) -> tuple[str, str]:
    """(subnet, note): `current` when it overlaps nothing, otherwise the first free candidate."""
    cur = ipaddress.ip_network(current, strict=False)

    def clash(net):
        return next(((n, dev) for n, dev in in_use if net.overlaps(n)), None)

    hit = clash(cur)
    if hit is None:
        return str(cur), ""
    where = f"{hit[0]}" + (f" on {hit[1]}" if hit[1] else "")
    for cand in candidates:
        net = ipaddress.ip_network(cand)
        if net != cur and clash(net) is None:
            return str(net), f"{cur} overlaps {where} on this host"
    raise OpError(f"WG_SUBNET {cur} overlaps {where} and none of {', '.join(candidates)} is free; set WG_SUBNET in lumen.conf")


def lumen_subnet_in_use() -> str:
    """The subnet of Lumen's existing wg0.conf ('' if there is none): never moved once in use."""
    if not wg_conf_is_lumen():
        return ""
    for line in WG_CONF.read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() == "Address":
            try:
                return str(ipaddress.ip_interface(v.split(",")[0].strip()).network)
            except ValueError:
                return ""
    return ""


def resolve(name: str) -> set[str]:
    try:
        return {info[4][0] for info in socket.getaddrinfo(name, None, proto=socket.IPPROTO_UDP)}
    except (OSError, UnicodeError):
        return set()


def choose_endpoint(explicit: str, names: list[str], public_ip: str, lan_ip: str, local_ips: set[str], resolver=None) -> tuple[str, str]:
    """(endpoint host, note). WG_ENDPOINT if set; else a name that resolves to this server (its
    public address, also behind cloud NAT, or an address on one of its interfaces); else the
    public IPv4; else the LAN address."""
    if explicit:
        return explicit, "WG_ENDPOINT"
    resolver = resolver or resolve

    def usable(addr: str) -> bool:
        try:
            a = ipaddress.ip_address(addr.split("%")[0])
        except ValueError:
            return False
        return not (a.is_loopback or a.is_link_local or a.is_unspecified)

    mine = {a for a in local_ips if usable(a)} | ({public_ip} if public_ip and usable(public_ip) else set())
    for name in names:
        if not name or not HOST_RE.match(name):
            continue
        addrs = {a for a in resolver(name) if usable(a)}
        if addrs & mine:
            return name, f"{name} resolves to this server"
    if public_ip and usable(public_ip):
        return public_ip, "this server's public IPv4"
    if lan_ip and usable(lan_ip):
        return lan_ip, "this server's LAN address; set WG_ENDPOINT if devices connect from elsewhere"
    return "", ""


def wg_plan(public_ip: str = "", lan_ip: str = "") -> dict[str, str]:
    c = conf()
    plan = {"FOREIGN": foreign_reason(), "SUBNET": "", "SUBNET_NOTE": "", "ENDPOINT": "", "ENDPOINT_NOTE": ""}
    current = c.get("WG_SUBNET", DEFAULT_SUBNET) or DEFAULT_SUBNET
    live = lumen_subnet_in_use()
    if live:
        plan["SUBNET"] = live
        plan["SUBNET_NOTE"] = "in use by Lumen's wg0" if live != current else ""
    elif wg_peers():
        plan["SUBNET"] = current  # restored peers keep their addresses
    else:
        plan["SUBNET"], plan["SUBNET_NOTE"] = choose_subnet(current, host_networks())
    names = [c.get("LUMEN_PRIMARY_DOMAIN", "")]
    explicit = c.get("WG_ENDPOINT", "")
    # Devices already have the first choice in their profiles: keep it when lumen.conf lost it
    # (install.sh --config copies the operator's file again) instead of detecting anew.
    kept = "" if explicit else str(wg_meta().get("endpoint", ""))
    plan["ENDPOINT"], plan["ENDPOINT_NOTE"] = choose_endpoint(explicit or kept, names, public_ip, lan_ip, host_addresses())
    if kept:
        plan["ENDPOINT_NOTE"] = "kept from the first WireGuard setup; devices' profiles use it"
    return {k: " ".join(str(v).split()) for k, v in plan.items()}


FIRST_DEVICE_HEADER = """# Lumen Secure - WireGuard profile for the operator device "{name}", created by the installer on {date}.
# This file contains that device's PRIVATE KEY and its preshared key: treat it like a password.
#   1. Import it into the WireGuard app on your phone or computer
#      (QR code for a phone: sudo ./lumenctl wireguard show-profile).
#   2. Then delete it from the server: sudo ./lumenctl wireguard forget-profile
#      (the device keeps working; revoke it in the console or with lumenctl wireguard remove-peer).
"""

DEVICE_HEADER = """# Lumen Secure - WireGuard profile for the operator device "{name}", added on {date} (lumenctl wireguard add-device).
# This file contains that device's PRIVATE KEY and its preshared key: treat it like a password.
#   1. Import it into the WireGuard app (QR code for a phone: sudo ./lumenctl wireguard show-profile {name}).
#   2. Then delete it from the server: sudo ./lumenctl wireguard forget-profile {name}
#      (the device keeps working; revoke it in the console or with lumenctl wireguard remove-peer).
"""


def add_stored_device(name: str, actor: str = "lumenctl") -> dict:
    """A new device with server-generated keys whose profile is stored root-only (0600 in 0700)
    in stored_profiles_dir(), like the installer's first device. Returns no key material."""
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    if not NAME_RE.match(name) or name.strip(".") == "":
        raise OpError("name must be 1-32 characters: letters, digits, '.', '_' or '-'")
    out = stored_profiles_dir() / f"{name}.conf"
    with wg_locked():
        if out.exists():
            raise OpError(f"a stored profile named {name} already exists ({out})")
        result = _wg_add_peer_locked(name, "", actor)
        stored_profiles_dir().mkdir(mode=0o700, exist_ok=True)
        os.chmod(stored_profiles_dir(), 0o700)
        write_private(out, DEVICE_HEADER.format(name=name, date=datetime.now(UTC).strftime("%Y-%m-%d")) + result["config"])
    return {"name": name, "address": result["address"], "public_key": result["public_key"],
            "dns": result["dns"] or "none", "profile": str(out)}


def ensure_first_device(name: str, out: Path, actor: str = "installer") -> tuple[str, dict]:
    """Create the installer's first operator device once. Returns (created|exists|skipped, info)
    without any key material. Re-runs never add a second device and never generate new keys."""
    if not NAME_RE.match(name):
        raise OpError("name must be 1-32 characters: letters, digits, '.', '_' or '-'")
    if out.resolve().parent != WG_DIR.resolve():
        raise OpError(f"the profile must be stored in {WG_DIR} (root only)")
    with wg_locked():
        meta = wg_meta()
        if meta.get("first_device"):
            return "exists", {k: meta["first_device"].get(k, "") for k in ("name", "address", "public_key")}
        peers = wg_peers()
        if peers:
            return "skipped", {"reason": f"{len(peers)} device(s) already registered"}
        result = _wg_add_peer_locked(name, "", actor)
        header = FIRST_DEVICE_HEADER.format(name=name, date=datetime.now(UTC).strftime("%Y-%m-%d"))
        write_private(out, header + result["config"])
        record = {"name": name, "address": result["address"], "public_key": result["public_key"],
                  "created_at": datetime.now(UTC).isoformat(timespec="seconds")}
        meta = wg_meta()
        meta["first_device"] = record
        wg_save_meta(meta)
    return "created", {k: record[k] for k in ("name", "address", "public_key")}


# --------------------------------------------------------------------------------
# Backups, updates, diagnostics, services
# --------------------------------------------------------------------------------

_jobs_lock = threading.Lock()
_jobs: dict[str, subprocess.Popen] = {}


def status_file(name: str) -> dict:
    c = conf()
    path = Path(c.get("LUMEN_DATA_DIR", "/var/lib/lumen")) / "status" / f"{name}.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def running_job() -> str:
    with _jobs_lock:
        for name, proc in list(_jobs.items()):
            if proc.poll() is None:
                return name
            _jobs.pop(name, None)
    return ""


def start_job(name: str, argv: list[str]) -> dict:
    with _jobs_lock:
        for proc in _jobs.values():
            if proc.poll() is None:
                raise OpError("another backup/restore job is already running")
        log_dir = Path("/var/log/lumen")
        log_dir.mkdir(parents=True, exist_ok=True)
        out = open(log_dir / f"agent-{name}.log", "ab")  # noqa: SIM115 - kept open for the child
        proc = subprocess.Popen(argv, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        _jobs[name] = proc
    return {"job": f"{name}-{proc.pid}"}


def op_backup_status(args: dict) -> dict:
    data = status_file("backup")
    data["running"] = running_job()
    return data


def human(n: int) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def op_backup_list(args: dict) -> dict:
    c = conf()
    d = Path(c.get("BACKUP_DIR", "/var/backups/lumen"))
    items = []
    if d.is_dir():
        for f in sorted(d.glob("lumen-*.tar.age"), reverse=True)[:50]:
            items.append({"name": f.name, "size": f.stat().st_size, "size_human": human(f.stat().st_size)})
    return {"destination": str(d), "backups": items, "retention": f"{c.get('BACKUP_KEEP_DAILY', '7')} daily + {c.get('BACKUP_KEEP_WEEKLY', '4')} weekly"}


def op_backup_run(args: dict) -> dict:
    return start_job("backup", [str(repo_dir() / "backup.sh"), "--quiet"])


def op_backup_verify(args: dict) -> dict:
    return start_job("verify", [str(repo_dir() / "restore.sh"), "--verify-only", "latest"])


def op_update_status(args: dict) -> dict:
    return status_file("update")


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def op_diagnose(args: dict) -> dict:
    r = run([str(repo_dir() / "diagnose.sh"), "--no-color"], timeout=110)
    return {"exit_code": r.returncode, "output": ANSI.sub("", (r.stdout + r.stderr))[-20000:]}


def op_calls_selftest(args: dict) -> dict:
    """Real audio+video through the SFU (LiveKit load tester on the internal network)."""
    r = run([str(repo_dir() / "lumenctl"), "calls-selftest"], timeout=150)
    out = ANSI.sub("", r.stdout + r.stderr)
    return {"ok": r.returncode == 0, "output": out[-4000:]}


def op_service_restart(args: dict) -> dict:
    svc = str(args.get("service", ""))
    if svc not in RESTARTABLE:
        raise OpError("service not restartable")
    r = run(compose_argv("restart", svc), timeout=120)
    if r.returncode != 0:
        raise OpError(f"restart failed: {r.stderr.strip()[-200:]}")
    state = ""
    for _ in range(30):
        cs = {c["service"]: c for c in containers()}
        c = cs.get(svc, {})
        state = c.get("health") or c.get("state") or "missing"
        if state in {"healthy", "running"} and (c.get("health") in {"", "healthy"}):
            break
        time.sleep(3)
    return {"service": svc, "state": state}


def op_ping(args: dict) -> dict:
    return {"pong": True, "version": "1"}


OPS = {
    "ping": op_ping,
    "host.status": op_host_status,
    "wg.status": op_wg_status,
    "wg.add_peer": op_wg_add_peer,
    "wg.remove_peer": op_wg_remove_peer,
    "backup.status": op_backup_status,
    "backup.list": op_backup_list,
    "backup.run": op_backup_run,
    "backup.verify": op_backup_verify,
    "update.status": op_update_status,
    "diagnose.run": op_diagnose,
    "service.restart": op_service_restart,
    "calls.selftest": op_calls_selftest,
}
NEEDS_ACTOR = {"wg.add_peer", "wg.remove_peer"}


def handle_request(raw: bytes, peer_uid: int) -> dict:
    if peer_uid not in ALLOWED_UIDS:
        return {"ok": False, "error": "peer not allowed"}
    try:
        req = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "error": "malformed request"}
    if not isinstance(req, dict):
        return {"ok": False, "error": "malformed request"}
    op = req.get("op")
    args = req.get("args") or {}
    actor = str(req.get("actor", ""))[:64]
    rid = str(req.get("id", ""))[:64]
    if op not in OPS or not isinstance(args, dict):
        log.warning("rejected op=%r actor=%s uid=%s", op, actor, peer_uid)
        return {"id": rid, "ok": False, "error": "operation not allowed"}
    try:
        result = OPS[op](args, actor) if op in NEEDS_ACTOR else OPS[op](args)
    except OpError as exc:
        log.info("op=%s actor=%s uid=%s result=error %s", op, actor, peer_uid, exc)
        return {"id": rid, "ok": False, "error": str(exc)}
    except subprocess.TimeoutExpired:
        log.warning("op=%s actor=%s timed out", op, actor)
        return {"id": rid, "ok": False, "error": "operation timed out"}
    except Exception as exc:  # noqa: BLE001
        log.exception("op=%s actor=%s failed", op, actor)
        return {"id": rid, "ok": False, "error": f"internal error ({type(exc).__name__})"}
    safe = {k: ("[secret]" if k in {"config", "psk", "client_config"} else v) for k, v in result.items()} if isinstance(result, dict) else {}
    log.info("op=%s actor=%s uid=%s result=ok %s", op, actor, peer_uid, json.dumps(safe)[:300] if op.startswith("wg.add") else "")
    return {"id": rid, "ok": True, "result": result}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        creds = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        self.request.settimeout(130)
        raw = self.rfile.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            response = {"ok": False, "error": "request too large"}
        else:
            response = handle_request(raw, uid)
        self.wfile.write(json.dumps(response).encode() + b"\n")


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def ensure_wireguard_server_key() -> None:
    """Server key (generated here once, never printed) and wg0.conf regenerated from it."""
    if not wg_enabled():
        return
    with wg_locked():
        if WG_CONF.exists() and not wg_conf_is_lumen():
            raise OpError(f"{WG_CONF} was not written by Lumen; refusing to overwrite it")
        key = WG_DIR / "server.key"
        if not key.exists():
            private = run(["wg", "genkey"]).stdout.strip()
            if not KEY_RE.match(private):
                raise OpError("wg genkey failed")
            fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(private + "\n")
            meta = wg_meta()
            meta["created_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            wg_save_meta(meta)
        endpoint = conf().get("WG_ENDPOINT", "")
        meta = wg_meta()
        if endpoint and meta.get("endpoint") != endpoint:
            meta["endpoint"] = endpoint  # what device profiles are issued with (see wg_plan)
            wg_save_meta(meta)
        wg_write_config(wg_peers())


def cli(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="lumen_agent.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-wireguard")
    p = sub.add_parser("wg-plan")
    p.add_argument("--public-ip", default="")
    p.add_argument("--lan-ip", default="")
    p = sub.add_parser("wg-first-peer")
    p.add_argument("--name", required=True)
    p.add_argument("--out", required=True, type=Path)
    p = sub.add_parser("wg-add-device")
    p.add_argument("--name", required=True)
    sub.add_parser("wg-dns-setup")
    p = sub.add_parser("wg-dns-check")
    p.add_argument("--wait", type=float, default=0.0, help="keep trying for this many seconds")
    sub.add_parser("wg-dns-info")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "init-wireguard":
            ensure_wireguard_server_key()
            print(server_public_key())
        elif a.cmd == "wg-plan":
            for k, v in wg_plan(a.public_ip, a.lan_ip).items():
                print(f"{k}={v}")
        elif a.cmd == "wg-first-peer":
            if not wg_enabled():
                raise OpError("WireGuard is disabled on this server")
            status, info = ensure_first_device(a.name, a.out)
            print(status, *[str(v) for v in info.values()])
        elif a.cmd == "wg-add-device":
            info = add_stored_device(a.name)
            print("created", *[str(v) for v in info.values()])
        elif a.cmd == "wg-dns-setup":
            for k, v in write_dns_config().items():
                print(f"{k}={' '.join(str(v).split())}")
        elif a.cmd == "wg-dns-check":
            # Exit 0: the console's name and forwarding work; 2: no answer for the console's name;
            # 3: the console's name works but other names aren't forwarded.
            c = conf()
            deadline = time.monotonic() + a.wait
            while True:
                check = tunnel_dns_check(c)
                if (check["console"] and check["forwarding"]) or time.monotonic() >= deadline:
                    break
                time.sleep(1)
            if not check["console"]:
                raise OpError(f"no answer for {ops_domain(c)} from the tunnel DNS on {tunnel_ip(c)}:53 ({check['detail']})")
            if not check["forwarding"]:
                print(f"error: forwarding fails: {check['detail']}", file=sys.stderr)
                return 3
            print(f"ok {ops_domain(c)} -> {tunnel_ip(c)} on {tunnel_ip(c)}:53; forwarding: {check['detail']}")
        elif a.cmd == "wg-dns-info":
            c = conf()
            state = install_state()
            check = tunnel_dns_check(c) if interface_exists() else {"console": False, "forwarding": False, "detail": "wg0 is down"}
            info = {"SERVER": tunnel_ip(c), "NAME": ops_domain(c), "STATE": state.get("wireguard_dns", ""),
                    "REASON": state.get("wireguard_dns_reason", ""),
                    "ANSWERING": "1" if check["console"] else "0", "FORWARDING": "1" if check["forwarding"] else "0",
                    "DETAIL": check["detail"], "WITHOUT_DNS": ",".join(devices_without_dns(wg_peers()))}
            for k, v in info.items():
                print(f"{k}={' '.join(str(v).split())}")
    except OpError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    SOCKET_DIR.mkdir(mode=0o750, parents=True, exist_ok=True)
    try:
        gid = grp.getgrgid(SOCKET_GID).gr_gid
    except KeyError:
        gid = SOCKET_GID
    os.chown(SOCKET_DIR, 0, gid)
    os.chmod(SOCKET_DIR, 0o750)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    old = os.umask(0o117)
    server = Server(str(SOCKET_PATH), Handler)
    os.umask(old)
    os.chown(SOCKET_PATH, 0, gid)
    os.chmod(SOCKET_PATH, 0o660)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    log.info("lumen-agent listening on %s", SOCKET_PATH)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
