"""Health probes executed by the worker.

Each probe returns a ``ProbeResult`` built only from what was actually
observed. No probe ever reports "ok" for something it did not check:

* federation is "ok" only when a *remote* notary server fetched our signing
  keys over federation (or federation is disabled by policy);
* TLS is checked by connecting to the public endpoints;
* email is checked with an SMTP EHLO/STARTTLS handshake (no message sent).
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import smtplib
import socket
import ssl
import struct
import subprocess
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

import requests
from django.conf import settings
from django.db import connection
from django.utils import timezone


@dataclass
class ProbeResult:
    status: str  # ok | degraded | failed | unknown
    summary: str
    detail: dict = field(default_factory=dict)
    latency_ms: int | None = None


def _session() -> requests.Session:
    s = requests.Session()
    s.trust_env = False
    ca = os.environ.get("LUMEN_PROBE_CA_BUNDLE")
    if ca:
        s.verify = ca
    s.headers["User-Agent"] = f"lumen-healthcheck/{settings.LUMEN_VERSION}"
    return s


def _timed(fn):
    start = time.monotonic()
    result = fn()
    if result.latency_ms is None:
        result.latency_ms = int((time.monotonic() - start) * 1000)
    return result


# --- internal services -----------------------------------------------------------


def _http_ok(url: str, expect_text: str | None = None) -> ProbeResult:
    try:
        r = _session().get(url, timeout=5)
    except requests.RequestException as exc:
        return ProbeResult("failed", f"unreachable ({type(exc).__name__})")
    if r.status_code != 200:
        return ProbeResult("failed", f"HTTP {r.status_code}")
    if expect_text is not None and r.text.strip() != expect_text:
        return ProbeResult("degraded", "unexpected response body")
    return ProbeResult("ok", "responding")


def probe_website() -> ProbeResult:
    return _http_ok(os.environ.get("LUMEN_PORTAL_INTERNAL_URL", "http://portal:8000") + "/healthz")


def probe_ops() -> ProbeResult:
    return _http_ok(os.environ.get("LUMEN_OPS_INTERNAL_URL", "http://ops:8000") + "/healthz")


def probe_homeserver() -> ProbeResult:
    return _http_ok(settings.SYNAPSE_INTERNAL_URL + "/health", expect_text="OK")


def probe_database() -> ProbeResult:
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT pg_database_size(current_database()), (SELECT count(*) FROM pg_stat_activity)")
            size, conns = cur.fetchone()
    except Exception as exc:
        return ProbeResult("failed", f"query failed ({type(exc).__name__})")
    return ProbeResult("ok", f"{size / 1024 / 1024:.0f} MB portal database, {conns} connections", {"size_bytes": size, "connections": conns})


def probe_chat_app() -> ProbeResult:
    try:
        r = _session().get(settings.APP_BASE_URL + "/config.json", timeout=8)
    except requests.RequestException as exc:
        return ProbeResult("failed", f"unreachable ({type(exc).__name__})")
    if r.status_code != 200:
        return ProbeResult("failed", f"HTTP {r.status_code}")
    try:
        cfg = r.json()
    except ValueError:
        return ProbeResult("failed", "config.json is not valid JSON")
    if cfg.get("homeserver", {}).get("base_url", "").rstrip("/") != settings.MATRIX_BASE_URL.rstrip("/"):
        return ProbeResult("degraded", "chat app points to a different homeserver", {"configured": cfg.get("homeserver")})
    return ProbeResult("ok", "served over HTTPS with the expected configuration")


# --- TLS ---------------------------------------------------------------------------


def _cert_seconds_left(host: str, port: int = 443) -> tuple[int, str]:
    ctx = ssl.create_default_context(cafile=os.environ.get("LUMEN_PROBE_CA_BUNDLE") or None)
    with socket.create_connection((os.environ.get("LUMEN_PROBE_CONNECT_HOST", host), port), timeout=8) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
            version = tls.version() or ""
    not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=UTC)
    return int((not_after - datetime.now(UTC)).total_seconds()), version


def _human(seconds: int) -> str:
    return f"{seconds // 86400}d" if seconds >= 86400 else f"{max(seconds, 0) // 3600}h"


_GROUP_RE = re.compile(r"Negotiated TLS1\.3 group: (\S+)")
HYBRID_PQ_GROUPS = {"X25519MLKEM768", "SecP256r1MLKEM768", "SecP384r1MLKEM1024"}


def negotiated_group(host: str, port: int = 443) -> str | None:
    """Key-exchange group the server actually picks when offered hybrid ML-KEM
    first and classical X25519 second (measured with the OpenSSL 3.5 CLI; Python's
    ssl module cannot report it). None if it could not be measured."""
    openssl = "/usr/bin/openssl"
    if not os.path.exists(openssl):
        return None
    connect = os.environ.get("LUMEN_PROBE_CONNECT_HOST", host)
    cmd = [openssl, "s_client", "-connect", f"{connect}:{port}", "-servername", host,
           "-groups", "X25519MLKEM768:X25519", "-brief", "-verify_quiet"]
    try:
        out = subprocess.run(cmd, input=b"", capture_output=True, timeout=10, check=False)  # nosec B603 - fixed argv, no shell
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = _GROUP_RE.search(out.stdout.decode(errors="replace") + out.stderr.decode(errors="replace"))
    return m.group(1) if m else None


def probe_tls() -> ProbeResult:
    hosts = sorted({settings.PRIMARY_DOMAIN, settings.APP_DOMAIN, settings.MATRIX_DOMAIN})
    # Public (ACME) certificates last ~90 days and renew 30 days early, so less than
    # 14 days left means renewal is failing. Caddy's internal CA (TLS_MODE=internal,
    # labs only) issues 12-hour certificates renewed continuously.
    if settings.TLS_MODE == "internal":
        fail_below, warn_below = 3600, 3 * 3600
    else:
        fail_below, warn_below = 3 * 86400, 14 * 86400
    detail, worst, problems = {"mode": settings.TLS_MODE}, "ok", []
    left: list[int] = []
    for host in hosts:
        try:
            secs, version = _cert_seconds_left(host)
        except (OSError, ssl.SSLError, ValueError) as exc:
            detail[host] = {"error": f"{type(exc).__name__}: {str(exc)[:120]}"}
            worst = "failed"
            problems.append(f"{host}: {type(exc).__name__}")
            continue
        group = negotiated_group(host)
        detail[host] = {"days_left": secs // 86400, "seconds_left": secs, "tls_version": version, "key_exchange": group}
        left.append(secs)
        if secs < fail_below:
            worst = "failed"
            problems.append(f"{host} expires in {_human(secs)}")
        elif secs < warn_below and worst == "ok":
            worst = "degraded"
            problems.append(f"{host} expires in {_human(secs)}")
    groups = {v.get("key_exchange") for k, v in detail.items() if isinstance(v, dict) and "seconds_left" in v}
    detail["hybrid_pq_key_exchange"] = bool(groups) and groups <= HYBRID_PQ_GROUPS
    if worst == "ok":
        note = " (internal test CA)" if settings.TLS_MODE == "internal" else ""
        kex = "; hybrid post-quantum key exchange (" + ", ".join(sorted(groups)) + ")" if detail["hybrid_pq_key_exchange"] else ""
        return ProbeResult("ok", f"valid on {len(hosts)} hostnames; earliest expiry in {_human(min(left))}{note}{kex}", detail)
    return ProbeResult(worst, "; ".join(problems), detail)


# --- federation --------------------------------------------------------------------


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _b64decode_unpadded(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4))


def verify_server_keys(server_name: str, keys: dict) -> tuple[bool, str]:
    """Verify the self-signature of a /_matrix/key/v2/server response."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    sigs = (keys.get("signatures") or {}).get(server_name) or {}
    verify_keys = keys.get("verify_keys") or {}
    if not sigs or not verify_keys:
        return False, "response has no signatures or verify_keys"
    unsigned = {k: v for k, v in keys.items() if k not in {"signatures", "unsigned"}}
    message = canonical_json(unsigned)
    for key_id, sig in sigs.items():
        vk = verify_keys.get(key_id)
        if not vk or not key_id.startswith("ed25519:"):
            continue
        try:
            Ed25519PublicKey.from_public_bytes(_b64decode_unpadded(vk["key"])).verify(_b64decode_unpadded(sig), message)
            return True, key_id
        except (InvalidSignature, ValueError, KeyError):
            return False, f"signature by {key_id} does not verify"
    return False, "no ed25519 signature matched a verify key"


