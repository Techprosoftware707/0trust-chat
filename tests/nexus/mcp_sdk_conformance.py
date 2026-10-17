#!/usr/bin/env python3
"""Protocol conformance of the Nexus MCP connector, checked with the OFFICIAL MCP Python SDK
(``mcp``) as the client, against a running portal (e.g. the dev runserver of your slot).

The SDK does everything a real MCP client does: it reads the Protected Resource Metadata
(RFC 9728) from the 401 challenge, the authorization server metadata (RFC 8414), registers
itself (RFC 7591 DCR), runs the authorization code flow with PKCE S256 and the ``resource``
parameter (RFC 8707), checks ``iss`` (RFC 9207, SDK 2.x) and then speaks MCP over Streamable
HTTP. Only the person's part is scripted: this file signs in to the portal as a demo person
and presses "Allow access" on the consent screen, like a browser would.

It is a DEV-ONLY check. The SDK is not a dependency of Nexus; install it in a throwaway venv:

    python3 -m venv /tmp/mcp-sdk-2 && /tmp/mcp-sdk-2/bin/pip install mcp==2.3.0
    NEXUS_DEMO_PASSWORD=... /tmp/mcp-sdk-2/bin/python -I tests/nexus/mcp_sdk_conformance.py \
        --server http://127.0.0.1:8713 --username demo-riley --out docs/nexus/evidence/b3

Prerequisites on the server: NEXUS_MCP_ENABLED=1, loopback redirects allowed (the default),
the demo workspace's "Members may connect Claude" setting on.

Without the SDK the script SKIPS (exit status 77, "SKIPPED: ..."): it never reports a pass
it didn't check. Under pytest it is skipped as well unless the SDK is importable and
NEXUS_MCP_CONFORMANCE_SERVER is set.

What this can't show: a connection from Claude itself. Claude reaches connectors from
Anthropic's egress range 160.79.104.0/21 over public HTTPS; a local runserver isn't reachable
from there.

Nothing secret is printed or written: no tokens, no password, no authorization codes.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import http.cookiejar
import json
import os
import platform
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SKIP = 77
REQUIRED_TOOLS = {"get_workspace_context", "search_contacts", "get_contact_summary", "list_my_tasks", "prepare_create_task", "confirm_action",
                  "cancel_action"}


def sdk_version() -> str | None:
    try:
        import mcp  # noqa: F401
    except ImportError:
        return None
    from importlib.metadata import version

    return version("mcp")


# --- the person's browser (stdlib only, so it works the same in every SDK venv) ---------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


class Browser:
    """Signs in to the portal and answers the consent screen. Redirects are NOT followed, so
    the authorization response (to the client's loopback callback) is captured, not fetched."""

    def __init__(self, base: str, username: str, password: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect())
        self.username, self.password = username, password
        self.consent_seen: dict = {}

    def _open(self, url: str, data: dict | None = None):
        body = urllib.parse.urlencode(data, doseq=True).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers={"Referer": url, "User-Agent": "nexus-mcp-conformance"})
        try:
            r = self.opener.open(req, timeout=30)
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode("utf-8", "replace")

    @staticmethod
    def _csrf(html: str) -> str:
        m = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', html)
        if not m:
            raise RuntimeError("no CSRF token on the page")
        return m.group(1)

    def login(self) -> None:
        url = f"{self.base}/accounts/login/"
        status, _, html = self._open(url)
        if status != 200:
            raise RuntimeError(f"login page answered {status}")
        status, headers, _ = self._open(url, {"csrfmiddlewaretoken": self._csrf(html), "login": self.username, "password": self.password})
        if status != 302:
            raise RuntimeError(f"sign-in failed (HTTP {status}); check --username and NEXUS_DEMO_PASSWORD")

    def authorize(self, auth_url: str) -> str:
        """Opens the authorization URL, checks the consent screen, allows access. Returns
        the redirect Location (the client's callback with code, state and iss)."""
        status, headers, html = self._open(auth_url)
        if status != 200:
            raise RuntimeError(f"authorization page answered {status} (Location: {headers.get('Location', '')[:120]})")
        signed = re.search(r'name="request" value="([^"]+)"', html)
        if not signed:
            raise RuntimeError("the consent screen has no signed request")
        scopes = re.findall(r'name="scopes" value="([^"]+)"', html)
        workspace = re.search(r'name="workspace" value="([^"]+)"', html) or re.search(r'<option value="([0-9a-f-]{36})"', html)
        if not workspace:
            raise RuntimeError("no workspace allows the connector (turn it on in the AI settings)")
        self.consent_seen = {
            "redirect_host_shown": bool(re.search(r"127\.0\.0\.1|localhost", html)),
            "loopback_warning_shown": "this computer" in html.lower() or "on your computer" in html.lower(),
            "scopes_offered": scopes,
        }
        form_action = re.search(r'<form[^>]+method="post"[^>]+action="([^"]+)"', html).group(1)
        status, headers, body = self._open(urllib.parse.urljoin(self.base + "/", form_action), {
            "csrfmiddlewaretoken": self._csrf(html), "request": signed.group(1), "scopes": scopes, "workspace": workspace.group(1),
            "action": "grant"})
        if status != 302:
            raise RuntimeError(f"consent was not accepted (HTTP {status})")
        return headers["Location"]


