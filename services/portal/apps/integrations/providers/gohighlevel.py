"""GoHighLevel (HighLevel API v2 at services.leadconnectorhq.com) through a Marketplace app
(OAuth 2.0, Sub-Account token) or a Private Integration Token of one sub-account.

Verified 2026-10-17 against marketplace.gohighlevel.com/docs (docs/nexus/INTEGRATIONS.md):
authorization page ``https://marketplace.gohighlevel.com/v2/oauth/chooselocation``
(response_type=code, redirect_uri, client_id, scope); ``POST /oauth/token`` (form-encoded;
grant_type authorization_code|refresh_token, user_type=Location; refresh tokens are
single-use and rotate; access tokens last about a day); every request sends
``Version: <NEXUS_GHL_API_VERSION>`` (latest published: v3); rate limits per app and
sub-account: 100 requests per 10 seconds and 200,000 per day, reported in
X-RateLimit-* headers. Endpoints used: GET /locations/{id}, POST /contacts/search,
GET /contacts/lookup, GET /contacts/{id}, GET /contacts/{id}/tasks,
GET /contacts/{id}/appointments, POST /contacts/, PUT /contacts/{id},
GET /opportunities/search, GET /opportunities/pipelines, GET /conversations/search,
GET /conversations/{id}/messages, GET /locations/{id}/tags, GET /locations/{id}/customFields,
GET /workflows/, POST /contacts/{id}/workflow/{workflowId} (only in production, only when an
admin enabled it, and only after confirmation), DELETE /marketplace/app/{appId}/installations
(on disconnect, when the app ID and the oauth.write scope are configured).

HighLevel does not document a ``state`` parameter or PKCE for its authorization page: we send
``state`` and verify it when it comes back; when it does not, the callback is accepted only
for the single pending, unexpired flow bound to the same browser session and person.
"""

from __future__ import annotations

import datetime as dt
from urllib.parse import quote, urlencode

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .. import conf
from ..http import (
    AuthExpired,
    Forbidden,
    HttpResponse,
    ProviderBadRequest,
    ProviderClient,
    ProviderError,
    ProviderNotFound,
    RateLimited,
    ReauthRequired,
    ScopeMissing,
    parse_retry_after,
)
from ..models import ExternalRecord, InboxItem, IntegrationConnection, Provider
from ..tokens import TokenSet
from .base import AccountInfo, Adapter, OAuthFailed, SyncResult, clip, parse_iso, upsert_mapping

MISSED_CALL_STATUSES = {"no-answer", "voicemail", "busy", "failed", "canceled"}
CONTACT_FIELDS = ("id", "firstName", "lastName", "name", "email", "phone", "companyName", "tags", "source", "assignedTo",
                  "dateAdded", "dateUpdated", "type")


def classify(resp: HttpResponse) -> ProviderError | None:
    if resp.status == 429:
        interval = resp.headers.get("X-RateLimit-Interval-Milliseconds")
        retry = parse_retry_after(resp.headers.get("Retry-After"))
        if retry is None and interval:
            try:
                retry = int(interval) / 1000
            except ValueError:
                retry = None
        daily = resp.headers.get("X-RateLimit-Daily-Remaining")
        if daily is not None and str(daily).strip() == "0":
            return RateLimited(status=429, retry_after=3600, detail="daily_limit")
        return RateLimited(status=429, retry_after=retry, detail="burst_limit")
    if resp.status == 401:
        return AuthExpired(status=401)
    if resp.status == 403:
        text = str(resp.json())[:500].lower()
        if "scope" in text:
            return ScopeMissing(status=403)
        return Forbidden(status=403)
    if resp.status == 422:
        return ProviderBadRequest(status=422)
    return None


def contact_summary(c: dict) -> dict:
    out = {k: c.get(k) for k in CONTACT_FIELDS if c.get(k) not in (None, "")}
    out["tags"] = [clip(t, 80) for t in (c.get("tags") or []) if isinstance(t, str)][:30]
    for k in ("firstName", "lastName", "name", "email", "phone", "companyName", "source"):
        if k in out:
            out[k] = clip(out[k], 200)
    full = f"{c.get('firstName') or ''} {c.get('lastName') or ''}".strip()
    out["display_name"] = clip(c.get("name") or full or c.get("email") or c.get("phone") or "Unnamed contact", 200)
    return out