def probe_federation() -> ProbeResult:
    if settings.FEDERATION_MODE == "closed":
        return ProbeResult("ok", "federation disabled by policy", {"mode": "closed"})
    s = _session()
    server_name = settings.MATRIX_SERVER_NAME
    detail: dict = {"mode": settings.FEDERATION_MODE}
    # 1. Discovery (.well-known delegation)
    try:
        r = s.get(f"https://{server_name}/.well-known/matrix/server", timeout=8)
        delegated = r.json().get("m.server") if r.status_code == 200 else None
    except (requests.RequestException, ValueError) as exc:
        return ProbeResult("failed", f".well-known/matrix/server unreachable ({type(exc).__name__})", detail)
    if not delegated:
        return ProbeResult("failed", ".well-known/matrix/server missing or invalid", detail)
    detail["delegated_to"] = delegated
    host, _, port = delegated.partition(":")
    base = f"https://{host}:{port or 8448}"
    # 2. Federation API + signing keys
    try:
        ver = s.get(f"{base}/_matrix/federation/v1/version", timeout=8)
        keys = s.get(f"{base}/_matrix/key/v2/server", timeout=8)
    except requests.RequestException as exc:
        return ProbeResult("failed", f"federation endpoint unreachable ({type(exc).__name__})", detail)
    if ver.status_code != 200 or keys.status_code != 200:
        return ProbeResult("failed", f"federation API returned {ver.status_code}/{keys.status_code}", detail)
    try:
        key_doc = keys.json()
        detail["server"] = ver.json().get("server", {})
    except ValueError:
        return ProbeResult("failed", "federation API returned invalid JSON", detail)
    ok, info = verify_server_keys(server_name, key_doc)
    detail["self_signature"] = info
    if not ok:
        return ProbeResult("failed", f"signing keys do not verify: {info}", detail)
    # 3. External reachability through a remote notary
    notary = settings.FEDERATION_PROBE_NOTARY
    if not notary:
        return ProbeResult(
            "unknown",
            "discovery and signing keys verified locally; external reachability not verified (no probe notary configured)",
            detail,
        )
    try:
        r = s.post(
            f"https://{notary}/_matrix/key/v2/query",
            # Name our key IDs explicitly (a query for "all keys" makes a notary return
            # only what it has cached). Requiring validity 12h ahead makes the notary
            # re-fetch from us unless it did so within roughly the last 12 hours.
            json={"server_keys": {server_name: {key_id: {"minimum_valid_until_ts": int(time.time() * 1000) + 12 * 3600 * 1000} for key_id in (key_doc.get("verify_keys") or {})}}},
            timeout=20,
        )
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        return ProbeResult("degraded", f"notary {notary} unreachable ({type(exc).__name__}); local checks passed", detail)
    remote = [k for k in data.get("server_keys", []) if k.get("server_name") == server_name]
    our_ids = set((key_doc.get("verify_keys") or {}).keys())
    if remote and our_ids & set((remote[0].get("verify_keys") or {}).keys()):
        detail["notary"] = notary
        return ProbeResult("ok", f"{notary} fetched our signing keys over federation", detail)
    return ProbeResult("failed", f"{notary} could not fetch our signing keys (HTTP {r.status_code})", detail)


