"""The common adapter interface every provider implements, and shared helpers."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone

from apps.crm.models import ExternalRecordMapping

from ..http import ProviderClient
from ..models import IntegrationConnection
from ..tokens import ConnectionTokens, TokenSet


@dataclass
class AccountInfo:
    account_id: str
    label: str
    scopes: list[str]
    settings: dict[str, Any] = field(default_factory=dict)
    sync_state: dict[str, Any] = field(default_factory=dict)


@dataclass
class SyncResult:
    created: int = 0
    updated: int = 0
    deleted: int = 0
    pages: int = 0
    complete: bool = True
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"created": self.created, "updated": self.updated, "deleted": self.deleted, "complete": self.complete}


class OAuthFailed(Exception):
    """The authorization could not be completed (code exchange refused, wrong account type).
    ``code`` is shown to the person through the SPA; nothing from the provider is echoed."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Adapter:
    """One provider. Adapters are stateless; per-connection state lives in the connection
    (``settings``, ``sync_state``) and its encrypted credential."""

    provider: str = ""
    uses_pkce: bool = False
    supports_refresh: bool = True

    # --- OAuth -----------------------------------------------------------------------------
    def scopes(self, options: dict | None = None) -> list[str]:
        raise NotImplementedError

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str | None, options: dict) -> str:
        raise NotImplementedError

    def exchange_code(self, code: str, *, redirect_uri: str, code_verifier: str | None) -> tuple[TokenSet, dict]:
        raise NotImplementedError

    def identify(self, tokens: TokenSet, raw: dict) -> AccountInfo:
        raise NotImplementedError

    def refresh_tokens(self, connection: IntegrationConnection, refresh_token: str) -> TokenSet:
        raise NotImplementedError

    def revoke(self, connection: IntegrationConnection) -> bool:
        """Revokes the grant at the provider when its API supports it. Returns whether the
        provider confirmed. Never raises for provider errors (disconnect must succeed)."""
        return False

    # --- API -------------------------------------------------------------------------------
    def client(self, connection: IntegrationConnection) -> ProviderClient:
        raise NotImplementedError

    def tokens(self, connection: IntegrationConnection) -> ConnectionTokens:
        return ConnectionTokens(connection, self)

    def sync(self, connection: IntegrationConnection, *, budget_pages: int = 4) -> SyncResult:
        raise NotImplementedError

    def health(self, connection: IntegrationConnection) -> dict:
        return {}


def upsert_mapping(connection: IntegrationConnection, external_id: str, obj, *, external_url: str = "", state: dict | None = None) -> ExternalRecordMapping:
    """Idempotency/dedup record: one mapping per (workspace, provider, external_id)."""
    mapping, _ = ExternalRecordMapping.objects.update_or_create(
        workspace_id=connection.workspace_id,
        provider=connection.provider,
        external_id=external_id[:255],
        defaults={
            "object_type": obj._meta.label_lower,
            "object_id": obj.pk,
            "external_url": (external_url or "")[:500],
            "last_synced_at": timezone.now(),
            "sync_state": state or {},
            "is_demo": connection.is_mock,
        },
    )
    return mapping


def parse_iso(value) -> dt.datetime | None:
    if not value or not isinstance(value, str):
        return None
    from django.utils.dateparse import parse_datetime

    try:
        parsed = parse_datetime(value.strip())
    except ValueError:
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed


def from_millis(value) -> dt.datetime | None:
    try:
        return dt.datetime.fromtimestamp(int(value) / 1000, tz=dt.UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def clip(value, n: int) -> str:
    if value is None:
        return ""
    text = str(value).replace("\x00", "")
    return text[:n]
