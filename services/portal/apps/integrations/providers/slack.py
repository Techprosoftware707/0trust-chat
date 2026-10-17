"""Slack through the official OAuth v2 flow and Web API (bot token).

Verified 2026-10-17 against docs.slack.dev (docs/nexus/INTEGRATIONS.md): authorize
``https://slack.com/oauth/v2/authorize`` (client_id, comma-separated bot ``scope``,
redirect_uri, state), ``oauth.v2.access`` (code exchange; ``grant_type=refresh_token`` when
token rotation is on), ``auth.test``, ``auth.revoke``, ``conversations.list`` (Tier 2),
``conversations.history`` (Tier 3 for internal apps; 1 request/minute and limit 15 for new
non-Marketplace commercially distributed apps since 2025-05-29), ``chat.getPermalink``,
``chat.postMessage`` (about 1 message per second per channel), ``users.info``. Errors come
back as HTTP 200 with ``{"ok": false, "error": ...}``; rate limits as HTTP 429 with
``Retry-After``. PKCE is not used: on Slack it turns the app into a public client, while this
server is a confidential client that keeps the client secret.

What is stored: messages of the channels an admin selected (text, author ID and name, time,
thread, mentions), for ``NEXUS_SLACK_RETENTION_DAYS``. Nothing from other channels.
"""

from __future__ import annotations

import datetime as dt
import re
from urllib.parse import urlencode

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
    RateLimited,
    ReauthRequired,
    ScopeMissing,
    parse_retry_after,
)
from ..models import InboxItem, IntegrationConnection, Provider
from ..tokens import TokenSet
from .base import AccountInfo, Adapter, OAuthFailed, SyncResult, clip, upsert_mapping

AUTH_ERRORS = {"invalid_auth", "not_authed", "token_revoked", "account_inactive", "token_expired", "no_permission"}
MENTION_RE = re.compile(r"<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>")
STORED_SUBTYPES = {None, "", "thread_broadcast", "bot_message", "file_share", "me_message"}


def classify(resp: HttpResponse) -> ProviderError | None:
    if resp.status == 429:
        return RateLimited(status=429, retry_after=parse_retry_after(resp.headers.get("Retry-After")))
    if not resp.ok:
        return None
    body = resp.json()
    if not isinstance(body, dict) or body.get("ok", False):
        return None
    error = str(body.get("error") or "unknown_error")[:60]
    if error in AUTH_ERRORS:
        return AuthExpired(status=200, detail=error)
    if error == "missing_scope":
        return ScopeMissing(status=200, detail=error)
    if error == "ratelimited":
        return RateLimited(status=200, detail=error)
    messages = {
        "not_in_channel": "The Slack app isn't in that channel. Invite it there with /invite first.",
        "channel_not_found": "Slack can't find that channel (or the app can't see it).",
        "is_archived": "That Slack channel is archived.",
        "msg_too_long": "That message is too long for Slack.",
    }
    return ProviderBadRequest(messages.get(error, "Slack rejected the request."), code=f"slack_{error}", status=200, detail=error)


