"""Gmail through the official Gmail API (OAuth 2.0 web-server flow, offline access, PKCE).

Verified 2026-10-17 against developers.google.com (docs/nexus/INTEGRATIONS.md):
authorization ``https://accounts.google.com/o/oauth2/v2/auth`` (access_type=offline,
prompt=consent, state, code_challenge/S256), token and refresh ``https://oauth2.googleapis.com/token``,
revoke ``https://oauth2.googleapis.com/revoke``; ``users.getProfile``, ``users.threads.list``
(``q``), ``users.threads.get`` (format=metadata, metadataHeaders), ``users.history.list``
(startHistoryId; 404 = too old -> full sync), ``users.messages.get`` (format=full, on demand),
``users.messages.attachments.get``, ``users.drafts.create/update/delete/send``. Replies in a
thread need threadId, RFC 2822 In-Reply-To/References and a matching Subject.

What is stored: thread and message metadata (subject, from/to/cc, dates, label IDs,
snippets, Message-ID/References for replies, attachment names and sizes once a message was
opened). Bodies and attachments are never stored.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import email.utils
import hashlib
from email.message import EmailMessage as MimeMessage
from email.policy import SMTP
from urllib.parse import quote, urlencode

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .. import conf
from ..http import (
    AuthExpired,
    HttpResponse,
    ProviderBadRequest,
    ProviderClient,
    ProviderError,
    ProviderNotFound,
    RateLimited,
    ReauthRequired,
    ScopeMissing,
)
from ..models import EmailMessage, InboxItem, IntegrationConnection, Provider
from ..sanitize import html_to_text, normalize_text, sanitize_html
from ..tokens import TokenSet
from .base import AccountInfo, Adapter, OAuthFailed, SyncResult, clip, from_millis, upsert_mapping

METADATA_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "References", "In-Reply-To"]
SKIP_LABELS = {"SPAM", "TRASH"}
MAX_THREADS_PER_RUN = 50
INITIAL_WINDOW_DAYS = 30
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024


def classify(resp: HttpResponse) -> ProviderError | None:
    """Google API errors: {"error": {"code", "message", "errors": [{"reason"}], "status"}}."""
    if resp.ok:
        return None
    body = resp.json()
    err = body.get("error") if isinstance(body, dict) else None
    reasons = set()
    status_text = ""
    if isinstance(err, dict):
        status_text = str(err.get("status") or "")
        for e in err.get("errors") or []:
            if isinstance(e, dict) and e.get("reason"):
                reasons.add(str(e["reason"]))
    elif isinstance(err, str):  # OAuth endpoints: {"error": "invalid_grant"}
        reasons.add(err)
    if resp.status == 401:
        return AuthExpired(status=401)
    if resp.status == 403:
        if reasons & {"rateLimitExceeded", "userRateLimitExceeded"} or status_text == "RESOURCE_EXHAUSTED":
            return RateLimited(status=403, detail="rate_limit")
        if "dailyLimitExceeded" in reasons:
            return RateLimited(status=403, retry_after=3600, detail="daily_limit")
        if "insufficientPermissions" in reasons or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in str(body)[:2000]:
            return ScopeMissing(status=403)
        return None
    return None


def _b64url_decode(data: str) -> bytes:
    data = data or ""
    try:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    except (binascii.Error, ValueError):
        return b""


def _headers(part: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for h in part.get("headers") or []:
        if isinstance(h, dict) and h.get("name"):
            out.setdefault(str(h["name"]).lower(), str(h.get("value") or ""))
    return out


def _addresses(value: str, limit: int = 20) -> list[dict]:
    out = []
    for name, addr in email.utils.getaddresses([value or ""])[:limit]:
        if addr or name:
            out.append({"name": clip(name, 200), "address": clip(addr, 254).lower()})
    return out


def _parse_date(value: str) -> dt.datetime | None:
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed


def gmail_thread_url(account: str, thread_id: str) -> str:
    # The Gmail web UI (not an API): opens the thread in the right signed-in account.
    return f"https://mail.google.com/mail/?authuser={quote(account)}#all/{quote(thread_id)}"


class GmailAdapter(Adapter):
    provider = Provider.GMAIL
    uses_pkce = True

    def scopes(self, options=None):
        return [s for s, _ in conf.GMAIL_SCOPES]

    def _oauth_client(self) -> ProviderClient:
        return ProviderClient(self.provider, classify=classify)

    def authorization_url(self, *, state, redirect_uri, code_challenge, options):
        params = {
            "client_id": settings.NEXUS_GOOGLE_CLIENT_ID or "mock-google-client",
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes()),
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if options.get("login_hint"):
            params["login_hint"] = options["login_hint"]
        base = f"{conf.base_url()}/integrations/mock/google/authorize" if conf.mock_mode() else conf.GOOGLE_AUTHORIZE_URL
        return f"{base}?{urlencode(params)}"

    def _token_request(self, form: dict) -> dict:
        resp = None
        try:
            resp = self._oauth_client().request("POST", conf.GOOGLE_TOKEN_URL, form=form, auth=False, idempotent=False)
        except ProviderBadRequest as exc:
            raise ReauthRequired(detail="invalid_grant") from exc
        except AuthExpired as exc:
            raise ReauthRequired(detail="invalid_client") from exc
        return resp.json()

    def exchange_code(self, code, *, redirect_uri, code_verifier):
        form = {
            "code": code,
            "client_id": settings.NEXUS_GOOGLE_CLIENT_ID or "mock-google-client",
            "client_secret": settings.NEXUS_GOOGLE_CLIENT_SECRET or "mock-google-secret",
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
        if code_verifier:
            form["code_verifier"] = code_verifier
        try:
            data = self._token_request(form)
        except ReauthRequired:
            raise OAuthFailed("code_rejected", "Google didn't accept the authorization. Try connecting again.") from None
        if not data.get("access_token"):
            raise OAuthFailed("code_rejected", "Google didn't return an access token. Try connecting again.")
        if not data.get("refresh_token"):
            raise OAuthFailed("no_offline_access", "Google didn't grant offline access. Remove the app's access in your Google account and connect again.")
        tokens = TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"),
                          expires_in=data.get("expires_in"), refresh_expires_in=data.get("refresh_token_expires_in"),
                          scopes=str(data.get("scope") or "").split())
        return tokens, {}

    def identify(self, tokens, raw):
        granted = tokens.scopes or []
        missing = [s for s in self.scopes() if s not in granted]
        if conf.GMAIL_SCOPES[0][0] in missing:
            raise OAuthFailed("scope_denied", "Reading your mail wasn't allowed, so Gmail can't be connected. Connect again and keep “Read” checked.")
        client = ProviderClient(self.provider, classify=classify)
        client.tokens = _StaticTokens(tokens.access_token)
        profile = client.request("GET", f"{conf.GMAIL_API}/profile").json()
        address = str(profile.get("emailAddress") or "").lower()
        if not address:
            raise OAuthFailed("no_account", "Google didn't tell us which mailbox this is. Try again.")
        return AccountInfo(account_id=address, label=address, scopes=granted, sync_state={})

    def refresh_tokens(self, connection, refresh_token):
        data = self._token_request({
            "client_id": settings.NEXUS_GOOGLE_CLIENT_ID or "mock-google-client",
            "client_secret": settings.NEXUS_GOOGLE_CLIENT_SECRET or "mock-google-secret",
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })
        if not data.get("access_token"):
            raise ReauthRequired(detail="invalid_grant")
        return TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"), expires_in=data.get("expires_in"),
                        scopes=str(data.get("scope") or "").split() or None)

    def revoke(self, connection):
        from ..tokens import read_tokens

        try:
            access, refresh = read_tokens(connection)
        except Exception:
            return False
        token = refresh or access
        if not token:
            return False
        try:
            self._oauth_client().request("POST", conf.GOOGLE_REVOKE_URL, form={"token": token}, auth=False, idempotent=False)
            return True
        except ProviderBadRequest:
            return True  # already invalid: nothing left to revoke
        except ProviderError:
            return False

    def client(self, connection):
        return ProviderClient(self.provider, tokens=self.tokens(connection), classify=classify)

    # --- sync ------------------------------------------------------------------------------
    def sync(self, connection, *, budget_pages=4):
        client = self.client(connection)
        state = dict(connection.sync_state or {})
        result = SyncResult()
        history_id = state.get("history_id")
        thread_ids: list[str] = []
        if history_id:
            try:
                thread_ids, new_history = self._history(client, history_id, budget_pages, result)
                state["history_id"] = new_history or history_id
            except ProviderNotFound:
                history_id = None  # too old: start over with a full sync (documented 404)
                result.notes.append("history_reset")
        if not history_id:
            profile = client.request("GET", f"{conf.GMAIL_API}/profile").json()
            state["history_id"] = str(profile.get("historyId") or "")
            thread_ids = self._recent_thread_ids(client, budget_pages, result)
        for tid in thread_ids[:MAX_THREADS_PER_RUN]:
            self.refresh_thread(connection, tid, client=client, result=result)
        if len(thread_ids) > MAX_THREADS_PER_RUN:
            result.complete = False
        state["last_full_sync"] = state.get("last_full_sync") or timezone.now().isoformat()
        connection.sync_state = state
        IntegrationConnection.objects.filter(pk=connection.pk).update(sync_state=state)
        return result

    def _recent_thread_ids(self, client, budget_pages, result) -> list[str]:
        days = min(INITIAL_WINDOW_DAYS, settings.NEXUS_GMAIL_RETENTION_DAYS)
        ids: list[str] = []
        page_token = None
        for _ in range(max(1, budget_pages)):
            params = {"maxResults": 25, "q": f"newer_than:{days}d -in:spam -in:trash"}
            if page_token:
                params["pageToken"] = page_token
            data = client.request("GET", f"{conf.GMAIL_API}/threads", params=params).json()
            result.pages += 1
            ids += [t["id"] for t in data.get("threads") or [] if isinstance(t, dict) and t.get("id")]
            page_token = data.get("nextPageToken")
            if not page_token or len(ids) >= MAX_THREADS_PER_RUN:
                break
        return ids

    def _history(self, client, history_id, budget_pages, result) -> tuple[list[str], str]:
        ids: list[str] = []
        page_token = None
        latest = history_id
        for _ in range(max(1, budget_pages)):
            params = [("startHistoryId", history_id), ("maxResults", 200)]
            for t in ("messageAdded", "messageDeleted", "labelAdded", "labelRemoved"):
                params.append(("historyTypes", t))
            if page_token:
                params.append(("pageToken", page_token))
            data = client.request("GET", f"{conf.GMAIL_API}/history", params=params).json()
            result.pages += 1
            for h in data.get("history") or []:
                for key in ("messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"):
                    for entry in h.get(key) or []:
                        msg = entry.get("message") if isinstance(entry, dict) else None
                        if isinstance(msg, dict) and msg.get("threadId") and msg["threadId"] not in ids:
                            ids.append(msg["threadId"])
                for msg in h.get("messages") or []:
                    if isinstance(msg, dict) and msg.get("threadId") and msg["threadId"] not in ids:
                        ids.append(msg["threadId"])
            latest = str(data.get("historyId") or latest)
            page_token = data.get("nextPageToken")
            if not page_token:
                return ids, latest
        result.complete = False
        return ids, history_id  # not finished: start from the same point next time

    def refresh_thread(self, connection, thread_id: str, *, client=None, result: SyncResult | None = None) -> InboxItem | None:
        client = client or self.client(connection)
        params = [("format", "metadata")] + [("metadataHeaders", h) for h in METADATA_HEADERS]
        try:
            data = client.request("GET", f"{conf.GMAIL_API}/threads/{quote(thread_id, safe='')}", params=params).json()
        except ProviderNotFound:
            deleted, _ = InboxItem.objects.filter(connection=connection, external_id=thread_id).delete()
            if result is not None and deleted:
                result.deleted += 1
            return None
        return upsert_thread(connection, data, result=result)

    # --- on demand ---------------------------------------------------------------------------
    def search(self, connection, q: str, *, limit: int = 20) -> list[InboxItem]:
        client = self.client(connection)
        data = client.request("GET", f"{conf.GMAIL_API}/threads", params={"q": q, "maxResults": max(1, min(limit, 50))}).json()
        items = []
        for t in data.get("threads") or []:
            if not isinstance(t, dict) or not t.get("id"):
                continue
            existing = InboxItem.objects.filter(connection=connection, external_id=t["id"]).first()
            if existing is not None and existing.data.get("history_id") == str(t.get("historyId") or ""):
                items.append(existing)
                continue
            item = self.refresh_thread(connection, t["id"], client=client)
            if item is not None:
                items.append(item)
        return items

    def message_body(self, connection, message: EmailMessage) -> dict:
        client = self.client(connection)
        data = client.request("GET", f"{conf.GMAIL_API}/messages/{quote(message.external_id, safe='')}", params={"format": "full"}).json()
        text_parts: list[str] = []
        html_parts: list[str] = []
        attachments: list[dict] = []
        _walk(data.get("payload") or {}, text_parts, html_parts, attachments)
        html_raw = "\n".join(html_parts)
        safe_html, blocked = sanitize_html(html_raw) if html_raw else ("", 0)
        text = normalize_text("\n\n".join(text_parts)) if text_parts else html_to_text(html_raw)
        if attachments != message.attachments:
            message.attachments = attachments
            message.save(update_fields=["attachments", "updated_at"])
            if attachments and not message.item.has_attachments:
                InboxItem.objects.filter(pk=message.item_id).update(has_attachments=True)
        return {"text": text, "html": safe_html, "has_html": bool(html_raw), "images_blocked": blocked, "attachments": attachments}

    def attachment(self, connection, message: EmailMessage, attachment_id: str) -> bytes:
        client = self.client(connection)
        url = f"{conf.GMAIL_API}/messages/{quote(message.external_id, safe='')}/attachments/{quote(attachment_id, safe='')}"
        data = client.request("GET", url).json()
        raw = _b64url_decode(str(data.get("data") or ""))
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise ProviderBadRequest("This attachment is too large to download here. Open it in Gmail.", code="too_large")
        return raw

    # --- drafts ------------------------------------------------------------------------------
    def build_raw(self, *, sender: str, to: list[str], cc: list[str], subject: str, body: str, in_reply_to: str, references: str) -> str:
        msg = MimeMessage(policy=SMTP)
        msg["From"] = sender
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = _one_line(subject)
        if in_reply_to:
            msg["In-Reply-To"] = _one_line(in_reply_to)
            msg["References"] = _one_line(f"{references} {in_reply_to}".strip())
        msg.set_content(body or "")
        return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    def create_draft(self, connection, *, raw: str, thread_id: str) -> str:
        data = self.client(connection).request("POST", f"{conf.GMAIL_API}/drafts", json={"message": {"raw": raw, "threadId": thread_id}},
                                               idempotent=False).json()
        draft_id = str(data.get("id") or "")
        if not draft_id:
            raise ProviderBadRequest("Gmail didn't create the draft.")
        return draft_id

    def update_draft(self, connection, draft_id: str, *, raw: str, thread_id: str) -> None:
        self.client(connection).request("PUT", f"{conf.GMAIL_API}/drafts/{quote(draft_id, safe='')}",
                                        json={"id": draft_id, "message": {"raw": raw, "threadId": thread_id}})

    def delete_draft(self, connection, draft_id: str) -> None:
        try:
            self.client(connection).request("DELETE", f"{conf.GMAIL_API}/drafts/{quote(draft_id, safe='')}")
        except ProviderNotFound:
            pass

    def send_draft(self, connection, draft_id: str, *, raw: str, thread_id: str) -> dict:
        """Sends exactly the reviewed content. Never retried automatically: a failure is
        reported as not sent (the person can check Gmail and try again)."""
        data = self.client(connection).request("POST", f"{conf.GMAIL_API}/drafts/send",
                                               json={"id": draft_id, "message": {"raw": raw, "threadId": thread_id}},
                                               idempotent=False).json()
        if not data.get("id"):
            raise ProviderBadRequest("Gmail didn't confirm the message was sent.", code="send_unconfirmed")
        return {"message_id": str(data["id"]), "thread_id": str(data.get("threadId") or thread_id)}

    def health(self, connection):
        return {"history_id": bool((connection.sync_state or {}).get("history_id"))}


class _StaticTokens:
    def __init__(self, token: str):
        self._t = token

    def access_token(self) -> str:
        return self._t

    def refresh(self) -> str:
        raise ReauthRequired()


def _one_line(value: str) -> str:
    return " ".join((value or "").replace("\r", " ").replace("\n", " ").split())[:900]


def _charset(part: dict) -> str:
    ctype = _headers(part).get("content-type", "")
    for piece in ctype.split(";")[1:]:
        k, _, v = piece.strip().partition("=")
        if k.lower() == "charset" and v:
            return v.strip('"').strip()
    return "utf-8"


def _decode(part: dict) -> str:
    raw = _b64url_decode(str((part.get("body") or {}).get("data") or ""))
    try:
        return raw.decode(_charset(part), errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _walk(part: dict, text: list[str], html_parts: list[str], attachments: list[dict], depth: int = 0) -> None:
    if depth > 20 or not isinstance(part, dict):
        return
    mime = str(part.get("mimeType") or "").lower()
    body = part.get("body") or {}
    filename = str(part.get("filename") or "")
    if filename and body.get("attachmentId"):
        attachments.append({
            "id": str(body["attachmentId"])[:500],
            "part_id": clip(part.get("partId"), 40),
            "filename": clip(filename, 200),
            "mime_type": clip(mime, 100),
            "size": int(body.get("size") or 0),
        })
    elif mime == "text/plain" and body.get("data"):
        text.append(_decode(part))
    elif mime == "text/html" and body.get("data"):
        html_parts.append(_decode(part))
    for child in part.get("parts") or []:
        _walk(child, text, html_parts, attachments, depth + 1)


@transaction.atomic
def upsert_thread(connection: IntegrationConnection, data: dict, *, result: SyncResult | None = None) -> InboxItem | None:
    thread_id = str(data.get("id") or "")
    messages = [m for m in data.get("messages") or [] if isinstance(m, dict) and m.get("id")]
    if not thread_id:
        return None
    labels = set()
    for m in messages:
        labels.update(str(x) for x in m.get("labelIds") or [])
    visible = [m for m in messages if not (set(m.get("labelIds") or []) & SKIP_LABELS)]
    if not visible:
        deleted, _ = InboxItem.objects.filter(connection=connection, external_id=thread_id).delete()
        if result is not None and deleted:
            result.deleted += 1
        return None
    first, last = visible[0], visible[-1]
    h_first, h_last = _headers(first.get("payload") or {}), _headers(last.get("payload") or {})
    participants: list[dict] = []
    seen = set()
    for m in visible:
        h = _headers(m.get("payload") or {})
        for p in _addresses(h.get("from", "")) + _addresses(h.get("to", ""), 10) + _addresses(h.get("cc", ""), 10):
            if p["address"] and p["address"] not in seen and p["address"] != connection.account_id:
                seen.add(p["address"])
                participants.append(p)
    last_from = (_addresses(h_last.get("from", ""), 1) or [{"name": "", "address": ""}])[0]
    occurred = max((from_millis(m.get("internalDate")) or timezone.now()) for m in visible)
    subject = clip(h_first.get("subject") or "(no subject)", 300)
    defaults = {
        "workspace_id": connection.workspace_id,
        "source": Provider.GMAIL,
        "kind": InboxItem.Kind.EMAIL_THREAD,
        "visibility": InboxItem.Visibility.PERSONAL,
        "owner_id": connection.owner_id,
        "title": subject,
        "snippet": clip(_unescape(last.get("snippet") or ""), 1000),
        "participants": participants[:20],
        "occurred_at": occurred,
        "external_url": gmail_thread_url(connection.account_id, thread_id),
        "group_key": f"gmail:{connection.pk}:from:{last_from['address']}"[:200],
        "group_label": clip(last_from["name"] or last_from["address"], 200),
        "provider_unread": any("UNREAD" in (m.get("labelIds") or []) for m in visible),
        "message_count": len(visible),
        "data": {"thread_id": thread_id, "history_id": str(data.get("historyId") or ""), "label_ids": sorted(labels)[:30],
                 "outgoing": "SENT" in (last.get("labelIds") or [])},
        "is_demo": connection.is_mock,
    }
    item, created = InboxItem.objects.update_or_create(connection=connection, external_id=thread_id, defaults=defaults)
    keep = []
    has_attachments = False
    for m in visible:
        h = _headers(m.get("payload") or {})
        sender = (_addresses(h.get("from", ""), 1) or [{"name": "", "address": ""}])[0]
        reply_to = (_addresses(h.get("reply-to", ""), 1) or [{"address": ""}])[0]["address"]
        mime = str((m.get("payload") or {}).get("mimeType") or "").lower()
        has_attachments = has_attachments or mime == "multipart/mixed"
        EmailMessage.objects.update_or_create(
            item=item, external_id=str(m["id"]),
            defaults={
                "workspace_id": connection.workspace_id,
                "from_name": sender["name"], "from_address": sender["address"], "reply_to": reply_to,
                "to": _addresses(h.get("to", "")), "cc": _addresses(h.get("cc", "")),
                "subject": clip(h.get("subject") or subject, 300),
                "sent_at": from_millis(m.get("internalDate")) or _parse_date(h.get("date", "")) or timezone.now(),
                "snippet": clip(_unescape(m.get("snippet") or ""), 2000),
                "label_ids": [str(x) for x in (m.get("labelIds") or [])][:30],
                "rfc_message_id": clip(h.get("message-id"), 500),
                "references": clip(h.get("references"), 4000),
                "is_demo": connection.is_mock,
            },
        )
        keep.append(str(m["id"]))
    EmailMessage.objects.filter(item=item).exclude(external_id__in=keep).delete()
    if has_attachments != item.has_attachments and has_attachments:
        InboxItem.objects.filter(pk=item.pk).update(has_attachments=True)
    upsert_mapping(connection, f"{connection.account_id}:thread:{thread_id}", item, external_url=item.external_url,
                   state={"history_id": defaults["data"]["history_id"]})
    if result is not None:
        if created:
            result.created += 1
        else:
            result.updated += 1
    return item


def _unescape(value: str) -> str:
    import html

    return html.unescape(str(value or ""))


def content_hash(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()
