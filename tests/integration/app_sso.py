#!/usr/bin/env python3
"""Sign-in path of the native/desktop apps against a running Lumen server.

    python3 tests/integration/app_sso.py --base lumen.test --ca /etc/lumen/ca/bundle.crt

Checks, with real HTTP against the deployment:
  1. /.well-known/matrix/client has the homeserver and a valid io.lumen.app block;
  2. SSO started with the apps' redirect URI (io.lumen.secure:/sso-callback?n=<nonce>)
     ends in a direct redirect to that URI (no confirmation page), keeps the nonce,
     and carries a login token;
  3. the login token works once (m.login.token) and is single-use;
  4. a redirect URI that is NOT allow-listed gets Synapse's confirmation page instead
     of an automatic redirect (so the allow-list is what makes the app flow seamless);
  5. logout invalidates the access token.
Prints PASS/FAIL lines; exit status = number of failures.
"""
from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sso_flow import login, session, signup  # noqa: E402

SCHEME = "io.lumen.secure"
results: list[tuple[bool, str]] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    results.append((ok, name))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f" — {detail}"))


def follow(s, url: str, stop_scheme: str, max_hops: int = 12):
    """Follow redirects until the Location uses stop_scheme; returns (final_url, hops, last_response)."""
    hops = []
    r = None
    for _ in range(max_hops):
        r = s.get(url, allow_redirects=False)
        hops.append((r.status_code, urlparse(url).netloc + urlparse(url).path))
        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers["Location"]
            if loc.startswith(stop_scheme + ":"):
                return loc, hops, r
            url = urljoin(url, loc)
            continue
        return None, hops, r
    return None, hops, r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--matrix")
    ap.add_argument("--ca")
    args = ap.parse_args()
    base, mx = args.base, args.matrix or f"matrix.{args.base}"
    s = session(args.ca)

    wk = s.get(f"https://{base}/.well-known/matrix/client").json()
    app = wk.get("io.lumen.app") or {}
    check(wk.get("m.homeserver", {}).get("base_url") == f"https://{mx}", "well-known: homeserver")
    urls = {k: v for k, v in app.items() if k.endswith("_url")}
    check(app.get("version") == 1 and app.get("sso_idp_id") == "oidc-lumen" and urls and all(v.startswith("https://") for v in urls.values()),
          "well-known: io.lumen.app block (version 1, SSO provider, https URLs only)", str(app))

    user, pw = "app" + secrets.token_hex(3), "App-Test-" + secrets.token_hex(8)
    signup(s, base, user, pw)
    login(s, base, user, pw)

    nonce = secrets.token_urlsafe(16)
    redirect = f"{SCHEME}:/sso-callback?n={nonce}"
    start = f"https://{mx}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl={quote(redirect, safe='')}"
    final, hops, last = follow(s, start, SCHEME)
    check(final is not None, "SSO ends in a direct redirect to the app scheme (no confirmation page)",
          f"stopped with {last.status_code if last else '?'} after {hops}")
    token = None
    if final:
        q = parse_qs(urlparse(final.replace(f"{SCHEME}:", "https://app", 1)).query)
        check(q.get("n") == [nonce], "SSO callback keeps the app's per-attempt nonce", final.split("loginToken")[0])
        token = (q.get("loginToken") or [None])[0]
        check(bool(token), "SSO callback carries a login token")
    access = None
    if token:
        r = s.post(f"https://{mx}/_matrix/client/v3/login",
                   json={"type": "m.login.token", "token": token, "initial_device_display_name": "Lumen app SSO test"})
        check(r.status_code == 200, "login token accepted (m.login.token)", r.text[:200])
        if r.status_code == 200:
            access = r.json()["access_token"]
            who = s.get(f"https://{mx}/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {access}"}).json()
            check(who.get("user_id", "").startswith(f"@{user}:"), "signed in as the portal user", str(who))
        r2 = s.post(f"https://{mx}/_matrix/client/v3/login", json={"type": "m.login.token", "token": token})
        check(r2.status_code == 403, "login token is single-use", f"{r2.status_code}")

    other = f"https://{mx}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl={quote('evil.example:/cb', safe='')}"
    final2, hops2, last2 = follow(s, other, "evil.example")
    check(final2 is None and last2 is not None and last2.status_code == 200,
          "non-allow-listed redirect gets the confirmation page, not an automatic redirect", f"{hops2}")

    if access:
        r = s.post(f"https://{mx}/_matrix/client/v3/logout", headers={"Authorization": f"Bearer {access}"}, json={})
        after = s.get(f"https://{mx}/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {access}"})
        check(r.status_code == 200 and after.status_code == 401, "logout invalidates the access token", f"{r.status_code}/{after.status_code}")

    failed = sum(1 for ok, _ in results if not ok)
    print(f"app sso: {len(results) - failed} passed, {failed} failed")
    return failed


if __name__ == "__main__":
    sys.exit(main())
