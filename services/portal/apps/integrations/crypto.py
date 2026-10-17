"""Encryption of provider credentials at rest: AES-256-GCM (``cryptography``).

Keys come from ``settings.NEXUS_INTEGRATIONS_KEYS`` (the secret ``NEXUS_INTEGRATIONS_KEY``,
read from ``NEXUS_INTEGRATIONS_KEY_FILE``; a plain environment variable only in development
with ``LUMEN_ALLOW_ENV_SECRETS``). Each key is 32 random bytes written as 64 hex characters.
The first key encrypts; every listed key decrypts, so keys can be rotated by putting the new
key first and keeping the old one until ``manage.py nexus_integrations_rekey`` has run.

Ciphertext layout: ``b"v1" + key_id (8 bytes) + nonce (12 bytes) + AES-GCM(ciphertext+tag)``.
The associated data binds a ciphertext to its row and field (``connection:<id>:access``), so
a value copied to another row or field does not decrypt. Plaintext tokens are never logged,
never returned by the API and never stored anywhere else.
"""

from __future__ import annotations

import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings

VERSION = b"v1"


class KeyMissing(RuntimeError):
    """No usable encryption key is configured (NEXUS_INTEGRATIONS_KEY)."""


class DecryptionFailed(RuntimeError):
    """The value was not encrypted by one of the configured keys (or was altered)."""


def _parse(raw: str) -> bytes:
    raw = raw.strip()
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        raise KeyMissing("NEXUS_INTEGRATIONS_KEY must be 64 hex characters (32 random bytes).") from None
    if len(key) != 32:
        raise KeyMissing("NEXUS_INTEGRATIONS_KEY must be 64 hex characters (32 random bytes).")
    return key


def key_id(key: bytes) -> bytes:
    return hashlib.sha256(b"nexus-integrations-key:" + key).digest()[:8]


def _keys() -> list[bytes]:
    raw = list(getattr(settings, "NEXUS_INTEGRATIONS_KEYS", []) or [])
    if not raw:
        raise KeyMissing("No encryption key is configured for integrations (NEXUS_INTEGRATIONS_KEY).")
    return [_parse(k) for k in raw]


def key_configured() -> bool:
    try:
        _keys()
    except KeyMissing:
        return False
    return True


def current_key_id() -> str:
    return key_id(_keys()[0]).hex()


def encrypt(plaintext: str | None, *, aad: str) -> bytes | None:
    if plaintext is None:
        return None
    key = _keys()[0]
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), aad.encode("utf-8"))
    return VERSION + key_id(key) + nonce + sealed


def decrypt(blob: bytes | memoryview | None, *, aad: str) -> str | None:
    if blob is None:
        return None
    data = bytes(blob)
    if len(data) < 2 + 8 + 12 + 16 or data[:2] != VERSION:
        raise DecryptionFailed("Unknown ciphertext format.")
    kid, nonce, sealed = data[2:10], data[10:22], data[22:]
    for key in _keys():
        if key_id(key) == kid:
            try:
                return AESGCM(key).decrypt(nonce, sealed, aad.encode("utf-8")).decode("utf-8")
            except InvalidTag:
                raise DecryptionFailed("The ciphertext does not match its key or record.") from None
    raise DecryptionFailed("The key that encrypted this value is no longer configured.")


def blob_key_id(blob: bytes | memoryview | None) -> str:
    if not blob:
        return ""
    return bytes(blob)[2:10].hex()
