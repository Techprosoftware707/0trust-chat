"""No token or secret values in logs, API responses or the audit log (mock-based flows)."""

import json
import logging

import pytest

from apps.core.models import AuditEvent
from apps.integrations import crypto
from apps.integrations.models import IntegrationCredential
from apps.integrations.sync import sync_connection
from apps.integrations.tokens import read_tokens

from .integrations_helpers import REAL_CONFIG, configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, business_workspace, make_user

pytestmark = pytest.mark.django_db


def test_tokens_never_logged_or_returned(fake, configured, caplog):
    caplog.set_level(logging.DEBUG)
    owner = make_user("sec-owner", email="sec.owner@example.com")
    ws = business_workspace(owner, "Secret Org")
    conns = [connect(fake, owner, ws, "gmail", account="sec.owner@example.com"), connect(fake, owner, ws, "slack", account="T0MOCK0001"),
             connect(fake, owner, ws, "gohighlevel", account="mockLocation001")]
    secrets = list(REAL_CONFIG.values())
    for conn in conns:
        sync_connection(conn)
        IntegrationCredential.objects.filter(connection=conn).update(access_expires_at=None)
    # Force a refresh too, so rotated values are covered.
    IntegrationCredential.objects.filter(connection=conns[0]).update(access_expires_at="2000-01-01T00:00:00Z")
    sync_connection(conns[0])
    for conn in conns:
        secrets += [t for t in read_tokens(conn) if t]
    api = api_for(owner)
    base = ibase(ws)
    responses = [api.get(f"{base}/{p}") for p in ["providers", "connections", "inbox", "inbox?status=all&muted=include"]]
    responses += [api.get(f"{base}/connections/{c.pk}") for c in conns]
    responses.append(api.post(f"{base}/connections/private-token", {"provider": "gohighlevel", "token": "pit-mock-secret-value",
                                                                     "location_id": "mockLocation001"}))
    secrets.append("pit-mock-secret-value")
    blob = "".join(r.content.decode() for r in responses)
    audit = json.dumps(list(AuditEvent.objects.values("action", "metadata")), default=str)
    for secret in secrets:
        assert secret not in caplog.text, "secret in logs"
        assert secret not in blob, "secret in API response"
        assert secret not in audit, "secret in audit log"
    assert any(r.status_code == 200 for r in responses)
    assert "connect" in audit


def test_credentials_are_bound_to_their_row_and_key(fake, configured):
    owner = make_user("sec2-owner", email="sec2.owner@example.com")
    ws = business_workspace(owner, "Secret Org 2")
    a = connect(fake, owner, ws, "gmail", account="sec2.owner@example.com")
    b = connect(fake, owner, ws, "slack", account="T0MOCK0001")
    ca, cb = IntegrationCredential.objects.get(connection=a), IntegrationCredential.objects.get(connection=b)
    # A ciphertext copied to another row doesn't decrypt there.
    with pytest.raises(crypto.DecryptionFailed):
        crypto.decrypt(ca.access_token, aad=f"integration-connection:{b.pk}:access")
    assert repr(ca).startswith("<IntegrationCredential") and "mock-" not in repr(ca)
    # Rotation: a new first key encrypts; the old key still decrypts.
    from django.test import override_settings

    new_key = "ff" * 32
    with override_settings(NEXUS_INTEGRATIONS_KEYS=[new_key, "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"]):
        assert read_tokens(a)[0].startswith("mock-google-access-")
        blob = crypto.encrypt("x", aad="t")
        assert crypto.blob_key_id(blob) == crypto.current_key_id() != ca.key_id
    with override_settings(NEXUS_INTEGRATIONS_KEYS=[new_key]), pytest.raises(crypto.DecryptionFailed):
        read_tokens(a)
    with pytest.raises(crypto.KeyMissing), override_settings(NEXUS_INTEGRATIONS_KEYS=["not-hex"]):
        crypto.encrypt("x", aad="t")
    assert cb.key_id == ca.key_id


def test_rekey_moves_every_credential_to_the_current_key(fake, configured):
    from io import StringIO

    from django.core.management import call_command
    from django.test import override_settings

    owner = make_user("sec3-owner", email="sec3.owner@example.com")
    ws = business_workspace(owner, "Secret Org 3")
    a = connect(fake, owner, ws, "gmail", account="sec3.owner@example.com")
    b = connect(fake, owner, ws, "slack", account="T0MOCK0001")
    before = {c.pk: read_tokens(c) for c in (a, b)}
    old_key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    new_key = "ee" * 32
    with override_settings(NEXUS_INTEGRATIONS_KEYS=[new_key, old_key]):
        out = StringIO()
        call_command("nexus_integrations_rekey", stdout=out)
        assert "re-encrypted 2" in out.getvalue() and "failed 0" in out.getvalue()
        assert "mock-" not in out.getvalue()
        out = StringIO()
        call_command("nexus_integrations_rekey", stdout=out)
        assert "re-encrypted 0" in out.getvalue() and "already current 2" in out.getvalue()
    with override_settings(NEXUS_INTEGRATIONS_KEYS=[new_key]):
        # The old key can now be removed: everything still decrypts, versions are unchanged.
        assert {c.pk: read_tokens(c) for c in (a, b)} == before
        for cred in IntegrationCredential.objects.filter(connection__in=[a, b]):
            assert cred.key_id == crypto.current_key_id() == crypto.blob_key_id(cred.access_token)
            assert cred.version == 1