class GoHighLevelAdapter(Adapter):
    provider = Provider.GOHIGHLEVEL

    def scopes(self, options=None):
        scopes = [s for s, _ in conf.GHL_SCOPES]
        if settings.NEXUS_GHL_APP_ID:
            scopes.append("oauth.write")  # lets disconnect call the documented uninstall API
        return scopes

    def headers(self) -> dict[str, str]:
        return {"Version": settings.NEXUS_GHL_API_VERSION}

    def authorization_url(self, *, state, redirect_uri, code_challenge, options):
        params = {
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "client_id": settings.NEXUS_GHL_CLIENT_ID or "mock-ghl-client",
            "scope": " ".join(self.scopes()),
            "state": state,
        }
        base = f"{conf.base_url()}/integrations/mock/crm-connector/authorize" if conf.mock_mode() else conf.GHL_AUTHORIZE_URL
        return f"{base}?{urlencode(params)}"

    def _oauth(self) -> ProviderClient:
        return ProviderClient(self.provider, classify=classify, extra_headers=self.headers())

    def _token(self, form: dict) -> dict:
        try:
            return self._oauth().request("POST", conf.GHL_TOKEN_URL, form=form, auth=False, idempotent=False).json()
        except (ProviderBadRequest, Forbidden) as exc:
            raise ReauthRequired(detail="invalid_grant") from exc

    def exchange_code(self, code, *, redirect_uri, code_verifier):
        try:
            data = self._token({
                "client_id": settings.NEXUS_GHL_CLIENT_ID or "mock-ghl-client",
                "client_secret": settings.NEXUS_GHL_CLIENT_SECRET or "mock-ghl-secret",
                "grant_type": "authorization_code",
                "code": code,
                "user_type": "Location",
                "redirect_uri": redirect_uri,
            })
        except (ReauthRequired, ProviderError):
            raise OAuthFailed("code_rejected", "HighLevel didn't accept the authorization. Try connecting again.") from None
        if not data.get("access_token"):
            raise OAuthFailed("code_rejected", "HighLevel didn't return an access token. Try connecting again.")
        if str(data.get("userType") or "Location") != "Location" or not data.get("locationId"):
            raise OAuthFailed("agency_install_unsupported", "Install the app on one sub-account (not agency-wide) to connect it here.")
        tokens = TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"), expires_in=data.get("expires_in"),
                          scopes=str(data.get("scope") or "").split())
        return tokens, {"location_id": clip(data.get("locationId"), 120), "company_id": clip(data.get("companyId"), 120)}

    def identify(self, tokens, raw):
        location_id = raw["location_id"]
        client = ProviderClient(self.provider, classify=classify, extra_headers=self.headers())
        client.tokens = _Static(tokens.access_token)
        try:
            data = client.request("GET", f"{conf.GHL_API}/locations/{quote(location_id, safe='')}").json()
        except (ProviderNotFound, Forbidden, ScopeMissing):
            raise OAuthFailed("location_unreadable",
                              "The token can't read that sub-account (check the location ID and the locations.readonly scope).") from None
        except ReauthRequired:
            raise OAuthFailed("token_rejected", "HighLevel rejected the token.") from None
        loc = data.get("location") or {}
        return AccountInfo(
            account_id=location_id, label=clip(loc.get("name") or location_id, 255), scopes=tokens.scopes or [],
            settings={"workflow_triggers_enabled": False},
            sync_state={"company_id": raw.get("company_id") or clip(loc.get("companyId"), 120)},
        )

    def refresh_tokens(self, connection, refresh_token):
        data = self._token({
            "client_id": settings.NEXUS_GHL_CLIENT_ID or "mock-ghl-client",
            "client_secret": settings.NEXUS_GHL_CLIENT_SECRET or "mock-ghl-secret",
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "user_type": "Location",
            "redirect_uri": conf.redirect_uri(self.provider),
        })
        if not data.get("access_token"):
            raise ReauthRequired(detail="invalid_grant")
        return TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"), expires_in=data.get("expires_in"))

    def revoke(self, connection):
        if connection.auth_method != IntegrationConnection.AuthMethod.OAUTH or not settings.NEXUS_GHL_APP_ID:
            return False
        if "oauth.write" not in (connection.granted_scopes or []):
            return False
        try:
            self.client(connection).request("DELETE", f"{conf.GHL_API}/marketplace/app/{quote(settings.NEXUS_GHL_APP_ID, safe='')}/installations",
                                            json={"locationId": connection.account_id, "reason": "Disconnected in Nexus Office"})
            return True
        except ProviderError:
            return False

    def client(self, connection):
        return ProviderClient(self.provider, tokens=self.tokens(connection), classify=classify, extra_headers=self.headers())

    # --- API -------------------------------------------------------------------------------------
    def location(self, connection) -> str:
        return quote(connection.account_id, safe="")

    def search_contacts(self, connection, query: str, *, limit: int = 20) -> list[dict]:
        body = {"locationId": connection.account_id, "pageLimit": max(1, min(limit, 50))}
        if query:
            body["query"] = query
        data = self.client(connection).request("POST", f"{conf.GHL_API}/contacts/search", json=body, idempotent=True).json()
        return [contact_summary(c) for c in data.get("contacts") or [] if isinstance(c, dict) and c.get("id")]

    def lookup_contacts(self, connection, *, email: str = "", phone: str = "") -> list[dict]:
        params = {"locationId": connection.account_id, "limit": 20}
        if email:
            params["email"] = email
        elif phone:
            params["phone"] = phone
        else:
            return []
        data = self.client(connection).request("GET", f"{conf.GHL_API}/contacts/lookup", params=params).json()
        return [contact_summary(c) for c in data.get("contacts") or [] if isinstance(c, dict) and c.get("id")]

    def get_contact(self, connection, contact_id: str) -> dict:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/contacts/{quote(contact_id, safe='')}").json()
        c = data.get("contact") or {}
        if not c.get("id"):
            raise ProviderNotFound()
        summary = contact_summary(c)
        upsert_external(connection, ExternalRecord.Kind.CONTACT, c["id"], summary["display_name"], summary, c.get("dateUpdated"))
        return summary

    def contact_tasks(self, connection, contact_id: str) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/contacts/{quote(contact_id, safe='')}/tasks").json()
        return [{"id": clip(t.get("id"), 80), "title": clip(t.get("title"), 300), "body": clip(t.get("body"), 2000),
                 "due_date": clip(t.get("dueDate"), 40), "completed": bool(t.get("completed")), "assigned_to": clip(t.get("assignedTo"), 80)}
                for t in data.get("tasks") or [] if isinstance(t, dict)]

    def contact_appointments(self, connection, contact_id: str) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/contacts/{quote(contact_id, safe='')}/appointments").json()
        return [{"id": clip(e.get("id"), 80), "title": clip(e.get("title"), 300), "start_time": clip(e.get("startTime"), 40),
                 "end_time": clip(e.get("endTime"), 40), "status": clip(e.get("appointmentStatus") or e.get("status"), 40),
                 "address": clip(e.get("address"), 300)}
                for e in data.get("events") or [] if isinstance(e, dict)]

    def conversation_messages(self, connection, conversation_id: str, *, limit: int = 20) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/conversations/{quote(conversation_id, safe='')}/messages",
                                               params={"limit": max(1, min(limit, 50))}).json()
        box = data.get("messages") or {}
        rows = box.get("messages") if isinstance(box, dict) else box
        out = []
        for m in rows or []:
            if not isinstance(m, dict):
                continue
            meta = m.get("meta") if isinstance(m.get("meta"), dict) else {}
            out.append({
                "id": clip(m.get("id"), 80), "type": clip(m.get("messageType"), 60), "direction": clip(m.get("direction"), 20),
                "status": clip(m.get("status"), 30), "body": clip(m.get("body"), 4000), "date": clip(m.get("dateAdded"), 40),
                "call_status": clip(meta.get("callStatus"), 30), "call_duration": clip(meta.get("callDuration"), 20),
                "attachments": len(m.get("attachments") or []),
            })
        return out

    def tags(self, connection) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/locations/{self.location(connection)}/tags").json()
        return [{"id": clip(t.get("id"), 80), "name": clip(t.get("name"), 120)} for t in data.get("tags") or [] if isinstance(t, dict)]

    def custom_fields(self, connection) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/locations/{self.location(connection)}/customFields",
                                               params={"model": "all"}).json()
        return [{"id": clip(f.get("id"), 80), "name": clip(f.get("name"), 200), "key": clip(f.get("fieldKey"), 200),
                 "data_type": clip(f.get("dataType"), 40), "model": clip(f.get("model"), 20)}
                for f in data.get("customFields") or [] if isinstance(f, dict)]

    def workflows(self, connection) -> list[dict]:
        data = self.client(connection).request("GET", f"{conf.GHL_API}/workflows/", params={"locationId": connection.account_id}).json()
        return [{"id": clip(w.get("id"), 80), "name": clip(w.get("name"), 200), "status": clip(w.get("status"), 30)}
                for w in data.get("workflows") or [] if isinstance(w, dict)]

    def create_contact(self, connection, fields: dict) -> dict:
        body = {"locationId": connection.account_id, **fields}
        data = self.client(connection).request("POST", f"{conf.GHL_API}/contacts/", json=body, idempotent=False).json()
        c = data.get("contact") or {}
        if not c.get("id"):
            raise ProviderBadRequest("HighLevel didn't confirm the contact was created.", code="create_unconfirmed")
        return contact_summary(c)

    def update_contact(self, connection, contact_id: str, fields: dict) -> dict:
        data = self.client(connection).request("PUT", f"{conf.GHL_API}/contacts/{quote(contact_id, safe='')}", json=fields,
                                               idempotent=False).json()
        c = data.get("contact") or {"id": contact_id, **fields}
        return contact_summary(c)

    def add_to_workflow(self, connection, contact_id: str, workflow_id: str) -> dict:
        data = self.client(connection).request(
            "POST", f"{conf.GHL_API}/contacts/{quote(contact_id, safe='')}/workflow/{quote(workflow_id, safe='')}", json={}, idempotent=False,
        ).json()
        if not (data.get("succeeded") or data.get("succeded")):
            raise ProviderBadRequest("HighLevel didn't confirm the workflow was started.", code="workflow_unconfirmed")
        return {"succeeded": True}

    def health(self, connection):
        return {"rate_limit": (connection.sync_state or {}).get("rate_limit")}

    # --- sync --------------------------------------------------------------------------------------
    def sync(self, connection, *, budget_pages=4):
        result = SyncResult()
        client = self.client(connection)
        loc = connection.account_id
        state = dict(connection.sync_state or {})
        data = client.request("GET", f"{conf.GHL_API}/opportunities/pipelines", params={"locationId": loc}).json()
        stage_names = {}
        for p in data.get("pipelines") or []:
            if isinstance(p, dict) and p.get("id"):
                stages = [{"id": clip(s.get("id"), 80), "name": clip(s.get("name"), 120)} for s in p.get("stages") or [] if isinstance(s, dict)]
                for s in stages:
                    stage_names[s["id"]] = s["name"]
                upsert_external(connection, ExternalRecord.Kind.PIPELINE, p["id"], clip(p.get("name"), 200),
                                {"name": clip(p.get("name"), 200), "stages": stages})
        result.pages += 1
        seen_opps = []
        for page in range(1, max(1, budget_pages) + 1):
            data = client.request("GET", f"{conf.GHL_API}/opportunities/search",
                                  params={"locationId": loc, "status": "all", "limit": 100, "page": page}).json()
            result.pages += 1
            rows = [o for o in data.get("opportunities") or [] if isinstance(o, dict) and o.get("id")]
            for o in rows:
                contact = o.get("contact") if isinstance(o.get("contact"), dict) else {}
                summary = {
                    "name": clip(o.get("name"), 200), "monetary_value": o.get("monetaryValue"), "status": clip(o.get("status"), 20),
                    "pipeline_id": clip(o.get("pipelineId"), 80), "stage_id": clip(o.get("pipelineStageId"), 80),
                    "stage_name": stage_names.get(o.get("pipelineStageId"), ""), "assigned_to": clip(o.get("assignedTo"), 80),
                    "contact": {"id": clip(contact.get("id") or o.get("contactId"), 80), "name": clip(contact.get("name"), 200),
                                "email": clip(contact.get("email"), 200), "phone": clip(contact.get("phone"), 60)},
                    "updated_at": clip(o.get("updatedAt"), 40), "source": clip(o.get("source"), 120),
                }
                _, created = upsert_external(connection, ExternalRecord.Kind.OPPORTUNITY, o["id"], summary["name"], summary, o.get("updatedAt"))
                result.created += int(created)
                result.updated += int(not created)
                seen_opps.append(o["id"])
            nxt = (data.get("meta") or {}).get("nextPage")
            if not rows or not nxt:
                break
        data = client.request("GET", f"{conf.GHL_API}/conversations/search",
                              params={"locationId": loc, "limit": 50, "sortBy": "last_message_date", "sort": "desc"}).json()
        result.pages += 1
        for c in data.get("conversations") or []:
            if not isinstance(c, dict) or not c.get("id"):
                continue
            item = upsert_conversation(connection, c, result=result)
            if item is not None and item.data.get("needs_messages"):
                try:
                    self._refresh_conversation(connection, client, item)
                except ProviderError as exc:
                    if isinstance(exc, (ReauthRequired, RateLimited)):
                        raise
        now = timezone.now()
        last_meta = parse_iso(state.get("metadata_synced_at"))
        if not last_meta or now - last_meta > dt.timedelta(hours=6):
            for t in self.tags(connection):
                upsert_external(connection, ExternalRecord.Kind.TAG, t["id"], t["name"], t)
            for f in self.custom_fields(connection):
                upsert_external(connection, ExternalRecord.Kind.CUSTOM_FIELD, f["id"], f["name"], f)
            state["metadata_synced_at"] = now.isoformat()
        connection.sync_state = state
        IntegrationConnection.objects.filter(pk=connection.pk).update(sync_state=state)
        return result

    def _refresh_conversation(self, connection, client, item: InboxItem) -> None:
        messages = self.conversation_messages(connection, item.external_id, limit=5)
        latest = messages[0] if messages else None
        data = {**item.data, "needs_messages": False}
        fields = ["data", "updated_at"]
        if latest:
            when = parse_iso(latest["date"])
            if when:
                item.occurred_at = when
                fields.append("occurred_at")
            data["last_direction"] = latest["direction"]
        item.data = data
        item.save(update_fields=fields)
        for m in messages:
            if m["type"] in {"TYPE_CALL", "CALL"} and m["direction"] == "inbound" and m["call_status"] in MISSED_CALL_STATUSES:
                record_missed_call(connection, item, m)


