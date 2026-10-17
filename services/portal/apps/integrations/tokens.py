"""Credential storage and safe token refresh.

* ``store_tokens`` encrypts and saves a connection's tokens (``crypto.py``).
* ``ConnectionTokens`` hands an access token to ``ProviderClient``: it refreshes shortly
  before expiry, or once after a 401, under a row lock so two workers never spend the same
  single-use refresh token (Slack and HighLevel rotate refresh tokens on every use). A
  refresh that the provider refuses (``invalid_grant``, revoked app) moves the connection to
  ``needs_reauth`` with a reconnect action; the tokens are kept until the person reconnects
  or disconnects.
* Token values are never logged, never returned and never written anywhere else.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from django.db import transaction
from django.utils import timezone

from . import crypto
from .http import ReauthRequired
from .models import IntegrationConnection, IntegrationCredential

log = logging.getLogger("nexus.integrations")
REFRESH_MARGIN = timedelta(seconds=90)


@dataclass
class TokenSet:
    """Tokens as returned by a provider's token endpoint (in memory only)."""

    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    refresh_expires_in: int | None = None
    scopes: list[str] | None = None

    def __repr__(self) -> str:  # never print token material
        return f"<TokenSet refresh={'yes' if self.refresh_token else 'no'} expires_in={self.expires_in}>"

    __str__ = __repr__


def _aad(conn_id, kind: str) -> str:
    return f"integration-connection:{conn_id}:{kind}"


def _expiry(seconds: int | None) -> datetime | None:
    return timezone.now() + timedelta(seconds=int(seconds)) if seconds else None


def store_tokens(connection: IntegrationConnection, tokens: TokenSet, *, keep_refresh: bool = True) -> IntegrationCredential:
    """Encrypts and saves ``tokens``. When the provider did not send a new refresh token,
    the old one is kept (``keep_refresh``)."""
    cred = IntegrationCredential.objects.filter(connection=connection).first()
    is_new = cred is None
    refresh_blob = crypto.encrypt(tokens.refresh_token, aad=_aad(connection.pk, "refresh")) if tokens.refresh_token else None
    if cred is None:
        cred = IntegrationCredential(connection=connection)
    elif refresh_blob is None and keep_refresh and cred.refresh_token:
        # Re-encrypt the kept refresh token too, so the row uses only the current key.
        kept = crypto.decrypt(cred.refresh_token, aad=_aad(connection.pk, "refresh"))
        refresh_blob = crypto.encrypt(kept, aad=_aad(connection.pk, "refresh"))
    cred.access_token = crypto.encrypt(tokens.access_token, aad=_aad(connection.pk, "access"))
    cred.refresh_token = refresh_blob
    cred.access_expires_at = _expiry(tokens.expires_in)
    if tokens.refresh_expires_in:
        cred.refresh_expires_at = _expiry(tokens.refresh_expires_in)
    cred.key_id = crypto.current_key_id()
    cred.version = 1 if is_new else cred.version + 1
    cred.save()
    return cred


def rekey_all() -> dict:
    """Re-encrypts every stored credential with the current (first) key, so an old key can
    be removed from ``NEXUS_INTEGRATIONS_KEY`` afterwards. Each row is locked like a refresh,
    so a concurrent refresh is never overwritten. Returns counts only."""
    current = crypto.current_key_id()
    done = skipped = failed = 0
    for pk in IntegrationCredential.objects.values_list("pk", flat=True):
        with transaction.atomic():
            cred = IntegrationCredential.objects.select_for_update().filter(pk=pk).first()
            if cred is None or {crypto.blob_key_id(cred.access_token), crypto.blob_key_id(cred.refresh_token) or current} == {current}:
                skipped += 1
                continue
            try:
                access = crypto.decrypt(cred.access_token, aad=_aad(pk, "access"))
                refresh = crypto.decrypt(cred.refresh_token, aad=_aad(pk, "refresh")) if cred.refresh_token else None
            except crypto.DecryptionFailed:
                failed += 1
                log.warning("integration credential could not be re-encrypted connection=%s", pk)
                continue
            cred.access_token = crypto.encrypt(access, aad=_aad(pk, "access"))
            cred.refresh_token = crypto.encrypt(refresh, aad=_aad(pk, "refresh")) if refresh is not None else None
            cred.key_id = current
            cred.save(update_fields=["access_token", "refresh_token", "key_id", "updated_at"])
            done += 1
    return {"reencrypted": done, "skipped": skipped, "failed": failed, "key_id": current}