# --- checks -----------------------------------------------------------------------------------------------


class Report:
    def __init__(self):
        self.rows: list[dict] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append({"check": name, "ok": bool(ok), "detail": detail[:300]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}{' - ' + detail[:200] if detail else ''}", flush=True)
        return ok

    @property
    def ok(self) -> bool:
        return bool(self.rows) and all(r["ok"] for r in self.rows)


def _d(model) -> dict:
    """A result model as wire JSON (camelCase), in either SDK generation."""
    return model.model_dump(by_alias=True, exclude_none=True, mode="json")


def unauthenticated_checks(server: str, rep: Report) -> None:
    req = urllib.request.Request(f"{server}/mcp", data=b'{"jsonrpc":"2.0","id":1,"method":"ping"}',
                                 headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        urllib.request.urlopen(req, timeout=15)
        rep.check("401 without a token", False, "the request was accepted")
    except urllib.error.HTTPError as e:
        www = e.headers.get("WWW-Authenticate", "")
        rep.check("401 without a token, with resource_metadata in WWW-Authenticate",
                  e.code == 401 and "resource_metadata=" in www and www.startswith("Bearer"), f"HTTP {e.code}")
    with urllib.request.urlopen(f"{server}/.well-known/oauth-protected-resource/mcp", timeout=15) as r:
        prm = json.loads(r.read())
    rep.check("RFC 9728 metadata names the /mcp resource and the issuer",
              prm.get("resource") == f"{server}/mcp" and prm.get("authorization_servers") == [server], json.dumps(prm)[:200])


async def _exercise(call, list_tools, rep: Report, label: str) -> None:
    tools = (await list_tools())
    tl = [_d(t) for t in tools.tools]
    names = {t["name"] for t in tl}
    rep.check(f"[{label}] tools/list returns the Nexus tools", REQUIRED_TOOLS <= names, f"{len(tl)} tools")
    rep.check(f"[{label}] every tool has annotations and an object input schema",
              all(t.get("annotations") and t.get("inputSchema", {}).get("type") == "object" for t in tl))
    rep.check(f"[{label}] write tools are not read-only, confirm_action is destructive",
              all(not t["annotations"].get("readOnlyHint") for t in tl if t["name"].startswith("prepare_"))
              and next(t for t in tl if t["name"] == "confirm_action")["annotations"].get("destructiveHint") is True)
    r = _d(await call("get_workspace_context", {}))
    rep.check(f"[{label}] tools/call get_workspace_context", not r.get("isError") and "workspace" in (r.get("structuredContent") or {}),
              (r.get("structuredContent") or {}).get("you", {}).get("role", ""))
    r = _d(await call("search_contacts", {"query": "a", "limit": 3}))
    text = " ".join(c.get("text", "") for c in r.get("content", []))
    rep.check(f"[{label}] search results carry record links", not r.get("isError") and "/#/contacts/" in text)
    r = _d(await call("search_contacts", {"query": "x", "limit": 999}))
    rep.check(f"[{label}] invalid arguments give a tool error (isError), not a crash", r.get("isError") is True)
    try:
        r = _d(await call("no_such_tool", {}))
        rep.check(f"[{label}] an unknown tool is refused", r.get("isError") is True, "as a tool error")
    except Exception as exc:  # noqa: BLE001 - the SDK raises the JSON-RPC error
        rep.check(f"[{label}] an unknown tool is refused", True, type(exc).__name__)
    r = _d(await call("prepare_create_task", {"title": f"SDK conformance check ({label}) - safe to delete"}))
    pa = (r.get("structuredContent") or {}).get("pending_action") or {}
    rep.check(f"[{label}] prepare_create_task only proposes", not r.get("isError") and pa.get("status") == "pending")
    r = _d(await call("confirm_action", {"pending_action_id": pa.get("pending_action_id", "")}))
    done = (r.get("structuredContent") or {}).get("pending_action") or {}
    rep.check(f"[{label}] confirm_action executes it once", not r.get("isError") and done.get("status") == "confirmed")
    r = _d(await call("confirm_action", {"pending_action_id": pa.get("pending_action_id", "")}))
    rep.check(f"[{label}] a second confirm is refused (single use)", r.get("isError") is True)


async def run_v2(server: str, browser: Browser, rep: Report) -> None:
    import httpx2
    from mcp import Client
    from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
    from mcp.client.streamable_http import streamable_http_client
    from mcp.shared.auth import OAuthClientMetadata

    class Memory:
        def __init__(self):
            self.tokens = self.client = None

        async def get_tokens(self):
            return self.tokens

        async def set_tokens(self, tokens):
            self.tokens = tokens

        async def get_client_info(self):
            return self.client

        async def set_client_info(self, info):
            self.client = info

    store = Memory()
    captured: dict = {}

    async def redirect_handler(url: str) -> None:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        captured["auth_params"] = {k: v[0] for k, v in q.items() if k in ("code_challenge_method", "resource", "scope", "response_type")}
        captured["location"] = await asyncio.to_thread(browser.authorize, url)

    async def callback_handler() -> AuthorizationCodeResult:
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(captured["location"]).query).items()}
        captured["iss_present"] = "iss" in q
        return AuthorizationCodeResult(code=q["code"], state=q.get("state"), iss=q.get("iss"))

    auth = OAuthClientProvider(
        server_url=f"{server}/mcp",
        client_metadata=OAuthClientMetadata(client_name="Nexus conformance (mcp SDK 2.x)", redirect_uris=["http://127.0.0.1:33418/callback"],
                                            grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                                            token_endpoint_auth_method="none"),
        storage=store, redirect_handler=redirect_handler, callback_handler=callback_handler)

    for mode in ("auto", "legacy"):
        async with httpx2.AsyncClient(auth=auth, timeout=60) as http:
            async with Client(streamable_http_client(f"{server}/mcp", http_client=http), mode=mode) as client:
                if mode == "auto":
                    rep.check("[2.x] OAuth: DCR + PKCE S256 + resource, through the SDK", store.tokens is not None and store.client is not None,
                              f"auth request {captured.get('auth_params')}")
                    rep.check("[2.x] OAuth: the authorization response carries iss (RFC 9207), validated by the SDK",
                              captured.get("iss_present") is True)
                    rep.check("[2.x] consent screen shows the redirect host and the loopback warning",
                              browser.consent_seen.get("redirect_host_shown") and browser.consent_seen.get("loopback_warning_shown"),
                              json.dumps(browser.consent_seen))
                pv = client.protocol_version
                rep.check(f"[2.x mode={mode}] negotiated protocol version", pv == ("2026-07-28" if mode == "auto" else "2025-11-25"), pv)
                if mode == "legacy":  # ping no longer exists in 2026-07-28
                    await client.send_ping()
                    rep.check(f"[2.x mode={mode}] ping", True)
                await _exercise(client.call_tool, client.list_tools, rep, f"2.x {pv}")