def ts_to_datetime(ts: str) -> dt.datetime:
    try:
        return dt.datetime.fromtimestamp(float(ts), tz=dt.UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return timezone.now()


class SlackAdapter(Adapter):
    provider = Provider.SLACK

    def scopes(self, options=None):
        scopes = [s for s, _ in conf.SLACK_BOT_SCOPES]
        if (options or {}).get("private_channels"):
            scopes += [s for s, _ in conf.SLACK_PRIVATE_SCOPES]
        return scopes

    def authorization_url(self, *, state, redirect_uri, code_challenge, options):
        params = {
            "client_id": settings.NEXUS_SLACK_CLIENT_ID or "mock-slack-client",
            "scope": ",".join(self.scopes(options)),
            "redirect_uri": redirect_uri,
            "state": state,
        }
        base = f"{conf.base_url()}/integrations/mock/slack/authorize" if conf.mock_mode() else conf.SLACK_AUTHORIZE_URL
        return f"{base}?{urlencode(params)}"

    def _client(self) -> ProviderClient:
        return ProviderClient(self.provider, classify=classify)

    def exchange_code(self, code, *, redirect_uri, code_verifier):
        try:
            data = self._client().request("POST", f"{conf.SLACK_API}/oauth.v2.access", auth=False, idempotent=False, form={
                "code": code,
                "client_id": settings.NEXUS_SLACK_CLIENT_ID or "mock-slack-client",
                "client_secret": settings.NEXUS_SLACK_CLIENT_SECRET or "mock-slack-secret",
                "redirect_uri": redirect_uri,
            }).json()
        except ProviderError:
            raise OAuthFailed("code_rejected", "Slack didn't accept the authorization. Try connecting again.") from None
        if not data.get("access_token") or str(data.get("token_type") or "bot") != "bot":
            raise OAuthFailed("code_rejected", "Slack didn't return a bot token. Try connecting again.")
        if data.get("is_enterprise_install") or not (data.get("team") or {}).get("id"):
            raise OAuthFailed("enterprise_install_unsupported",
                              "Org-wide (Enterprise Grid) installs aren't supported yet. Install the app to one Slack workspace.")
        tokens = TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"), expires_in=data.get("expires_in"),
                          scopes=[s for s in str(data.get("scope") or "").split(",") if s])
        return tokens, {"team": data.get("team") or {}, "bot_user_id": data.get("bot_user_id"), "app_id": data.get("app_id")}

    def identify(self, tokens, raw):
        team = raw.get("team") or {}
        return AccountInfo(
            account_id=clip(team.get("id"), 255), label=clip(team.get("name") or team.get("id"), 255), scopes=tokens.scopes or [],
            settings={"channels": [], "private_channels": "groups:history" in (tokens.scopes or []), "member_map": {}},
            sync_state={"bot_user_id": clip(raw.get("bot_user_id"), 40), "app_id": clip(raw.get("app_id"), 40)},
        )

    def refresh_tokens(self, connection, refresh_token):
        try:
            data = self._client().request("POST", f"{conf.SLACK_API}/oauth.v2.access", auth=False, idempotent=False, form={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": settings.NEXUS_SLACK_CLIENT_ID or "mock-slack-client",
                "client_secret": settings.NEXUS_SLACK_CLIENT_SECRET or "mock-slack-secret",
            }).json()
        except (ProviderBadRequest, ReauthRequired) as exc:
            raise ReauthRequired(detail="invalid_refresh_token") from exc
        if not data.get("access_token"):
            raise ReauthRequired(detail="invalid_refresh_token")
        return TokenSet(access_token=data["access_token"], refresh_token=data.get("refresh_token"), expires_in=data.get("expires_in"))

    def revoke(self, connection):
        try:
            data = self.client(connection).request("GET", f"{conf.SLACK_API}/auth.revoke").json()
            return bool(data.get("revoked"))
        except ProviderError:
            return False

    def client(self, connection):
        return ProviderClient(self.provider, tokens=self.tokens(connection), classify=classify)

    # --- API ----------------------------------------------------------------------------------
    def channels(self, connection) -> list[dict]:
        client = self.client(connection)
        types = "public_channel,private_channel" if (connection.settings or {}).get("private_channels") else "public_channel"
        out: list[dict] = []
        cursor = None
        for _ in range(5):
            params = {"types": types, "exclude_archived": "true", "limit": 200}
            if cursor:
                params["cursor"] = cursor
            data = client.request("GET", f"{conf.SLACK_API}/conversations.list", params=params).json()
            for c in data.get("channels") or []:
                if isinstance(c, dict) and c.get("id"):
                    out.append({"id": clip(c["id"], 40), "name": clip(c.get("name"), 120), "is_private": bool(c.get("is_private")),
                                "is_member": bool(c.get("is_member")), "num_members": int(c.get("num_members") or 0)})
            cursor = (data.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                break
        return out

    def permalink(self, connection, channel: str, ts: str) -> str:
        data = self.client(connection).request("GET", f"{conf.SLACK_API}/chat.getPermalink", params={"channel": channel, "message_ts": ts}).json()
        link = str(data.get("permalink") or "")
        return link if link.startswith("https://") else ""

    def post_message(self, connection, channel: str, text: str, thread_ts: str = "") -> dict:
        form = {"channel": channel, "text": text, "unfurl_links": "false", "unfurl_media": "false"}
        if thread_ts:
            form["thread_ts"] = thread_ts
        data = self.client(connection).request("POST", f"{conf.SLACK_API}/chat.postMessage", form=form, idempotent=False).json()
        if not data.get("ts"):
            raise ProviderBadRequest("Slack didn't confirm the message was posted.", code="post_unconfirmed")
        return {"channel": str(data.get("channel") or channel), "ts": str(data["ts"])}

    def user_name(self, connection, client, user_id: str) -> str:
        data = client.request("GET", f"{conf.SLACK_API}/users.info", params={"user": user_id}).json()
        user = data.get("user") or {}
        profile = user.get("profile") or {}
        return clip(profile.get("display_name") or profile.get("real_name") or user.get("name") or user_id, 120)

    def health(self, connection):
        data = self.client(connection).request("GET", f"{conf.SLACK_API}/auth.test").json()
        return {"team": clip(data.get("team"), 120), "ok": bool(data.get("ok", True))}

    # --- sync ---------------------------------------------------------------------------------
    def sync(self, connection, *, budget_pages=4):
        """Events are the main path. The job checks the connection, back-fills newly selected
        channels once (one page each), resolves author names and refreshes channel names."""
        result = SyncResult()
        client = self.client(connection)
        client.request("GET", f"{conf.SLACK_API}/auth.test")
        state = dict(connection.sync_state or {})
        selected = {c["id"]: c for c in (connection.settings or {}).get("channels") or []}
        backfilled = set(state.get("backfilled") or [])
        oldest = (timezone.now() - dt.timedelta(days=settings.NEXUS_SLACK_RETENTION_DAYS)).timestamp()
        for cid, channel in list(selected.items())[:budget_pages]:
            if cid in backfilled:
                continue
            data = client.request("GET", f"{conf.SLACK_API}/conversations.history",
                                  params={"channel": cid, "limit": 50, "oldest": f"{oldest:.6f}"}).json()
            result.pages += 1
            for msg in data.get("messages") or []:
                if isinstance(msg, dict):
                    if store_message(connection, cid, channel.get("name") or cid, msg, result=result) is None:
                        continue
            backfilled.add(cid)
        state["backfilled"] = sorted(backfilled & set(selected))
        names = dict(state.get("user_names") or {})
        unknown = (InboxItem.objects.filter(connection=connection, data__user_name="").exclude(data__user="")
                   .values_list("data__user", flat=True).distinct()[:20])
        for uid in unknown:
            if uid and uid not in names:
                try:
                    names[uid] = self.user_name(connection, client, uid)
                except ProviderError:
                    break
        if names:
            names = dict(list(names.items())[-500:])
            state["user_names"] = names
            for item in InboxItem.objects.filter(connection=connection, data__user_name="").exclude(data__user=""):
                if item.data.get("user") in names:
                    item.data = {**item.data, "user_name": names[item.data["user"]]}
                    item.participants = [{"name": names[item.data["user"]], "address": item.data["user"]}]
                    item.group_label = item.group_label or f"#{item.data.get('channel_name', '')}"
                    item.save(update_fields=["data", "participants", "group_label", "updated_at"])
        connection.sync_state = state
        IntegrationConnection.objects.filter(pk=connection.pk).update(sync_state=state)
        return result


@transaction.atomic
def store_message(connection: IntegrationConnection, channel: str, channel_name: str, msg: dict, *, result: SyncResult | None = None) -> InboxItem | None:
    """Stores one message of a selected channel (idempotent by channel + ts)."""
    subtype = msg.get("subtype")
    if subtype not in STORED_SUBTYPES:
        return None
    ts = clip(msg.get("ts"), 40)
    if not ts:
        return None
    names = (connection.sync_state or {}).get("user_names") or {}
    user = clip(msg.get("user") or msg.get("bot_id"), 40)
    text = clip(msg.get("text"), 4000)
    mentions = sorted(set(MENTION_RE.findall(text)))[:20]
    bot_user = (connection.sync_state or {}).get("bot_user_id") or ""
    external_id = f"{channel}:{ts}"
    defaults = {
        "workspace_id": connection.workspace_id,
        "source": Provider.SLACK,
        "kind": InboxItem.Kind.SLACK_MESSAGE,
        "visibility": InboxItem.Visibility.WORKSPACE,
        "title": clip(f"#{channel_name}", 300),
        "snippet": text,
        "participants": [{"name": names.get(user, ""), "address": user}] if user else [],
        "occurred_at": ts_to_datetime(ts),
        "group_key": f"slack:{connection.pk}:channel:{channel}"[:200],
        "group_label": clip(f"#{channel_name}", 200),
        "data": {
            "channel": channel, "channel_name": clip(channel_name, 120), "ts": ts, "thread_ts": clip(msg.get("thread_ts"), 40),
            "user": user, "user_name": names.get(user, ""), "mentions": mentions, "mentions_app": bool(bot_user and bot_user in mentions),
            "bot": bool(msg.get("bot_id")), "subtype": subtype or "", "reply_count": int(msg.get("reply_count") or 0),
        },
        "has_attachments": bool(msg.get("files")),
        "is_demo": connection.is_mock,
    }
    item, created = InboxItem.objects.update_or_create(connection=connection, external_id=external_id, defaults=defaults)
    upsert_mapping(connection, f"{connection.account_id}:message:{external_id}", item)
    if result is not None:
        if created:
            result.created += 1
        else:
            result.updated += 1
    return item


def delete_message(connection: IntegrationConnection, channel: str, ts: str) -> int:
    from apps.crm.models import ExternalRecordMapping

    external_id = f"{channel}:{ts}"
    ExternalRecordMapping.objects.filter(workspace_id=connection.workspace_id, provider=Provider.SLACK,
                                         external_id=f"{connection.account_id}:message:{external_id}").delete()
    deleted, _ = InboxItem.objects.filter(connection=connection, external_id=external_id).delete()
    return deleted
