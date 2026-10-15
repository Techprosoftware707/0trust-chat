"""Plan entitlements enforced by the homeserver, end to end (running stack, as root).

* A Free-plan user sees the Free per-file limit in /media/config, can upload a
  small file and is refused (413) a file above the limit.
* A user whose workspace is on Pro (assigned through the portal's billing
  service, as an operator would) gets the Pro limit and can upload that file.

The homeserver learns limits from the ops service through the Lumen Synapse
module (cached 5 minutes per user), so each case uses a fresh account.

Usage: sudo python3 tests/integration/entitlements.py [--base lumen.test] [--ca CA]
"""

from __future__ import annotations

import argparse
import os
import secrets
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from sso_flow import session, signup, sso_login  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MB = 1024 * 1024
PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {name}")
    else:
        FAIL += 1
        print(f"FAIL {name} {detail}")


def manage_shell(code: str) -> str:
    out = subprocess.run([os.path.join(REPO, "lumenctl"), "manage", "shell", "-c", code], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""


def plan_mb(code: str) -> int:
    return int(manage_shell(f"from apps.billing.models import Plan; print(Plan.objects.get(code='{code}').entitlement('upload_max_mb'))"))


def new_user(s, base):
    username = "ent" + secrets.token_hex(3)
    signup(s, base, username, "Entitlements-Test-" + secrets.token_hex(6))
    return username


def matrix_token(s, base):
    return sso_login(s, base, f"app.{base}", f"matrix.{base}")["login"]["access_token"]


def media_limit(s, mx, token):
    r = s.get(f"{mx}/_matrix/client/v1/media/config", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    r.raise_for_status()
    return r.json().get("m.upload.size")


def upload(s, mx, token, size):
    r = s.post(
        f"{mx}/_matrix/media/v3/upload?filename=test.bin",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"},
        data=os.urandom(size),
        timeout=120,
    )
    return r.status_code, r.text[:160]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="lumen.test")
    ap.add_argument("--ca", default="/etc/lumen/ca/bundle.crt")
    a = ap.parse_args()
    mx = f"https://matrix.{a.base}"
    free_mb, pro_mb = plan_mb("free"), plan_mb("pro")
    print(f"plans: free={free_mb} MB per file, pro={pro_mb} MB per file")

    # Free user
    s = session(a.ca)
    new_user(s, a.base)
    tok = matrix_token(s, a.base)
    check("Free user: /media/config advertises the Free per-file limit", media_limit(s, mx, tok) == free_mb * MB)
    code, _ = upload(s, mx, tok, 1024)
    check("Free user: small upload accepted", code == 200, code)
    code, body = upload(s, mx, tok, free_mb * MB + 1024)
    check(f"Free user: {free_mb} MB + 1 KB upload refused by the homeserver (413)", code == 413, f"{code} {body}")

    # Pro user (workspace on Pro, assigned like an operator would)
    s2 = session(a.ca)
    name = new_user(s2, a.base)
    manage_shell(
        "from apps.accounts.models import User; from apps.billing.models import Plan; "
        "from apps.billing.services import assign_manual_plan; from apps.workspaces import services; "
        f"u = User.objects.get(username='{name}'); ws = services.create_workspace(u, 'Entitlement test'); "
        "assign_manual_plan(ws, Plan.objects.get(code='pro')); print('ok')"
    )
    tok2 = matrix_token(s2, a.base)
    check("Pro user: /media/config advertises the Pro per-file limit", media_limit(s2, mx, tok2) == pro_mb * MB)
    code, body = upload(s2, mx, tok2, free_mb * MB + 1024)
    check(f"Pro user: the same {free_mb} MB + 1 KB upload is accepted", code == 200, f"{code} {body}")

    print(f"entitlements: {PASS} passed, {FAIL} failed")
    return FAIL


if __name__ == "__main__":
    sys.exit(main())