async def run_v1(server: str, browser: Browser, rep: Report) -> None:
    from mcp import ClientSession
    from mcp.client.auth import OAuthClientProvider
    from mcp.client.streamable_http import streamablehttp_client
    from mcp.shared.auth import OAuthClientMetadata

    class Memory:
        def __init__(self):
            self.tokens = self.client = None

        async def get_tokens(self):
            return self.tokens

        async def set_tokens(self, tokens):
            self.tokens = tokens

        async def get_client_info(self):
            return self.client

        async def set_client_info(self, info):
            self.client = info

    store = Memory()
    captured: dict = {}

    async def redirect_handler(url: str) -> None:
        captured["location"] = await asyncio.to_thread(browser.authorize, url)

    async def callback_handler() -> tuple[str, str | None]:
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(captured["location"]).query).items()}
        return q["code"], q.get("state")

    auth = OAuthClientProvider(
        server_url=f"{server}/mcp",
        client_metadata=OAuthClientMetadata(client_name="Nexus conformance (mcp SDK 1.x)", redirect_uris=["http://localhost:33419/callback"],
                                            grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                                            token_endpoint_auth_method="none"),
        storage=store, redirect_handler=redirect_handler, callback_handler=callback_handler)
    async with streamablehttp_client(f"{server}/mcp", auth=auth) as (read, write, _sid):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            rep.check("[1.x] OAuth: DCR + PKCE S256 + resource, through the SDK (localhost loopback redirect)",
                      store.tokens is not None and store.client is not None)
            rep.check("[1.x] initialize negotiates 2025-11-25", init.protocolVersion == "2025-11-25", init.protocolVersion)
            await session.send_ping()
            rep.check("[1.x] ping", True)
            await _exercise(session.call_tool, session.list_tools, rep, f"1.x {init.protocolVersion}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--server", default=os.environ.get("NEXUS_MCP_CONFORMANCE_SERVER", "http://127.0.0.1:8713"))
    ap.add_argument("--username", default=os.environ.get("NEXUS_MCP_CONFORMANCE_USER", "demo-riley"))
    ap.add_argument("--out", default="", help="Directory for the evidence file (JSON + text).")
    args = ap.parse_args(argv)
    version = sdk_version()
    if version is None:
        print("SKIPPED: the official MCP Python SDK (package 'mcp') is not installed in this interpreter, so nothing was checked. "
              "Install it in a throwaway venv (see the docstring) and run again.")
        return SKIP
    password = os.environ.get("NEXUS_DEMO_PASSWORD", "")
    if not password:
        print("SKIPPED: set NEXUS_DEMO_PASSWORD (the demo people's password) to sign in. Nothing was checked.")
        return SKIP
    server = args.server.rstrip("/")
    rep = Report()
    browser = Browser(server, args.username, password)
    started = dt.datetime.now(dt.UTC)
    try:
        unauthenticated_checks(server, rep)
        browser.login()
        asyncio.run(run_v2(server, browser, rep) if version.startswith("2.") else run_v1(server, browser, rep))
    except Exception as exc:  # noqa: BLE001 - reported, never hidden
        while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
            exc = exc.exceptions[0]
        rep.check("run completed", False, f"{type(exc).__name__}: {str(exc)[:240]}")
    summary = {"sdk": f"mcp {version}", "python": platform.python_version(), "server": server, "user": args.username,
               "started": started.isoformat(timespec="seconds"), "passed": sum(r["ok"] for r in rep.rows), "failed": sum(not r["ok"] for r in rep.rows),
               "result": "PASS" if rep.ok else "FAIL", "checks": rep.rows,
               "not_covered": "A connection from Claude itself (needs public HTTPS reachable from Anthropic's egress 160.79.104.0/21)."}
    print(f"\n{summary['result']}: {summary['passed']} passed, {summary['failed']} failed (mcp {version})")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        path = os.path.join(args.out, f"mcp-sdk-{version}-conformance.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
            fh.write("\n")
        print(f"evidence: {path}")
    return 0 if rep.ok else 1


def test_sdk_conformance():  # pragma: no cover - collected only when someone points pytest at this file
    import pytest

    if sdk_version() is None:
        pytest.skip("the official MCP Python SDK (mcp) is not installed; see the module docstring")
    if not os.environ.get("NEXUS_MCP_CONFORMANCE_SERVER") or not os.environ.get("NEXUS_DEMO_PASSWORD"):
        pytest.skip("set NEXUS_MCP_CONFORMANCE_SERVER and NEXUS_DEMO_PASSWORD to run against a live portal")
    assert main([]) == 0


if __name__ == "__main__":
    sys.exit(main())
