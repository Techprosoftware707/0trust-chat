"""Client for the host agent (root, systemd) over a Unix socket.

The agent exposes a fixed allowlist of operations (status, WireGuard peers,
backups, diagnostics, service restarts). The Docker socket is never mounted
into containers; this narrow socket is the only path from the console to the
host.
"""

from __future__ import annotations

import json
import socket
import uuid
from pathlib import Path

from django.conf import settings

ALLOWED_OPS = {
    "ping",
    "host.status",
    "wg.status",
    "wg.add_peer",
    "wg.remove_peer",
    "backup.status",
    "backup.list",
    "backup.run",
    "backup.verify",
    "update.status",
    "diagnose.run",
    "service.restart",
    "calls.selftest",
    "tls.probe",
}


class AgentError(Exception):
    pass


class AgentUnavailable(AgentError):
    pass


def call(op: str, args: dict | None = None, *, actor: str = "", timeout: float = 15.0) -> dict:
    if op not in ALLOWED_OPS:
        raise AgentError(f"operation {op!r} is not allowed")
    path = Path(settings.HOST_AGENT_SOCKET)
    if not path.exists():
        raise AgentUnavailable("Host agent socket not found. Is lumen-agent running on the host?")
    payload = json.dumps({"id": uuid.uuid4().hex, "op": op, "args": args or {}, "actor": actor[:64]}).encode() + b"\n"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(path))
            s.sendall(payload)
            chunks = []
            total = 0
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > 4 * 1024 * 1024:
                    raise AgentError("agent response too large")
                if chunk.endswith(b"\n"):
                    break
    except (OSError, TimeoutError) as exc:
        raise AgentUnavailable(f"Host agent unreachable: {exc}") from exc
    try:
        data = json.loads(b"".join(chunks).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise AgentError("malformed agent response") from exc
    if not data.get("ok"):
        raise AgentError(data.get("error", "agent operation failed"))
    return data.get("result", {})


def safe_call(op: str, args: dict | None = None, **kwargs) -> tuple[dict | None, str]:
    try:
        return call(op, args, **kwargs), ""
    except AgentError as exc:
        return None, str(exc)
