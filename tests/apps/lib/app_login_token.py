#!/usr/bin/env python3
"""A login token for the mobile apps' sign-in path, as the apps get it.

    python3 tests/apps/lib/app_login_token.py --base lumen.test --ca /etc/lumen/ca/bundle.crt \
        [--username U --password P] [--count N]

Signs up a portal account (or logs in to an existing one), then starts Matrix SSO
with the apps' redirect URI (io.lumen.secure:/sso-callback, allow-listed in
Synapse) and follows the redirects through the portal's OIDC provider until the
homeserver redirects to the app scheme with a loginToken — the callback URL the
apps hand to SsoHandler.finish(). Reuses tests/integration/sso_flow.py (portal
forms) and tests/integration/app_sso.py (redirect following).

Prints one JSON object: {"user_id", "username", "password", "login_tokens": [...]}.
Each login token is single-use and short-lived; nothing is logged in with here.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "integration"))
from app_sso import SCHEME, follow  # noqa: E402
from sso_flow import login, session, signup  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--matrix")
    ap.add_argument("--ca")
    ap.add_argument("--username")
    ap.add_argument("--password")
    ap.add_argument("--count", type=int, default=1)
    a = ap.parse_args()
    mx = a.matrix or f"matrix.{a.base}"
    s = session(a.ca)
    if a.username and a.password:
        user, pw = a.username, a.password
    else:
        user, pw = "native" + secrets.token_hex(3), "Native-Test-" + secrets.token_hex(8)
        signup(s, a.base, user, pw)
    login(s, a.base, user, pw)

    tokens = []
    for _ in range(a.count):
        nonce = secrets.token_urlsafe(16)
        redirect = f"{SCHEME}:/sso-callback?n={nonce}"
        start = f"https://{mx}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl={quote(redirect, safe='')}"
        final, hops, last = follow(s, start, SCHEME)
        if not final:
            print(f"SSO did not end in the app scheme: {last.status_code if last else '?'} after {hops}", file=sys.stderr)
            return 1
        q = parse_qs(urlparse(final.replace(f"{SCHEME}:", "https://app", 1)).query)
        if q.get("n") != [nonce] or not q.get("loginToken"):
            print("SSO callback without the nonce or the login token", file=sys.stderr)
            return 1
        tokens.append(q["loginToken"][0])
    print(json.dumps({"user_id": f"@{user}:{a.base}", "username": user, "password": pw, "login_tokens": tokens}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
