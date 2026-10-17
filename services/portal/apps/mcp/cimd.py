"""OAuth Client ID Metadata Documents (CIMD) for MCP clients, fetched safely.

An MCP client such as Claude may use an HTTPS URL as its ``client_id``; the document at
that URL describes it (name, redirect URIs). On the first authorization request (and when
the cached copy is stale) the portal fetches it:

* HTTPS only, port 443 or an explicit port, no credentials, query or fragment in the URL,
  optional host allow-list (``NEXUS_MCP_CIMD_ALLOWED_HOSTS``);
* SSRF protection: the host name is resolved once, EVERY address must be globally routable
  (no private, loopback, link-local, CGNAT, multicast or reserved ranges), and the
  connection goes to that vetted address (no second DNS lookup, so no DNS rebinding) with
  TLS verified against the real host name;
* no redirects, a short timeout, a size limit, JSON only;
* the cached copy (the allauth ``Client`` row) is reused for ``Cache-Control: max-age``
  (clamped) or ``NEXUS_MCP_CIMD_CACHE_SECONDS``; fetches are rate limited.

The document must name itself (``client_id`` equal to the URL), and its redirect URIs must
pass the same policy as dynamic registration (Claude's callbacks, loopback, operator
allow-list). Only ``token_endpoint_auth_method: none`` is accepted (a public client using
PKCE). ``fetcher`` is replaceable in tests.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import posixpath
import re
import socket
import ssl
import time
from urllib.parse import urlsplit

from django.conf import settings
from django.contrib.auth.hashers import make_password

from apps.core import ratelimit

log = logging.getLogger("nexus.mcp")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class CimdError(Exception):
    pass


def is_cimd_url(client_id: str) -> bool:
    return isinstance(client_id, str) and client_id.startswith("https://")


def validate_url(client_id: str):
    if len(client_id) > 100:
        raise CimdError("The client ID URL is too long (at most 100 characters).")
    parts = urlsplit(client_id)
    if parts.scheme != "https" or not parts.hostname:
        raise CimdError("The client ID must be an https URL.")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise CimdError("The client ID URL must not contain credentials, a query or a fragment.")
    if parts.netloc != parts.netloc.lower():
        raise CimdError("The client ID host must be lowercase.")
    if not parts.path or parts.path == "/" or posixpath.normpath(parts.path) != parts.path:
        raise CimdError("The client ID URL needs a normalised path.")
    allowed = [h.lower() for h in settings.NEXUS_MCP_CIMD_ALLOWED_HOSTS]
    if allowed and parts.hostname not in allowed:
        raise CimdError("This server does not accept client metadata from that host.")
    return parts


def _public_addresses(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise CimdError("The client's host name could not be resolved.") from None
    addrs: list[str] = []
    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if (not ip.is_global or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or ip in ipaddress.ip_network("100.64.0.0/10")):
            raise CimdError("The client's host resolves to a non-public address.")
        if addr not in addrs:
            addrs.append(addr)
    if not addrs:
        raise CimdError("The client's host name could not be resolved.")
    return addrs


def _ssl_context() -> ssl.SSLContext:
    bundle = os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    if not bundle:
        try:
            import certifi

            bundle = certifi.where()
        except ImportError:  # pragma: no cover
            bundle = None
    ctx = ssl.create_default_context(cafile=bundle) if bundle else ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def _max_age(cache_control: str) -> int | None:
    m = re.search(r"max-age=(\d+)", cache_control or "")
    return int(m.group(1)) if m else None


def fetch_document(client_id: str) -> tuple[dict, int]:
    """Fetches the metadata document. Returns (document, cache seconds)."""
    import urllib3

    parts = validate_url(client_id)
    port = parts.port or 443
    addr = _public_addresses(parts.hostname, port)[0]
    path = parts.path
    host_header = parts.hostname if port == 443 else f"{parts.hostname}:{port}"
    pool = urllib3.HTTPSConnectionPool(
        addr, port=port, server_hostname=parts.hostname, assert_hostname=parts.hostname, ssl_context=_ssl_context(),
        timeout=urllib3.Timeout(connect=settings.NEXUS_MCP_CIMD_TIMEOUT_SECONDS, read=settings.NEXUS_MCP_CIMD_TIMEOUT_SECONDS),
        retries=False, maxsize=1,
    )
    try:
        resp = pool.urlopen("GET", path, headers={"Host": host_header, "Accept": "application/json",
                                                   "User-Agent": "NexusOfficeAI-MCP-CIMD/1"},
                            redirect=False, preload_content=False)
    except urllib3.exceptions.HTTPError:
        raise CimdError("The client metadata document could not be fetched.") from None
    try:
        if resp.status != 200:
            raise CimdError(f"The client metadata document answered HTTP {resp.status}.")
        limit = settings.NEXUS_MCP_CIMD_MAX_BYTES
        length = resp.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > limit:
            raise CimdError("The client metadata document is too large.")
        body = resp.read(limit + 1, decode_content=True)
        if len(body) > limit:
            raise CimdError("The client metadata document is too large.")
        cache = _max_age(resp.headers.get("Cache-Control", ""))
    finally:
        resp.release_conn()
        pool.close()
    try:
        doc = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise CimdError("The client metadata document is not JSON.") from None
    return doc, cache if cache is not None else settings.NEXUS_MCP_CIMD_CACHE_SECONDS


# Replaced in tests with a fake (no network).
fetcher = fetch_document


def _clean_name(value, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    value = _CONTROL.sub("", value).replace("<", "").replace(">", "").strip()
    return value[:100] or fallback


def _strings(doc: dict, key: str, default: list[str] | None) -> list[str]:
    if key not in doc and default is not None:
        return default
    value = doc.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        raise CimdError(f"“{key}” must be a non-empty list of strings.")
    return value


def resolve_client(client_id: str, request=None):
    """The allauth ``Client`` for a CIMD client ID: fresh from cache, or fetched, validated
    and stored. Raises ``CimdError`` with a message safe to show."""
    from allauth.idp.oidc.models import Client

    from .oauth import MCP_SCOPE_LIST, redirect_allowed

    parts = validate_url(client_id)
    existing = Client.objects.filter(id=client_id).first()
    data = (existing.data or {}) if existing else {}
    if existing and not data.get("cimd"):
        raise CimdError("That client ID is registered differently on this server.")
    now = time.time()
    if existing and now - data.get("fetched_at", 0) < data.get("ttl", 0):
        return existing
    key = hashlib.sha256(client_id.encode()).hexdigest()[:32]
    per_client = ratelimit.hit(f"mcp-cimd:{key}", 10, 60)
    per_ip = ratelimit.hit(f"mcp-cimd-ip:{ratelimit.client_ip(request)}", 30, 60) if request is not None else None
    if not per_client.allowed or (per_ip is not None and not per_ip.allowed):
        if existing:
            return existing
        raise CimdError("Too many client metadata lookups. Try again in a minute.")
    try:
        doc, ttl = fetcher(client_id)
    except CimdError:
        if existing and now - data.get("fetched_at", 0) < 86400:
            log.warning("CIMD refresh failed for %s; using the copy fetched earlier", parts.hostname)
            return existing
        raise
    if not isinstance(doc, dict):
        raise CimdError("The client metadata document must be a JSON object.")
    if doc.get("client_id") != client_id:
        raise CimdError("The client metadata document does not name this client ID.")
    method = doc.get("token_endpoint_auth_method", "none")
    if method != "none":
        raise CimdError("Only public clients (token_endpoint_auth_method “none”, with PKCE) can use a client metadata document here.")
    redirects = [u for u in _strings(doc, "redirect_uris", None) if redirect_allowed(u)]
    if not redirects:
        raise CimdError("None of the client's redirect URIs is allowed on this server.")
    grants = [g for g in _strings(doc, "grant_types", ["authorization_code"]) if g in ("authorization_code", "refresh_token")]
    if "authorization_code" not in grants:
        raise CimdError("The client must use the authorization code grant.")
    if "code" not in _strings(doc, "response_types", ["code"]):
        raise CimdError("The client must use the “code” response type.")
    ttl = max(300, min(int(ttl), 86400))
    client = existing or Client(id=client_id)
    client.name = _clean_name(doc.get("client_name"), parts.hostname)
    client.type = Client.Type.PUBLIC
    client.secret = make_password(None)
    client.set_scopes(MCP_SCOPE_LIST)
    client.set_default_scopes(MCP_SCOPE_LIST)
    client.set_grant_types(grants)
    client.set_response_types(["code"])
    client.set_redirect_uris(redirects)
    client.skip_consent = False
    client.allow_uri_wildcards = False
    client.data = {"mcp": True, "cimd": True, "host": parts.hostname, "fetched_at": now, "ttl": ttl,
                   "dropped_redirect_uris": len(_strings(doc, "redirect_uris", None)) - len(redirects)}
    client.save()
    if existing is None:
        from apps.core.audit import audit

        audit(request, "mcp.client.cimd_registered", target_type="oidc_client", target_id=client_id[:120],
              metadata={"host": parts.hostname, "redirect_hosts": sorted({urlsplit(u).hostname or "" for u in redirects})})
    return client
