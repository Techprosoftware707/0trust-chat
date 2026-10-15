"""Federation tests between a Lumen server and an independent Synapse server.

Phase "connect":
  * server discovery documents on both sides
  * a Lumen user (signed in through the portal SSO) invites a user on the
    remote server; the invite travels over federation; the remote user joins
  * messages flow in both directions and arrive on the other server
  * the remote server, acting as a key notary, fetches the Lumen server's
    signing keys (proves external federation reachability)
Phase "denied":
  * with Lumen's FEDERATION_MODE=allowlist (remote not listed) an invite to the
    remote user is refused by the Lumen homeserver.

These are transport/federation tests; end-to-end encrypted cross-server
messaging is covered by tests/chat (matrix-js-sdk + Rust crypto).
"""

from __future__ import annotations

import argparse
import secrets
import sys
import time
import uuid

import requests

sys.path.insert(0, "/tests/integration")
from sso_flow import login as portal_login, session as tls_session, signup, sso_login  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {name}")
    else:
        FAIL += 1
        print(f"FAIL {name} {detail}")


class Mx:
    def __init__(self, base, token, s):
        self.base, self.token, self.s = base, token, s
        self.since = None

    def req(self, method, path, **kw):
        r = self.s.request(method, self.base + path, headers={"Authorization": f"Bearer {self.token}"}, timeout=60, **kw)
        return r

    def sync(self, timeout_ms=5000):
        params = {"timeout": timeout_ms}
        if self.since:
            params["since"] = self.since
        r = self.req("GET", "/_matrix/client/v3/sync", params=params)
        r.raise_for_status()
        d = r.json()
        self.since = d["next_batch"]
        return d

    def wait_for(self, pred, seconds=60):
        deadline = time.time() + seconds
        while time.time() < deadline:
            d = self.sync()
            hit = pred(d)
            if hit:
                return hit
        return None


def password_login(s, base, user, password):
    r = s.post(f"{base}/_matrix/client/v3/login", json={"type": "m.login.password", "identifier": {"type": "m.id.user", "user": user}, "password": password}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lumen", default="lumen.test")
    ap.add_argument("--remote", default="remote.test")
    ap.add_argument("--ca", required=True)
    ap.add_argument("--phase", default="connect", choices=["connect", "denied"])
    ap.add_argument("--user", default="fedtester")
    ap.add_argument("--password", default="Federation-Test-" + secrets.token_hex(6))
    a = ap.parse_args()
    s = tls_session(a.ca)
    lumen_mx = f"https://matrix.{a.lumen}"
    remote_mx = f"https://matrix.{a.remote}"

    if a.phase == "connect":
        wk = s.get(f"https://{a.lumen}/.well-known/matrix/server").json()
        check("Lumen server discovery (.well-known/matrix/server)", wk.get("m.server") == f"matrix.{a.lumen}:443", wk)
        wk = s.get(f"https://{a.remote}/.well-known/matrix/server").json()
        check("remote server discovery", wk.get("m.server") == f"matrix.{a.remote}:443", wk)
        # Ask for our specific key IDs with a minimum validity far in the future: this
        # forces the notary to fetch them from the Lumen server *now* (a query for
        # "all keys" only returns what the notary already has cached).
        own = s.get(f"{lumen_mx}/_matrix/key/v2/server", timeout=30).json()
        want = int(time.time() * 1000) + 30 * 24 * 3600 * 1000
        criteria = {key_id: {"minimum_valid_until_ts": want} for key_id in own.get("verify_keys", {})}
        keys, r = [], None
        for _ in range(12):  # the notary may be backing off after an earlier failure
            r = s.post(f"{remote_mx}/_matrix/key/v2/query", json={"server_keys": {a.lumen: criteria}}, timeout=30)
            keys = [k for k in r.json().get("server_keys", []) if k.get("server_name") == a.lumen]
            if keys and set(keys[0].get("verify_keys", {})) & set(criteria):
                break
            time.sleep(5)
        check("remote server fetched Lumen's signing keys over federation (notary query)", bool(keys), r.text[:200] if r is not None else "")

    # One portal account is reused across runs (signups are rate-limited per IP).
    username, password = a.user, a.password
    try:
        portal_login(s, a.lumen, username, password)
    except AssertionError:
        signup(s, a.lumen, username, password)
    login = sso_login(s, a.lumen, f"app.{a.lumen}", f"matrix.{a.lumen}")["login"]
    alice = Mx(lumen_mx, login["access_token"], s)
    bob = Mx(remote_mx, password_login(s, remote_mx, "bob", "bob-remote-pass-123"), s)
    bob.sync(0)
    alice_id, bob_id = login["user_id"], f"@bob:{a.remote}"

    r = alice.req("POST", "/_matrix/client/v3/createRoom", json={"name": "Federation test", "preset": "private_chat"})
    room_id = r.json()["room_id"]
    st = alice.req("GET", f"/_matrix/client/v3/rooms/{room_id}/state/m.room.encryption/").json()
    check("rooms created on Lumen are end-to-end encrypted by default", st.get("algorithm") == "m.megolm.v1.aes-sha2", st)
    r = alice.req("POST", f"/_matrix/client/v3/rooms/{room_id}/invite", json={"user_id": bob_id})

    if a.phase == "denied":
        check("allowlist policy: invite to a non-allow-listed server is refused", r.status_code == 403, f"{r.status_code} {r.text[:200]}")
        print(f"federation (denied phase): {PASS} passed, {FAIL} failed")
        return FAIL

    check("Lumen user can invite a remote user (federated invite accepted)", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    got = bob.wait_for(lambda d: room_id in d.get("rooms", {}).get("invite", {}) and room_id, 60)
    check("invite arrived on the remote server", got == room_id)
    r = bob.req("POST", f"/_matrix/client/v3/join/{room_id}", json={})
    check("remote user joined the room over federation", r.status_code == 200, r.text[:200])

    marker_a = f"hello-from-lumen-{uuid.uuid4().hex[:8]}"
    alice.req("PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{uuid.uuid4().hex}", json={"msgtype": "m.text", "body": marker_a})

    def seen(marker):
        def pred(d):
            room = d.get("rooms", {}).get("join", {}).get(room_id, {})
            return any(e.get("content", {}).get("body") == marker for e in room.get("timeline", {}).get("events", []))
        return pred

    check("Lumen → remote message delivered", bool(bob.wait_for(seen(marker_a), 60)))
    marker_b = f"hello-from-remote-{uuid.uuid4().hex[:8]}"
    alice.sync(0)
    bob.req("PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{uuid.uuid4().hex}", json={"msgtype": "m.text", "body": marker_b})
    check("remote → Lumen message delivered", bool(alice.wait_for(seen(marker_b), 60)))
    members = alice.req("GET", f"/_matrix/client/v3/rooms/{room_id}/joined_members").json().get("joined", {})
    check("both servers' users are joined members", set(members) == {alice_id, bob_id}, list(members))
    print(f"federation (connect phase): {PASS} passed, {FAIL} failed")
    return FAIL


if __name__ == "__main__":
    sys.exit(main())