# --- email, TURN, backups, disk, billing ----------------------------------------------------


def probe_email() -> ProbeResult:
    if not settings.SMTP_HOST:
        return ProbeResult("unknown", "SMTP not configured — email verification and password reset by email are disabled")
    try:
        if getattr(settings, "EMAIL_USE_SSL", False):
            smtp = smtplib.SMTP_SSL(settings.EMAIL_HOST, settings.EMAIL_PORT, timeout=10)
        else:
            smtp = smtplib.SMTP(settings.EMAIL_HOST, settings.EMAIL_PORT, timeout=10)
        with smtp:
            smtp.ehlo()
            if getattr(settings, "EMAIL_USE_TLS", False):
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            if settings.EMAIL_HOST_USER:
                smtp.login(settings.EMAIL_HOST_USER, settings.EMAIL_HOST_PASSWORD)
    except (OSError, smtplib.SMTPException) as exc:
        return ProbeResult("failed", f"SMTP check failed: {type(exc).__name__}")
    return ProbeResult("ok", f"SMTP handshake{' and login' if settings.EMAIL_HOST_USER else ''} succeeded")


def probe_turn() -> ProbeResult:
    if not settings.VOIP_ENABLED:
        return ProbeResult("unknown", "voice/video disabled")
    host = os.environ.get("TURN_PROBE_HOST", "127.0.0.1")
    port = int(os.environ.get("TURN_PROBE_PORT", "3478"))
    txid = os.urandom(12)
    request = struct.pack("!HHI12s", 0x0001, 0, 0x2112A442, txid)  # STUN Binding Request
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(3)
            s.sendto(request, (host, port))
            data, _ = s.recvfrom(2048)
    except OSError as exc:
        return ProbeResult("failed", f"no STUN response from {host}:{port} ({type(exc).__name__})")
    if len(data) >= 20 and struct.unpack("!H", data[:2])[0] == 0x0101 and data[8:20] == txid:
        return ProbeResult("ok", f"STUN binding response from {host}:{port}")
    return ProbeResult("degraded", "unexpected STUN response")


