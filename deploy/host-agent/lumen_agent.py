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
    or logged; every operation is logged without secrets.
"""

from __future__ import annotations

import base64
import grp
import ipaddress
import json
import logging
import os
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
_wg_lock = threading.Lock()


def wg_enabled() -> bool:
    return conf().get("WIREGUARD_ENABLED", "false").lower() in {"1", "true", "yes", "on"}


def wg_peers() -> list[dict]:
    try:
        return json.loads((WG_DIR / "peers.json").read_text())
    except (OSError, ValueError):
        return []


def wg_save_peers(peers: list[dict]) -> None:
    WG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = WG_DIR / "peers.json.tmp"
    tmp.write_text(json.dumps(peers, indent=2))
    os.chmod(tmp, 0o600)
    os.replace(tmp, WG_DIR / "peers.json")


def wg_write_config(peers: list[dict]) -> None:
    """Regenerate wg0.conf from the server key and peer list (mode 0600)."""
    c = conf()
    net = ipaddress.ip_network(c.get("WG_SUBNET", "10.77.0.0/24"))
    server_ip = next(net.hosts())
    private = (WG_DIR / "server.key").read_text().strip()
    lines = [
        "# Managed by Lumen (lumen-agent). Manual edits are overwritten.",
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


def op_wg_status(args: dict) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    c = conf()
    peers_meta = {p["public_key"]: p for p in wg_peers()}
    live: dict[str, dict] = {}
    listen_port = c.get("WG_PORT", "51820")
    up = interface_exists()
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
        peers.append({"public_key": pub, "name": meta.get("name", ""), "allowed_ips": f"{meta.get('address', '?')}/32", **live.get(pub, {"latest_handshake": 0, "rx_bytes": 0, "tx_bytes": 0, "preshared_key": bool(meta)})})
    net = ipaddress.ip_network(c.get("WG_SUBNET", "10.77.0.0/24"))
    key_meta = {}
    try:
        key_meta = json.loads((WG_DIR / "server.json").read_text())
    except (OSError, ValueError):
        pass
    return {
        "interface": WG_IF,
        "up": up,
        "address": f"{next(net.hosts())}/{net.prefixlen}",
        "listen_port": listen_port,
        "public_key": server_public_key() if (WG_DIR / "server.key").exists() else "",
        "key_created_at": key_meta.get("created_at", ""),
        "peers": peers,
    }


def op_wg_add_peer(args: dict, actor: str) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    name = str(args.get("name", ""))
    if not NAME_RE.match(name):
        raise OpError("name must be 1-32 characters: letters, digits, '.', '_' or '-'")
    client_pub = str(args.get("public_key", "") or "").strip()
    if client_pub and not KEY_RE.match(client_pub):
        raise OpError("public_key is not a valid WireGuard key")
    with _wg_lock:
        peers = wg_peers()
        if any(p["name"] == name for p in peers):
            raise OpError("a peer with that name already exists")
        if client_pub and any(p["public_key"] == client_pub for p in peers):
            raise OpError("that public key is already registered")
        c = conf()
        net = ipaddress.ip_network(c.get("WG_SUBNET", "10.77.0.0/24"))
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
            }
        )
        wg_save_peers(peers)
        wg_write_config(peers)
        wg_sync()
    endpoint_host = c.get("WG_ENDPOINT") or c.get("LUMEN_PRIMARY_DOMAIN", "")
    ops_domain = c.get("LUMEN_OPS_DOMAIN") or f"ops.{c.get('LUMEN_PRIMARY_DOMAIN', '')}"
    server_ip = str(next(net.hosts()))
    result = {"public_key": client_pub, "address": address, "server_public_key": server_public_key(), "endpoint": f"{endpoint_host}:{c.get('WG_PORT', '51820')}"}
    if client_priv:
        result["config"] = "\n".join(
            [
                f"# Lumen operator access for {name}. Contains a PRIVATE KEY - keep it secret.",
                f"# Add to /etc/hosts on this device:  {server_ip} {ops_domain}",
                f"# Console: https://{ops_domain}:{c.get('LUMEN_OPS_PORT', '8443')}/",
                "[Interface]",
                f"PrivateKey = {client_priv}",
                f"Address = {address}/32",
                "",
                "[Peer]",
                f"PublicKey = {result['server_public_key']}",
                f"PresharedKey = {psk}",
                f"Endpoint = {result['endpoint']}",
                f"AllowedIPs = {server_ip}/32",
                "PersistentKeepalive = 25",
                "",
            ]
        )
    else:
        result["psk"] = psk  # needed by the client; shown once
    return result


def op_wg_remove_peer(args: dict, actor: str) -> dict:
    if not wg_enabled():
        raise OpError("WireGuard is disabled on this server")
    pub = str(args.get("public_key", "")).strip()
    if not KEY_RE.match(pub):
        raise OpError("public_key is not a valid WireGuard key")
    with _wg_lock:
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
    safe = {k: ("[secret]" if k in {"config", "psk"} else v) for k, v in result.items()} if isinstance(result, dict) else {}
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
    if not wg_enabled():
        return
    WG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = WG_DIR / "server.key"
    if not key.exists():
        private = run(["wg", "genkey"]).stdout.strip()
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(private + "\n")
        (WG_DIR / "server.json").write_text(json.dumps({"created_at": datetime.now(UTC).isoformat(timespec="seconds")}))
    if not WG_CONF.exists():
        wg_write_config(wg_peers())


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    if len(sys.argv) > 1 and sys.argv[1] == "init-wireguard":
        ensure_wireguard_server_key()
        print(server_public_key())
        return 0
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
