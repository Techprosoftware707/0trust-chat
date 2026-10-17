"""Local fake providers: Google (OAuth + Gmail API), Slack (OAuth + Web API) and HighLevel
(OAuth + API v2), answering the same URLs and shapes as the real services.

Used in mock mode (``NEXUS_INTEGRATIONS_MOCK=1``, refused in production) for demos, and by
the automated tests (which are therefore mock-based: no live provider is ever called).
Everything here is synthetic: fictional people on example.com/.org/.net, subjects and texts
marked as mock data, and every connection made through it is flagged ``is_mock`` and shown as
"Mock provider (development)". Knobs on the fakes let tests simulate revoked grants, rate
limits and outages.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import json
import secrets
import threading
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from ..http import Headers, HttpRequest, HttpResponse

MOCK_PREFIX = "mock-"


def _json(status: int, data: Any, headers: dict | None = None) -> HttpResponse:
    h = Headers({"Content-Type": "application/json"})
    for k, v in (headers or {}).items():
        h[k] = v
    return HttpResponse(status=status, headers=h, body=json.dumps(data).encode())


def _params(req: HttpRequest) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for k, v in parse_qsl(urlsplit(req.url).query, keep_blank_values=True):
        out.setdefault(k, []).append(v)
    raw = req.params or {}
    items = raw if isinstance(raw, list) else list(raw.items())
    for k, v in items:
        out.setdefault(str(k), []).append(str(v))
    return out


def _one(params: dict[str, list[str]], key: str, default: str = "") -> str:
    vals = params.get(key)
    return vals[0] if vals else default


def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def _unb64(s: str) -> str:
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return ""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _ms(d: dt.datetime) -> str:
    return str(int(d.timestamp() * 1000))


class FakeProvider:
    """Shared machinery: authorization codes (with PKCE challenge), tokens, failure knobs."""

    name = ""

    def __init__(self):
        self.lock = threading.RLock()
        self.codes: dict[str, dict] = {}
        self.revoked: set[str] = set()
        self.refresh_count = 0
        self.calls: list[tuple[str, str]] = []
        # Test knobs: callables returning a forced HttpResponse (or None) per request.
        self.interceptors: list[Callable[[HttpRequest], HttpResponse | None]] = []
        self.refresh_rejected = False
        self.access_rejected = False

    def issue_code(self, *, account: str, challenge: str = "", method: str = "", redirect_uri: str = "", extra: dict | None = None) -> str:
        code = f"{MOCK_PREFIX}code-{secrets.token_urlsafe(12)}"
        with self.lock:
            self.codes[code] = {"account": account, "challenge": challenge, "method": method, "redirect_uri": redirect_uri,
                                "extra": extra or {}, "used": False}
        return code

    def redeem(self, code: str, verifier: str, redirect_uri: str) -> dict | None:
        with self.lock:
            entry = self.codes.get(code)
            if entry is None or entry["used"]:
                return None
            if entry["redirect_uri"] and redirect_uri != entry["redirect_uri"]:
                return None
            if entry["challenge"]:
                if not verifier:
                    return None
                expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
                if entry["method"] == "S256" and expected != entry["challenge"]:
                    return None
            entry["used"] = True
            return entry

    def token(self, kind: str, account: str) -> str:
        return f"{MOCK_PREFIX}{self.name}-{kind}-{_b64(account)}-{secrets.token_urlsafe(8)}"

    def account_of(self, token: str) -> str | None:
        if not token or token in self.revoked or not token.startswith(f"{MOCK_PREFIX}{self.name}-"):
            return None
        parts = token.split("-")
        return _unb64(parts[3]) if len(parts) >= 5 else None

    def bearer(self, req: HttpRequest) -> str | None:
        auth = req.headers.get("Authorization") or ""
        token = auth[7:] if auth.lower().startswith("bearer ") else ""
        if self.access_rejected:
            return None
        return self.account_of(token)

    def handle(self, req: HttpRequest) -> HttpResponse:
        with self.lock:
            self.calls.append((req.method, urlsplit(req.url).path))
            for fn in list(self.interceptors):
                forced = fn(req)
                if forced is not None:
                    return forced
        return self.route(req)

    def route(self, req: HttpRequest) -> HttpResponse:  # pragma: no cover - interface
        raise NotImplementedError


# --- Google / Gmail ---------------------------------------------------------------------------------

MOCK_SENDERS = [
    ("Harper Sample", "harper.sample@example.com"),
    ("Quinn Placeholder", "quinn.placeholder@example.org"),
    ("Rowan Example", "rowan@example.net"),
    ("Lane Sample", "lane@example.net"),
    ("Unknown Sender (mock)", "new.lead.mock@example.org"),
    ("Newsletter (mock)", "updates.mock@example.com"),
]
MOCK_SUBJECTS = [
    "Sample thread: showing times (mock data)",
    "Sample thread: document checklist question (mock data)",
    "Sample thread: portfolio update request (mock data)",
    "Sample thread: escrow paperwork (mock data)",
    "Sample thread: new inquiry (mock data)",
    "Sample newsletter (mock data)",
]


class FakeGoogle(FakeProvider):
    name = "google"

    def __init__(self):
        super().__init__()
        self.mailboxes: dict[str, dict] = {}

    def mailbox(self, account: str) -> dict:
        with self.lock:
            if account not in self.mailboxes:
                self.mailboxes[account] = self._seed(account)
            return self.mailboxes[account]

    def _seed(self, account: str) -> dict:
        now = _now()
        threads: dict[str, dict] = {}
        for i, ((name, addr), subject) in enumerate(zip(MOCK_SENDERS, MOCK_SUBJECTS, strict=True)):
            tid = f"mockthread{i + 1:02d}"
            when = now - dt.timedelta(hours=3 + i * 7)
            msgs = [self._message(f"{tid}m1", tid, name, addr, account, subject, when, unread=i < 3,
                                  body=f"This is synthetic mock email number {i + 1} for testing the inbox. It is not a real message.",
                                  with_attachment=i == 1, html=i == 2)]
            if i == 0:
                msgs.append(self._message(f"{tid}m2", tid, "Me", account, addr, f"Re: {subject}", when + dt.timedelta(hours=1),
                                          unread=False, body="Synthetic mock reply (sent).", sent=True,
                                          references=msgs[0]["_message_id"]))
            threads[tid] = {"id": tid, "historyId": str(1000 + i), "messages": msgs}
        return {"threads": threads, "history_id": 2000, "drafts": {}, "sent": []}

    def _message(self, mid, tid, from_name, from_addr, to, subject, when, *, unread, body, sent=False, references="",
                 with_attachment=False, html=False) -> dict:
        labels = ["SENT"] if sent else ["INBOX"] + (["UNREAD"] if unread else [])
        message_id = f"<{mid}@mock.example.com>"
        headers = [{"name": "From", "value": f"{from_name} <{from_addr}>"}, {"name": "To", "value": to},
                   {"name": "Subject", "value": subject}, {"name": "Date", "value": when.strftime("%a, %d %b %Y %H:%M:%S +0000")},
                   {"name": "Message-ID", "value": message_id}]
        if references:
            headers += [{"name": "In-Reply-To", "value": references}, {"name": "References", "value": references}]
        parts = [{"partId": "0", "mimeType": "text/plain", "filename": "", "body": {"size": len(body), "data": _b64(body)}}]
        if html:
            parts.append({"partId": "1", "mimeType": "text/html", "filename": "", "body": {"data": _b64(
                f"<p>{body}</p><p><img src=\"https://tracker.example.com/pixel.gif\" alt=\"tracking pixel\"><a href=\"https://example.com/listing\">A link</a>"
                "<script>alert('x')</script><a href=\"javascript:alert(1)\">bad link</a></p>")}})
        if with_attachment:
            parts.append({"partId": "2", "mimeType": "application/pdf", "filename": "sample-checklist-mock.pdf",
                          "body": {"attachmentId": f"att-{mid}", "size": 18}})
        payload = {"mimeType": "multipart/mixed" if with_attachment else "multipart/alternative", "headers": headers, "parts": parts}
        snippet = body if len(body) <= 48 else body[:48].rsplit(" ", 1)[0] + "…"
        return {"id": mid, "threadId": tid, "labelIds": labels, "snippet": snippet, "internalDate": _ms(when),
                "historyId": "1500", "payload": payload, "_message_id": message_id}

    def route(self, req):
        u = urlsplit(req.url)
        if u.netloc == "oauth2.googleapis.com":
            return self._oauth(req, u.path)
        if u.netloc != "gmail.googleapis.com":
            return _json(404, {"error": {"code": 404, "message": "Not found", "status": "NOT_FOUND"}})
        account = self.bearer(req)
        if account is None:
            return _json(401, {"error": {"code": 401, "message": "Invalid Credentials", "status": "UNAUTHENTICATED"}})
        box = self.mailbox(account)
        path = u.path.removeprefix("/gmail/v1/users/me")
        p = _params(req)
        if path == "/profile":
            return _json(200, {"emailAddress": account, "messagesTotal": 7, "threadsTotal": len(box["threads"]), "historyId": str(box["history_id"])})
        if path == "/threads" and req.method == "GET":
            q = _one(p, "q").lower()
            rows = sorted(box["threads"].values(), key=lambda t: -int(t["messages"][-1]["internalDate"]))
            terms = [w for w in q.split() if ":" not in w]
            if terms:
                rows = [t for t in rows if all(any(w in json.dumps(m["payload"]["headers"]).lower() or w in m["snippet"].lower()
                                                   for m in t["messages"]) for w in terms)]
            limit = int(_one(p, "maxResults", "100"))
            return _json(200, {"threads": [{"id": t["id"], "snippet": t["messages"][-1]["snippet"], "historyId": t["historyId"]} for t in rows[:limit]],
                               "resultSizeEstimate": len(rows)})
        if path.startswith("/threads/"):
            t = box["threads"].get(unquote(path.split("/")[2]))
            if t is None:
                return _json(404, {"error": {"code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND"}})
            fmt = _one(p, "format", "full")
            return _json(200, {"id": t["id"], "historyId": t["historyId"], "messages": [self._shape(m, fmt) for m in t["messages"]]})
        if path == "/history":
            start = int(_one(p, "startHistoryId", "0") or 0)
            if start < box["history_id"] - 100000 or start <= 0:
                return _json(404, {"error": {"code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND"}})
            changes = [h for h in box.get("history", []) if h["id"] > start]
            return _json(200, {"history": [{"id": str(h["id"]), "messagesAdded": [{"message": {"id": h["mid"], "threadId": h["tid"]}}]} for h in changes],
                               "historyId": str(box["history_id"])})
        if path.startswith("/messages/"):
            segs = path.split("/")
            mid = unquote(segs[2])
            msg = next((m for t in box["threads"].values() for m in t["messages"] if m["id"] == mid), None)
            if msg is None:
                return _json(404, {"error": {"code": 404, "message": "Not Found", "status": "NOT_FOUND"}})
            if len(segs) >= 5 and segs[3] == "attachments":
                return _json(200, {"attachmentId": unquote(segs[4]), "size": 18, "data": _b64("%PDF-1.4 mock file")})
            return _json(200, self._shape(msg, _one(p, "format", "full")))
        if path == "/drafts" and req.method == "POST":
            draft_id = f"r-mock-{secrets.token_hex(4)}"
            box["drafts"][draft_id] = (req.json or {}).get("message") or {}
            return _json(200, {"id": draft_id, "message": {"id": f"m-{draft_id}", "threadId": box["drafts"][draft_id].get("threadId")}})
        if path == "/drafts/send" and req.method == "POST":
            body = req.json or {}
            draft = box["drafts"].pop(str(body.get("id")), None)
            if draft is None:
                return _json(404, {"error": {"code": 404, "message": "Not found", "status": "NOT_FOUND"}})
            tid = (body.get("message") or {}).get("threadId") or draft.get("threadId")
            mid = f"sent-{secrets.token_hex(4)}"
            box["sent"].append({"id": mid, "threadId": tid, "raw": (body.get("message") or {}).get("raw", "")})
            t = box["threads"].get(tid)
            if t is not None:
                first = t["messages"][0]["payload"]["headers"]
                to = next((h["value"] for h in first if h["name"] == "From"), "")
                subject = next((h["value"] for h in first if h["name"] == "Subject"), "")
                t["messages"].append(self._message(mid, tid, "Me", account, to, f"Re: {subject}", _now(), unread=False,
                                                   body="(Sent from Nexus through the mock provider.)", sent=True))
                box["history_id"] += 1
                t["historyId"] = str(box["history_id"])
                box.setdefault("history", []).append({"id": box["history_id"], "mid": mid, "tid": tid})
            return _json(200, {"id": mid, "threadId": tid, "labelIds": ["SENT"]})
        if path.startswith("/drafts/"):
            draft_id = unquote(path.split("/")[2])
            if draft_id not in box["drafts"]:
                return _json(404, {"error": {"code": 404, "message": "Not found", "status": "NOT_FOUND"}})
            if req.method == "DELETE":
                box["drafts"].pop(draft_id, None)
                return HttpResponse(status=204)
            if req.method == "PUT":
                box["drafts"][draft_id] = (req.json or {}).get("message") or {}
                return _json(200, {"id": draft_id})
        return _json(404, {"error": {"code": 404, "message": "Not found", "status": "NOT_FOUND"}})

    @staticmethod
    def _shape(m: dict, fmt: str) -> dict:
        out = {k: v for k, v in m.items() if not k.startswith("_")}
        if fmt == "metadata":
            out["payload"] = {"mimeType": m["payload"]["mimeType"], "headers": m["payload"]["headers"]}
        elif fmt == "minimal":
            out.pop("payload", None)
        return out

    def _oauth(self, req, path):
        form = req.form or {}
        if path == "/revoke":
            token = str(form.get("token") or "")
            if not token.startswith(MOCK_PREFIX):
                return _json(400, {"error": "invalid_token"})
            self.revoked.add(token)
            return _json(200, {})
        if path != "/token":
            return _json(404, {"error": "not_found"})
        grant = form.get("grant_type")
        if grant == "authorization_code":
            entry = self.redeem(str(form.get("code") or ""), str(form.get("code_verifier") or ""), str(form.get("redirect_uri") or ""))
            if entry is None:
                return _json(400, {"error": "invalid_grant", "error_description": "Bad Request"})
            account = entry["account"]
            return _json(200, {"access_token": self.token("access", account), "expires_in": 3599, "token_type": "Bearer",
                               "refresh_token": self.token("refresh", account),
                               "scope": entry["extra"].get("scope") or "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"})
        if grant == "refresh_token":
            token = str(form.get("refresh_token") or "")
            account = self.account_of(token)
            if account is None or self.refresh_rejected:
                return _json(400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
            self.refresh_count += 1
            return _json(200, {"access_token": self.token("access", account), "expires_in": 3599, "token_type": "Bearer"})
        return _json(400, {"error": "unsupported_grant_type"})


# --- Slack ------------------------------------------------------------------------------------------

SLACK_TEAM = {"id": "T0MOCK0001", "name": "Harborview demo Slack (mock)"}
SLACK_USERS = {"U0MOCKA01": "Riley (mock)", "U0MOCKB02": "Jordan (mock)", "U0MOCKBOT": "Nexus bot (mock)"}
SLACK_CHANNELS = [
    {"id": "C0MOCKSALES", "name": "sales-mock", "is_private": False, "is_member": True, "num_members": 6},
    {"id": "C0MOCKLEADS", "name": "new-leads-mock", "is_private": False, "is_member": True, "num_members": 4},
    {"id": "C0MOCKRANDOM", "name": "random-mock", "is_private": False, "is_member": False, "num_members": 9},
]


class FakeSlack(FakeProvider):
    name = "slack"

    def __init__(self):
        super().__init__()
        self.posted: list[dict] = []
        now = _now().timestamp()
        self.history = {
            "C0MOCKSALES": [
                {"type": "message", "user": "U0MOCKA01", "text": "Synthetic mock message: <@U0MOCKB02> can you check the sample listing notes?",
                 "ts": f"{now - 3600:.6f}"},
                {"type": "message", "user": "U0MOCKB02", "text": "Synthetic mock reply in the sales channel.", "ts": f"{now - 1800:.6f}"},
            ],
            "C0MOCKLEADS": [
                {"type": "message", "user": "U0MOCKA01", "text": "Synthetic mock lead note for testing (not real).", "ts": f"{now - 7200:.6f}"},
            ],
        }

    def route(self, req):
        u = urlsplit(req.url)
        method = u.path.removeprefix("/api/")
        if method == "oauth.v2.access":
            form = req.form or {}
            if form.get("grant_type") == "refresh_token":
                if self.refresh_rejected or self.account_of(str(form.get("refresh_token") or "")) is None:
                    return _json(200, {"ok": False, "error": "invalid_refresh_token"})
                self.refresh_count += 1
                return _json(200, {"ok": True, "access_token": self.token("xoxe", SLACK_TEAM["id"]), "expires_in": 43200,
                                   "refresh_token": self.token("refresh", SLACK_TEAM["id"]), "token_type": "bot"})
            entry = self.redeem(str(form.get("code") or ""), "", str(form.get("redirect_uri") or ""))
            if entry is None:
                return _json(200, {"ok": False, "error": "invalid_code"})
            scope = entry["extra"].get("scope") or "channels:read,channels:history,chat:write,users:read"
            return _json(200, {"ok": True, "access_token": self.token("xoxb", SLACK_TEAM["id"]), "token_type": "bot", "scope": scope,
                               "bot_user_id": "U0MOCKBOT", "app_id": "A0MOCKAPP", "team": SLACK_TEAM, "enterprise": None,
                               "is_enterprise_install": False})
        team = self.bearer(req)
        if team is None:
            return _json(200, {"ok": False, "error": "invalid_auth"})
        p = _params(req)
        form = req.form or {}
        if method == "auth.test":
            return _json(200, {"ok": True, "team": SLACK_TEAM["name"], "team_id": SLACK_TEAM["id"], "user_id": "U0MOCKBOT", "bot_id": "B0MOCK"})
        if method == "auth.revoke":
            token = (req.headers.get("Authorization") or "")[7:]
            self.revoked.add(token)
            return _json(200, {"ok": True, "revoked": True})
        if method == "conversations.list":
            return _json(200, {"ok": True, "channels": SLACK_CHANNELS, "response_metadata": {"next_cursor": ""}})
        if method == "conversations.history":
            ch = _one(p, "channel")
            if ch not in self.history:
                return _json(200, {"ok": False, "error": "not_in_channel" if ch == "C0MOCKRANDOM" else "channel_not_found"})
            return _json(200, {"ok": True, "messages": list(reversed(self.history[ch])), "has_more": False})
        if method == "users.info":
            uid = _one(p, "user")
            if uid not in SLACK_USERS:
                return _json(200, {"ok": False, "error": "user_not_found"})
            return _json(200, {"ok": True, "user": {"id": uid, "name": uid.lower(), "profile": {"display_name": SLACK_USERS[uid]}}})
        if method == "chat.getPermalink":
            ch, ts = _one(p, "channel"), _one(p, "message_ts")
            return _json(200, {"ok": True, "channel": ch, "permalink": f"https://mock-slack.example.com/archives/{ch}/p{ts.replace('.', '')}"})
        if method == "chat.postMessage":
            ch = str(form.get("channel") or "")
            if ch not in self.history:
                return _json(200, {"ok": False, "error": "not_in_channel"})
            ts = f"{_now().timestamp():.6f}"
            msg = {"type": "message", "bot_id": "B0MOCK", "user": "U0MOCKBOT", "text": str(form.get("text") or ""), "ts": ts}
            self.history[ch].append(msg)
            self.posted.append({"channel": ch, **msg})
            return _json(200, {"ok": True, "channel": ch, "ts": ts, "message": msg})
        return _json(200, {"ok": False, "error": "unknown_method"})


# --- HighLevel --------------------------------------------------------------------------------------

GHL_LOCATION = {"id": "mockLocation001", "name": "Harborview demo sub-account (mock)", "companyId": "mockCompany001"}


class FakeHighLevel(FakeProvider):
    name = "ghl"

    def __init__(self):
        super().__init__()
        self.workflow_triggers: list[tuple[str, str]] = []
        self.created: list[dict] = []
        self.contacts = {
            "mockContact01": {"id": "mockContact01", "firstName": "Harper", "lastName": "Sample", "email": "harper.sample@example.com",
                              "phone": "+12025550101", "tags": ["mock", "buyer"], "dateUpdated": "2026-10-10T10:00:00.000Z"},
            "mockContact02": {"id": "mockContact02", "firstName": "Pat", "lastName": "Mockperson", "email": "pat.mock@example.org",
                              "phone": "+12025550190", "tags": ["mock"], "dateUpdated": "2026-10-11T10:00:00.000Z"},
            "mockContact03": {"id": "mockContact03", "firstName": "Rowan", "lastName": "Example", "email": "rowan@example.net",
                              "phone": "+12025550103", "companyName": "Example Holdings LLC", "tags": ["mock", "investor"]},
        }

    def route(self, req):
        u = urlsplit(req.url)
        path = u.path
        if path == "/oauth/token":
            form = req.form or {}
            if form.get("grant_type") == "refresh_token":
                if self.refresh_rejected or self.account_of(str(form.get("refresh_token") or "")) is None:
                    return _json(401, {"statusCode": 401, "message": "Invalid grant: refresh token is invalid", "error": "Unauthorized"})
                self.refresh_count += 1
                return _json(200, {"access_token": self.token("access", GHL_LOCATION["id"]), "token_type": "Bearer", "expires_in": 86399,
                                   "refresh_token": self.token("refresh", GHL_LOCATION["id"]), "userType": "Location",
                                   "locationId": GHL_LOCATION["id"], "companyId": GHL_LOCATION["companyId"], "userId": "mockUser01"})
            entry = self.redeem(str(form.get("code") or ""), "", str(form.get("redirect_uri") or ""))
            if entry is None:
                return _json(400, {"statusCode": 400, "message": "Invalid code", "error": "Bad Request"})
            return _json(200, {"access_token": self.token("access", GHL_LOCATION["id"]), "token_type": "Bearer", "expires_in": 86399,
                               "refresh_token": self.token("refresh", GHL_LOCATION["id"]), "scope": entry["extra"].get("scope", ""),
                               "userType": "Location", "locationId": GHL_LOCATION["id"], "companyId": GHL_LOCATION["companyId"], "userId": "mockUser01"})
        auth = (req.headers.get("Authorization") or "")[7:]
        location = self.bearer(req) or (GHL_LOCATION["id"] if auth.startswith("pit-mock-") and not self.access_rejected else None)
        if location is None:
            return _json(401, {"statusCode": 401, "message": "Invalid JWT", "error": "Unauthorized"})
        if not req.headers.get("Version"):
            return _json(400, {"statusCode": 400, "message": "Version header is required"})
        p = _params(req)
        rl = {"X-RateLimit-Limit-Daily": "200000", "X-RateLimit-Daily-Remaining": "199000", "X-RateLimit-Interval-Milliseconds": "10000",
              "X-RateLimit-Max": "100", "X-RateLimit-Remaining": "99"}
        if path.startswith("/locations/") and path.count("/") == 2:
            if unquote(path.split("/")[2]) != GHL_LOCATION["id"]:
                return _json(403, {"statusCode": 403, "message": "The token does not have access to this location"})
            return _json(200, {"location": GHL_LOCATION}, rl)
        if path == "/contacts/search" and req.method == "POST":
            q = str((req.json or {}).get("query") or "").lower()
            rows = [c for c in self.contacts.values() if not q or q in json.dumps(c).lower()]
            return _json(200, {"contacts": rows, "total": len(rows)}, rl)
        if path == "/contacts/lookup":
            email, phone = _one(p, "email").lower(), _one(p, "phone")
            rows = [c for c in self.contacts.values() if (email and c.get("email") == email) or (phone and c.get("phone") == phone)]
            return _json(200, {"contacts": rows}, rl)
        if path in {"/contacts/", "/contacts"} and req.method == "POST":
            cid = f"mockContact{len(self.contacts) + 1:02d}"
            body = {k: v for k, v in (req.json or {}).items() if k != "locationId"}
            self.contacts[cid] = {"id": cid, **body}
            self.created.append(self.contacts[cid])
            return _json(201, {"contact": self.contacts[cid]}, rl)
        if path.startswith("/contacts/"):
            segs = path.strip("/").split("/")
            cid = unquote(segs[1])
            c = self.contacts.get(cid)
            if c is None:
                return _json(400, {"statusCode": 400, "message": "Contact not found"})
            if len(segs) == 2 and req.method == "GET":
                return _json(200, {"contact": c}, rl)
            if len(segs) == 2 and req.method == "PUT":
                c.update({k: v for k, v in (req.json or {}).items() if k in {"firstName", "lastName", "email", "phone"}})
                return _json(200, {"succeded": True, "contact": c}, rl)
            if segs[2:] == ["tasks"]:
                return _json(200, {"tasks": [{"id": "mockTask01", "title": "Sample follow-up task (mock)", "dueDate": "2026-10-20T15:00:00.000Z",
                                              "completed": False, "contactId": cid}]}, rl)
            if segs[2:] == ["appointments"]:
                return _json(200, {"events": [{"id": "mockAppt01", "title": "Sample appointment (mock)", "startTime": "2026-10-21 10:00:00",
                                               "endTime": "2026-10-21 10:30:00", "appointmentStatus": "confirmed", "contactId": cid}]}, rl)
            if len(segs) == 4 and segs[2] == "workflow" and req.method == "POST":
                self.workflow_triggers.append((cid, unquote(segs[3])))
                return _json(200, {"succeeded": True}, rl)
        if path == "/opportunities/pipelines":
            return _json(200, {"pipelines": [{"id": "mockPipe01", "name": "Sample buyer pipeline (mock)", "locationId": GHL_LOCATION["id"],
                                              "stages": [{"id": "mockStage01", "name": "New"}, {"id": "mockStage02", "name": "Showing"}]}]}, rl)
        if path == "/opportunities/search":
            if _one(p, "page", "1") != "1":
                return _json(200, {"opportunities": [], "meta": {"total": 2}}, rl)
            return _json(200, {"opportunities": [
                {"id": "mockOpp01", "name": "Sample opportunity A (mock)", "monetaryValue": 450000, "pipelineId": "mockPipe01",
                 "pipelineStageId": "mockStage02", "status": "open", "contactId": "mockContact01",
                 "contact": {"id": "mockContact01", "name": "Harper Sample", "email": "harper.sample@example.com"}, "updatedAt": "2026-10-12T09:00:00.000Z"},
                {"id": "mockOpp02", "name": "Sample opportunity B (mock)", "monetaryValue": 0, "pipelineId": "mockPipe01",
                 "pipelineStageId": "mockStage01", "status": "open", "contactId": "mockContact02",
                 "contact": {"id": "mockContact02", "name": "Pat Mockperson"}, "updatedAt": "2026-10-13T09:00:00.000Z"},
            ], "meta": {"total": 2, "currentPage": 1}}, rl)
        if path == "/conversations/search":
            return _json(200, {"conversations": [
                {"id": "mockConv01", "contactId": "mockContact01", "locationId": GHL_LOCATION["id"], "lastMessageBody": "Synthetic mock SMS (not real).",
                 "lastMessageType": "TYPE_SMS", "type": "TYPE_PHONE", "unreadCount": 1, "fullName": "Harper Sample", "contactName": "Harper Sample",
                 "email": "harper.sample@example.com", "phone": "+12025550101"},
                {"id": "mockConv02", "contactId": "mockContact02", "locationId": GHL_LOCATION["id"], "lastMessageBody": "",
                 "lastMessageType": "TYPE_CALL", "type": "TYPE_PHONE", "unreadCount": 1, "fullName": "Pat Mockperson", "contactName": "Pat Mockperson",
                 "email": "pat.mock@example.org", "phone": "+12025550190"},
            ], "total": 2}, rl)
        if path.startswith("/conversations/") and path.endswith("/messages"):
            conv = unquote(path.split("/")[2])
            now = _now()
            if conv == "mockConv02":
                msgs = [{"id": "mockMsgCall01", "type": 1, "messageType": "TYPE_CALL", "locationId": GHL_LOCATION["id"], "contactId": "mockContact02",
                         "conversationId": conv, "dateAdded": (now - dt.timedelta(hours=2)).isoformat().replace("+00:00", "Z"), "direction": "inbound",
                         "status": "completed", "contentType": "text/plain", "meta": {"callStatus": "no-answer", "callDuration": "0"}}]
            else:
                msgs = [{"id": "mockMsg01", "type": 2, "messageType": "TYPE_SMS", "locationId": GHL_LOCATION["id"], "contactId": "mockContact01",
                         "conversationId": conv, "dateAdded": (now - dt.timedelta(hours=5)).isoformat().replace("+00:00", "Z"), "direction": "inbound",
                         "status": "delivered", "body": "Synthetic mock SMS (not real).", "contentType": "text/plain"}]
            return _json(200, {"messages": {"lastMessageId": msgs[-1]["id"], "nextPage": False, "messages": msgs}}, rl)
        if path.endswith("/tags"):
            return _json(200, {"tags": [{"id": "mockTag01", "name": "mock-buyer", "locationId": GHL_LOCATION["id"]}]}, rl)
        if path.endswith("/customFields"):
            return _json(200, {"customFields": [{"id": "mockField01", "name": "Sample budget (mock)", "fieldKey": "contact.sample_budget",
                                                 "dataType": "MONETORY", "model": "contact"}]}, rl)
        if path in {"/workflows/", "/workflows"}:
            return _json(200, {"workflows": [{"id": "mockWorkflow01", "name": "Sample nurture workflow (mock)", "status": "published"}]}, rl)
        if path.startswith("/marketplace/app/") and req.method == "DELETE":
            return _json(200, {"success": True}, rl)
        return _json(404, {"statusCode": 404, "message": "Not found"})


class FakeProviderTransport:
    """Routes requests by host to the fake providers. Unknown hosts are refused, so nothing
    can leak to the network while mock mode or a test uses this transport."""

    def __init__(self):
        self.google = FakeGoogle()
        self.slack = FakeSlack()
        self.ghl = FakeHighLevel()

    def send(self, request: HttpRequest) -> HttpResponse:
        host = urlsplit(request.url).netloc
        if host in {"oauth2.googleapis.com", "gmail.googleapis.com"}:
            return self.google.handle(request)
        if host == "slack.com":
            return self.slack.handle(request)
        if host == "services.leadconnectorhq.com":
            return self.ghl.handle(request)
        raise AssertionError(f"mock transport refused a request to {host}")

    def provider(self, name: str) -> FakeProvider:
        return {"gmail": self.google, "google": self.google, "slack": self.slack, "gohighlevel": self.ghl, "ghl": self.ghl}[name]


_transport: FakeProviderTransport | None = None
_lock = threading.Lock()


def mock_transport() -> FakeProviderTransport:
    global _transport
    with _lock:
        if _transport is None:
            _transport = FakeProviderTransport()
        return _transport