def probe_backups() -> ProbeResult:
    path = settings.STATUS_DIR / "backup.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ProbeResult("failed", "no backup has been recorded yet")
    last_ok = data.get("last_success_at")
    if data.get("last_result") == "failed":
        return ProbeResult("failed", f"last backup failed: {data.get('last_error', 'unknown error')[:120]}", data)
    if not last_ok:
        return ProbeResult("failed", "no successful backup yet", data)
    age_h = (timezone.now() - datetime.fromisoformat(last_ok)).total_seconds() / 3600
    verified = data.get("last_verified_at")
    note = f"last backup {age_h:.0f}h ago" + ("" if verified else "; restore not yet verified")
    if age_h > 72:
        return ProbeResult("failed", note, data)
    if age_h > 26 or not verified:
        return ProbeResult("degraded", note, data)
    return ProbeResult("ok", note, data)


def probe_disk() -> ProbeResult:
    target = os.environ.get("LUMEN_DISK_PROBE_PATH", str(settings.STATUS_DIR))
    try:
        usage = shutil.disk_usage(target)
    except OSError as exc:
        return ProbeResult("unknown", f"cannot stat {target}: {exc}")
    pct = usage.used * 100 / usage.total
    detail = {"total_gb": round(usage.total / 1e9, 1), "free_gb": round(usage.free / 1e9, 1), "used_pct": round(pct, 1)}
    status = "ok" if pct < 80 else "degraded" if pct < 90 else "failed"
    return ProbeResult(status, f"{pct:.0f}% used, {usage.free / 1e9:.1f} GB free", detail)


def probe_billing() -> ProbeResult:
    from datetime import timedelta

    from apps.billing.models import WebhookEvent
    from apps.billing.providers import get_provider

    provider = get_provider()
    if provider.name == "none":
        return ProbeResult("unknown", "no payment provider (free plan only)")
    if not provider.is_configured():
        return ProbeResult("failed", f"{provider.label} selected but not configured")
    if provider.name == "manual":
        return ProbeResult("ok", "manual billing")
    day = timezone.now() - timedelta(days=1)
    failed = WebhookEvent.objects.filter(received_at__gte=day, outcome__in=["failed", "rejected"]).count()
    last = WebhookEvent.objects.filter(outcome__in=["processed", "ignored"]).first()
    detail = {"failed_24h": failed, "last_event_at": last.received_at.isoformat() if last else None}
    if failed:
        return ProbeResult("degraded", f"{failed} webhook(s) failed or were rejected in 24h", detail)
    if last is None:
        return ProbeResult("unknown", "configured; no webhook received yet", detail)
    return ProbeResult("ok", "configured; webhooks processing", detail)


PROBES = {
    "website": probe_website,
    "ops": probe_ops,
    "homeserver": probe_homeserver,
    "database": probe_database,
    "chat_app": probe_chat_app,
    "tls": probe_tls,
    "federation": probe_federation,
    "email": probe_email,
    "turn": probe_turn,
    "backups": probe_backups,
    "disk": probe_disk,
    "billing": probe_billing,
}


def run_probe(name: str) -> ProbeResult:
    try:
        return _timed(PROBES[name])
    except Exception as exc:  # a broken probe must not crash the worker
        return ProbeResult("unknown", f"probe error: {type(exc).__name__}: {str(exc)[:150]}")