def delete_tokens(connection: IntegrationConnection) -> None:
    IntegrationCredential.objects.filter(connection=connection).delete()


def read_tokens(connection: IntegrationConnection) -> tuple[str | None, str | None]:
    cred = IntegrationCredential.objects.filter(connection=connection).first()
    if cred is None:
        return None, None
    return (crypto.decrypt(cred.access_token, aad=_aad(connection.pk, "access")),
            crypto.decrypt(cred.refresh_token, aad=_aad(connection.pk, "refresh")) if cred.refresh_token else None)


def mark_needs_reauth(connection: IntegrationConnection, code: str = "reauth_required", message: str = "") -> None:
    connection.status = IntegrationConnection.Status.NEEDS_REAUTH
    connection.last_error_code = code[:60]
    connection.last_error_message = (message or ReauthRequired.message)[:300]
    connection.last_error_at = timezone.now()
    connection.next_sync_at = None
    IntegrationConnection.objects.filter(pk=connection.pk).update(
        status=connection.status, last_error_code=connection.last_error_code,
        last_error_message=connection.last_error_message, last_error_at=connection.last_error_at, next_sync_at=None,
    )
    log.info("integration %s connection %s needs reauthorization (%s)", connection.provider, connection.pk, code)


class ConnectionTokens:
    """``TokenSource`` of one connection for ``ProviderClient``."""

    def __init__(self, connection: IntegrationConnection, adapter):
        self.connection = connection
        self.adapter = adapter
        self._access: str | None = None
        self._version: int | None = None

    def _load(self) -> IntegrationCredential:
        cred = IntegrationCredential.objects.filter(connection=self.connection).first()
        if cred is None:
            mark_needs_reauth(self.connection, "credentials_missing", "No stored credentials. Reconnect to continue.")
            raise ReauthRequired()
        return cred

    def access_token(self) -> str:
        if self.connection.status == IntegrationConnection.Status.NEEDS_REAUTH:
            raise ReauthRequired()
        if self._access is not None:
            return self._access
        cred = self._load()
        if cred.access_expires_at and cred.access_expires_at - REFRESH_MARGIN <= timezone.now() and cred.refresh_token:
            return self.refresh()
        if cred.access_expires_at and cred.access_expires_at <= timezone.now() and not cred.refresh_token:
            mark_needs_reauth(self.connection, "token_expired", "The access token expired. Reconnect to continue.")
            raise ReauthRequired()
        self._access = crypto.decrypt(cred.access_token, aad=_aad(self.connection.pk, "access"))
        self._version = cred.version
        return self._access

    def refresh(self) -> str:
        """Refreshes under a row lock. If another process refreshed meanwhile, its new token
        is used instead of spending the (single-use) refresh token again. A refused refresh
        is recorded after the lock's transaction ends, so the status change is kept."""
        failure: tuple[str, str] | None = None
        with transaction.atomic():
            cred = IntegrationCredential.objects.select_for_update().filter(connection=self.connection).first()
            if cred is None:
                failure = ("credentials_missing", "No stored credentials. Reconnect to continue.")
            else:
                fresh_enough = cred.access_expires_at is None or cred.access_expires_at - REFRESH_MARGIN > timezone.now()
                if self._version is not None and cred.version != self._version and fresh_enough:
                    self._access = crypto.decrypt(cred.access_token, aad=_aad(self.connection.pk, "access"))
                    self._version = cred.version
                    return self._access
                if not cred.refresh_token:
                    failure = ("token_rejected", "The provider rejected the stored token. Reconnect to continue.")
                else:
                    refresh_token = crypto.decrypt(cred.refresh_token, aad=_aad(self.connection.pk, "refresh"))
                    try:
                        tokens = self.adapter.refresh_tokens(self.connection, refresh_token)
                    except ReauthRequired as exc:
                        failure = (exc.detail or "refresh_rejected",
                                   "The provider refused to renew access (revoked or expired). Reconnect to continue.")
                    else:
                        cred = store_tokens(self.connection, tokens)
                        self._access = tokens.access_token
                        self._version = cred.version
                        return self._access
        mark_needs_reauth(self.connection, *failure)
        raise ReauthRequired(detail=failure[0])
