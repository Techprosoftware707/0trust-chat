"""End-to-end SSO test against a running Lumen stack (real TLS, real services).

1. Register a portal account (website signup form, CSRF and all).
2. Start Matrix SSO at the homeserver, follow the OIDC redirects through the
   portal IdP, back to the homeserver, and on to the chat app with a loginToken.
3. Exchange the loginToken for a Matrix access token and call /whoami.

Usage: python sso_flow.py --base lumen.test --ca /path/to/root.crt [--username u]
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from urllib.parse import parse_qs, urlparse

import requests


def session(ca: str | None) -> requests.Session:
    s = requests.Session()
    s.trust_env = False
    if ca:
        s.verify = ca
    s.headers["User-Agent"] = "lumen-integration-test"
    return s


def csrf(html: str) -> str:
    m = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', html)
    if not m:
        raise AssertionError("no CSRF token in form")
    return m.group(1)


def signup(s: requests.Session, base: str, username: str, password: str) -> None:
    url = f"https://{base}/accounts/signup/"
    r = s.get(url)
    r.raise_for_status()
    r = s.post(
        url,
        data={
            "csrfmiddlewaretoken": csrf(r.text),
            "username": username,
            "display_name": username.title(),
            "email": f"{username}@example.org",
            "password1": password,
            "password2": password,
            "accept_terms": "on",
        },
        headers={"Referer": url},
        allow_redirects=False,
    )
    assert r.status_code == 302, f"signup failed: {r.status_code} {r.text[:300]}"


def login(s: requests.Session, base: str, username: str, password: str) -> None:
    url = f"https://{base}/accounts/login/"
    r = s.get(url)
    r = s.post(url, data={"csrfmiddlewaretoken": csrf(r.text), "login": username, "password": password}, headers={"Referer": url}, allow_redirects=False)
    assert r.status_code == 302, f"login failed: {r.status_code}"


def sso_login(s: requests.Session, base: str, app: str, matrix: str) -> dict:
    start = f"https://{matrix}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=https://{app}/"
    url = start
    hops = []
    for _ in range(10):
        r = s.get(url, allow_redirects=False)
        hops.append((r.status_code, urlparse(url).netloc + urlparse(url).path))
        if r.status_code in (301, 302, 303, 307, 308):
            url = requests.compat.urljoin(url, r.headers["Location"])
            if urlparse(url).netloc == app:
                break
            continue
        raise AssertionError(f"unexpected {r.status_code} at {url}: {r.text[:400]}\nhops={hops}")
    q = parse_qs(urlparse(url).query)
    assert "loginToken" in q, f"no loginToken in final redirect {url}; hops={hops}"
    r = s.post(f"https://{matrix}/_matrix/client/v3/login", json={"type": "m.login.token", "token": q["loginToken"][0], "initial_device_display_name": "integration-test"})
    r.raise_for_status()
    data = r.json()
    who = s.get(f"https://{matrix}/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {data['access_token']}"}).json()
    return {"login": data, "whoami": who, "hops": hops}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--app")
    ap.add_argument("--matrix")
    ap.add_argument("--ca")
    ap.add_argument("--username", default="it" + secrets.token_hex(3))
    ap.add_argument("--password", default="Integration-Test-" + secrets.token_hex(8))
    ap.add_argument("--existing", action="store_true")
    a = ap.parse_args()
    app = a.app or f"app.{a.base}"
    matrix = a.matrix or f"matrix.{a.base}"
    s = session(a.ca)
    if a.existing:
        login(s, a.base, a.username, a.password)
    else:
        signup(s, a.base, a.username, a.password)
    result = sso_login(s, a.base, app, matrix)
    for code, hop in result["hops"]:
        print(f"  {code} {hop}")
    print("whoami:", result["whoami"])
    assert result["whoami"]["user_id"] == f"@{a.username}:{a.base}", result["whoami"]
    print("SSO OK", result["login"]["user_id"], result["login"]["device_id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