class _Static:
    def __init__(self, token: str):
        self._t = token

    def access_token(self) -> str:
        return self._t

    def refresh(self) -> str:
        raise ReauthRequired()


def upsert_external(connection, kind: str, external_id: str, title: str, data: dict, updated=None) -> tuple[ExternalRecord, bool]:
    rec, created = ExternalRecord.objects.update_or_create(
        connection=connection, kind=kind, external_id=clip(external_id, 255),
        defaults={"workspace_id": connection.workspace_id, "title": clip(title, 300), "data": data,
                  "external_updated_at": parse_iso(updated) if isinstance(updated, str) else None, "fetched_at": timezone.now(),
                  "is_demo": connection.is_mock},
    )
    return rec, created


def ghl_contact_url(connection, contact_id: str) -> str:
    # The HighLevel web app (not an API). White-label agencies use their own domain.
    return f"https://app.gohighlevel.com/v2/location/{quote(connection.account_id, safe='')}/contacts/detail/{quote(contact_id, safe='')}"


def ghl_conversation_url(connection, conversation_id: str) -> str:
    return f"https://app.gohighlevel.com/v2/location/{quote(connection.account_id, safe='')}/conversations/conversations/{quote(conversation_id, safe='')}"


@transaction.atomic
def upsert_conversation(connection, c: dict, *, result: SyncResult | None = None) -> InboxItem | None:
    cid = clip(c.get("id"), 255)
    existing = InboxItem.objects.filter(connection=connection, external_id=cid).first()
    body = clip(c.get("lastMessageBody") or c.get("body"), 2000)
    name = clip(c.get("fullName") or c.get("contactName") or c.get("email") or c.get("phone") or "Contact", 200)
    changed = existing is None or existing.snippet != body
    data = dict(existing.data) if existing else {}
    data.update({
        "contact_id": clip(c.get("contactId"), 80) or data.get("contact_id", ""),
        "conversation_type": clip(c.get("type"), 40) or data.get("conversation_type", ""),
        "last_message_type": clip(c.get("lastMessageType") or c.get("messageTypeString"), 60) or data.get("last_message_type", ""),
        "needs_messages": bool(changed) or data.get("needs_messages", False),
    })
    when = parse_iso(c.get("dateAdded")) if isinstance(c.get("dateAdded"), str) else None
    defaults = {
        "workspace_id": connection.workspace_id,
        "source": Provider.GOHIGHLEVEL,
        "kind": InboxItem.Kind.GHL_CONVERSATION,
        "visibility": InboxItem.Visibility.WORKSPACE,
        "title": name if (c.get("fullName") or c.get("contactName") or not existing) else existing.title,
        "snippet": body,
        "participants": [{"name": name, "address": clip(c.get("email") or c.get("phone"), 254)}],
        "external_url": ghl_conversation_url(connection, cid),
        "group_key": f"gohighlevel:{connection.pk}:conversation:{cid}"[:200],
        "group_label": name,
        "provider_unread": int(c.get("unreadCount") or 0) > 0 if "unreadCount" in c else (existing.provider_unread if existing else False),
        "data": data,
        "is_demo": connection.is_mock,
    }
    if when:
        defaults["occurred_at"] = when
    elif existing is None:
        defaults["occurred_at"] = timezone.now()
    item, created = InboxItem.objects.update_or_create(connection=connection, external_id=cid, defaults=defaults)
    upsert_mapping(connection, f"{connection.account_id}:conversation:{cid}", item, external_url=item.external_url)
    if result is not None:
        if created:
            result.created += 1
        elif changed:
            result.updated += 1
    return item


def record_missed_call(connection, conversation: InboxItem, m: dict) -> InboxItem:
    external_id = f"call:{m['id']}"
    item, _ = InboxItem.objects.update_or_create(
        connection=connection, external_id=external_id,
        defaults={
            "workspace_id": connection.workspace_id, "source": Provider.GOHIGHLEVEL, "kind": InboxItem.Kind.MISSED_CALL,
            "visibility": InboxItem.Visibility.WORKSPACE, "title": f"Missed call from {conversation.title}"[:300],
            "snippet": {"voicemail": "Left a voicemail."}.get(m.get("call_status"), "The call wasn't answered."),
            "participants": conversation.participants, "occurred_at": parse_iso(m.get("date")) or timezone.now(),
            "external_url": conversation.external_url, "group_key": conversation.group_key, "group_label": conversation.group_label,
            "data": {"conversation_id": conversation.external_id, "contact_id": conversation.data.get("contact_id", ""),
                     "call_status": m.get("call_status", "")},
            "is_demo": connection.is_mock,
        },
    )
    upsert_mapping(connection, f"{connection.account_id}:{external_id}", item, external_url=item.external_url)
    return item
