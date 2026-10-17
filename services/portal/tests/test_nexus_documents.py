"""Secure lending documents: AES-GCM encryption at rest, storage outside public paths, upload
checks, short-lived single-use download tokens bound to user + document + expiry (expired,
another user, another tenant, tampered, revoked access), audit and the managers' access log,
and that no plaintext reaches the disk or the logs."""

import base64
import logging
import os
import secrets
import tempfile
import uuid
from datetime import timedelta
from unittest import mock

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.crm import documents
from apps.crm import models as m
from apps.workspaces.models import Membership, Role

from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db
MARKER = b"PLAINTEXT-MARKER-7c1e9a"
PDF = b"%PDF-1.4\n1 0 obj << >> endobj\n" + MARKER + b"\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _key() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode()


@pytest.fixture
def storage(settings, tmp_path):
    settings.NEXUS_SECURE_DOCUMENTS_DIR = str(tmp_path / "secure-docs")
    settings.NEXUS_DOCUMENT_KEY = _key()
    return tmp_path / "secure-docs"


@pytest.fixture
def org(storage):
    owner = make_user("d-owner")
    ws = business_workspace(owner, "Docs Org", profiles=["general", "lending"])
    manager = member(ws, Role.MANAGER, "d-manager")
    broker = member(ws, Role.AGENT, "d-broker")
    other_broker = member(ws, Role.AGENT, "d-other")
    borrower = m.Contact.objects.create(workspace=ws, first_name="Bo", last_name="Rower", owner=broker)
    r = api_for(manager).post(f"{base(ws)}/lending/applications", {"title": "Doc app", "borrowers": [{"contact_id": str(borrower.pk)}],
                                                                   "loan_officer_id": str(broker.public_id)})
    app = body(r)["data"]
    return {"ws": ws, "owner": owner, "manager": manager, "broker": broker, "other_broker": other_broker, "app": app, "storage": storage}


def upload(api, org, data=PDF, ctype="application/pdf", name="pay stub.pdf", item=None):
    q = f"?checklist_item={item}" if item else ""
    return api.raw("post", f"{base(org['ws'])}/lending/applications/{org['app']['id']}/documents{q}", data, ctype,
                   HTTP_X_NEXUS_FILENAME=name.replace(" ", "%20"))


def token_for(api, org, doc_id):
    r = api.post(f"{base(org['ws'])}/lending/documents/{doc_id}/download-token", {})
    assert r.status_code == 201, r.content
    return body(r)["data"]["token"]


def redeem(api, org, token, ws=None):
    return api.post(f"{base(ws or org['ws'])}/lending/documents/download", {"token": token})


def _all_bytes_under(path) -> bytes:
    out = b""
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                with open(os.path.join(root, f), "rb") as fh:
                    out += fh.read()
            except OSError:
                pass
    return out


# --- encryption ------------------------------------------------------------------------------------


def test_encryption_round_trip_binding_and_rotation(storage, settings):
    ws_id, doc_id = uuid.uuid4(), uuid.uuid4()
    sealed = documents.seal(ws_id, doc_id, PDF)
    raw = (storage / sealed.storage_name).read_bytes()
    assert MARKER not in raw and raw.startswith(documents.FILE_MAGIC)
    assert oct(os.stat(storage / sealed.storage_name).st_mode & 0o777) == "0o600"
    assert oct(os.stat(storage).st_mode & 0o777) == "0o700"
    doc = m.SecureDocument(id=doc_id, workspace_id=ws_id, storage_name=sealed.storage_name, key_id=sealed.key_id, wrapped_key=sealed.wrapped_key)
    assert documents.open_sealed(doc) == PDF
    # The ciphertext is bound to its document and workspace (no swapping).
    with pytest.raises(documents.DocumentIntegrityError):
        documents.open_sealed(m.SecureDocument(id=uuid.uuid4(), workspace_id=ws_id, storage_name=sealed.storage_name, key_id=sealed.key_id,
                                               wrapped_key=sealed.wrapped_key))
    with pytest.raises(documents.DocumentIntegrityError):
        documents.open_sealed(m.SecureDocument(id=doc_id, workspace_id=uuid.uuid4(), storage_name=sealed.storage_name, key_id=sealed.key_id,
                                               wrapped_key=sealed.wrapped_key))
    # Tampering is detected.
    tampered = bytearray(raw)
    tampered[-1] ^= 1
    (storage / sealed.storage_name).write_bytes(bytes(tampered))
    with pytest.raises(documents.DocumentIntegrityError):
        documents.open_sealed(doc)
    (storage / sealed.storage_name).write_bytes(raw)
    # Rotation: a new first key encrypts; the old one still decrypts old files.
    old = settings.NEXUS_DOCUMENT_KEY
    settings.NEXUS_DOCUMENT_KEY = f"{_key()},{old}"
    assert documents.open_sealed(doc) == PDF
    assert documents.seal(ws_id, uuid.uuid4(), b"x").key_id != sealed.key_id
    # Without the old key the file can't be read.
    settings.NEXUS_DOCUMENT_KEY = _key()
    with pytest.raises(documents.DocumentIntegrityError):
        documents.open_sealed(doc)


def test_key_configuration_is_validated(settings, tmp_path):
    settings.NEXUS_DOCUMENT_KEY = "not base64!"
    with pytest.raises(ImproperlyConfigured):
        documents.master_keys()
    settings.NEXUS_DOCUMENT_KEY = base64.b64encode(b"short").decode()
    with pytest.raises(ImproperlyConfigured):
        documents.master_keys()
    settings.NEXUS_DOCUMENT_KEY = ""
    assert documents.master_keys() == [] and not documents.is_configured()


@pytest.mark.parametrize("where", ["static_root", "static_dir", "branding", "parent_of_static"])
def test_storage_refuses_public_and_static_paths(settings, where):
    settings.NEXUS_DOCUMENT_KEY = _key()
    target = {
        "static_root": settings.STATIC_ROOT / "docs",
        "static_dir": settings.BASE_DIR / "static" / "docs",
        "branding": settings.BRANDING_DIR / "docs",
        "parent_of_static": settings.BASE_DIR,
    }[where]
    settings.NEXUS_SECURE_DOCUMENTS_DIR = str(target)
    with pytest.raises(ImproperlyConfigured):
        documents.storage_dir()


# --- uploads ------------------------------------------------------------------------------------------


def test_upload_encrypts_marks_item_received_and_keeps_plaintext_off_disk_and_out_of_logs(org, caplog):
    caplog.set_level(logging.DEBUG)
    tmp_before = set(os.listdir(tempfile.gettempdir()))
    broker = api_for(org["broker"])
    item = next(i for i in org["app"]["checklist_items"] if i["name"].startswith("Pay stubs"))
    r = upload(broker, org, item=item["id"])
    assert r.status_code == 201, r.content
    doc = body(r)["data"]
    assert doc["name"] == "pay stub.pdf" and doc["size"] == len(PDF) and doc["encrypted"] is True
    row = m.SecureDocument.objects.get(pk=doc["id"])
    stored = org["storage"] / row.storage_name
    assert stored.exists() and MARKER not in stored.read_bytes()
    assert MARKER not in _all_bytes_under(org["storage"])
    # nothing new with the plaintext in the system temp dir (uploads never spool to disk)
    new_tmp = set(os.listdir(tempfile.gettempdir())) - tmp_before
    assert not any(MARKER in _all_bytes_under(os.path.join(tempfile.gettempdir(), n)) for n in new_tmp
                   if os.path.isfile(os.path.join(tempfile.gettempdir(), n)))
    assert m.DocumentChecklistItem.objects.get(pk=item["id"]).status == "received"
    detail = body(broker.get(f"{base(org['ws'])}/lending/applications/{org['app']['id']}"))["data"]
    assert MARKER.decode() not in str(detail)
    # Logs, the audit trail and the access log carry no contents (nor the file name in the audit).
    assert not any(MARKER.decode() in rec.getMessage() for rec in caplog.records)
    ev = AuditEvent.objects.get(action="crm.securedocument.upload", target_id=doc["id"])
    assert ev.metadata["fields"] == ["content_type", "size"] and "pay stub" not in str(ev.metadata) and MARKER.decode() not in str(ev.metadata)
    assert m.DocumentAccessLog.objects.filter(document_id=doc["id"], action="upload", user=org["broker"]).exists()


@pytest.mark.parametrize("data,ctype,name,status", [
    (PNG, "application/pdf", "a.pdf", 400),          # contents don't match the declared type
    (PDF, "text/html", "a.html", 415),               # type not allowed
    (b"MZ\x90\x00", "application/octet-stream", "a.exe", 415),
    (PDF, "application/pdf", "a.png", 400),          # extension doesn't match
    (b"", "application/pdf", "a.pdf", 400),          # empty
    (PDF, "application/pdf", "", 400),               # no name
    (b"PK\x03\x04garbage", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", 400),
])
def test_upload_checks_type_and_name(org, data, ctype, name, status):
    r = upload(api_for(org["broker"]), org, data=data, ctype=ctype, name=name)
    assert r.status_code == status, r.content
    assert not m.SecureDocument.objects.exists()
    assert not any(org["storage"].iterdir()) if org["storage"].exists() else True


def test_upload_size_limit_and_not_configured(org, settings):
    settings.NEXUS_DOCUMENT_MAX_BYTES = 20
    r = upload(api_for(org["broker"]), org)
    assert r.status_code == 413
    settings.NEXUS_DOCUMENT_MAX_BYTES = 10_000
    settings.NEXUS_DOCUMENT_KEY = ""
    r = upload(api_for(org["broker"]), org)
    assert r.status_code == 503 and body(r)["error"]["code"] == "not_configured"
    assert not m.SecureDocument.objects.exists()


def test_upload_needs_change_access_on_the_application(org):
    assert upload(api_for(org["other_broker"]), org).status_code == 404
    readonly = member(org["ws"], Role.READONLY, "d-ro")
    assert upload(api_for(readonly), org).status_code == 404


# --- download tokens -------------------------------------------------------------------------------------


@pytest.fixture
def doc(org):
    r = upload(api_for(org["broker"]), org)
    return body(r)["data"]


def test_download_round_trip_headers_single_use_and_audit(org, doc, caplog):
    caplog.set_level(logging.DEBUG)
    broker = api_for(org["broker"])
    token = token_for(broker, org, doc["id"])
    r = redeem(broker, org, token)
    assert r.status_code == 200 and r.content == PDF
    assert r["Content-Type"] == "application/pdf" and r["X-Content-Type-Options"] == "nosniff"
    assert r["Cache-Control"] == "no-store" and r["Content-Disposition"].startswith("attachment;")
    assert "sandbox" in r["Content-Security-Policy"]
    # single use
    again = redeem(broker, org, token)
    assert again.status_code == 403 and b"PLAINTEXT" not in again.content
    actions = list(AuditEvent.objects.filter(target_id=doc["id"]).order_by("id").values_list("action", flat=True))
    assert actions == ["crm.securedocument.upload", "crm.securedocument.grant", "crm.securedocument.download",
                       "crm.securedocument.download_refused"]
    refused = AuditEvent.objects.filter(action="crm.securedocument.download_refused", target_id=doc["id"]).first()
    assert refused.metadata["reason"] == "already_used"
    assert not any(token in rec.getMessage() for rec in caplog.records)
    assert not any(MARKER.decode() in rec.getMessage() for rec in caplog.records)
    for e in AuditEvent.objects.filter(target_id=doc["id"]):
        assert token not in str(e.metadata)


def test_expired_tokens_are_refused(org, doc):
    broker = api_for(org["broker"])
    token = token_for(broker, org, doc["id"])
    with mock.patch("django.core.signing.time.time", return_value=timezone.now().timestamp() + 3600):
        assert redeem(broker, org, token).status_code == 403
    token2 = token_for(broker, org, doc["id"])
    m.DocumentDownloadGrant.objects.filter(document_id=doc["id"], used_at__isnull=True).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert redeem(broker, org, token2).status_code == 403
    reasons = set(AuditEvent.objects.filter(action="crm.securedocument.download_refused").values_list("metadata__reason", flat=True))
    assert {"expired"} <= reasons


def test_token_of_another_user_is_refused(org, doc):
    token = token_for(api_for(org["manager"]), org, doc["id"])
    r = redeem(api_for(org["broker"]), org, token)  # the broker may see the document, but the token isn't theirs
    assert r.status_code == 403
    assert m.DocumentAccessLog.objects.filter(document_id=doc["id"], action="denied", reason="other_user").exists()
    assert redeem(api_for(org["manager"]), org, token).status_code == 200  # still valid for its owner


def test_tampered_and_malformed_tokens_are_refused(org, doc):
    broker = api_for(org["broker"])
    token = token_for(broker, org, doc["id"])
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert redeem(broker, org, tampered).status_code == 403
    assert redeem(broker, org, "x" * 30).status_code == 403
    assert redeem(broker, org, "not a token!").status_code == 403
    assert AuditEvent.objects.filter(action="crm.securedocument.download_refused", metadata__reason="bad_signature").exists()
    assert redeem(broker, org, token).status_code == 200  # the real one still works


def test_token_of_another_tenant_is_404(org, doc):
    token = token_for(api_for(org["manager"]), org, doc["id"])
    other_ws = business_workspace(make_user("t-owner"), "Other tenant", profiles=["general", "lending"])
    Membership.objects.create(workspace=other_ws, user=org["manager"], role=Role.OWNER)
    r = redeem(api_for(org["manager"]), org, token, ws=other_ws)
    assert r.status_code == 404 and b"PLAINTEXT" not in r.content
    # an outsider can't even reach the download endpoint of the document's workspace
    assert redeem(api_for(make_user("outsider")), org, token).status_code == 404


def test_revoked_access_is_checked_at_download_time(org, doc):
    broker = api_for(org["broker"])
    token = token_for(broker, org, doc["id"])
    # A manager reassigns the application: the old broker's link stops working.
    api_for(org["manager"]).patch(f"{base(org['ws'])}/lending/applications/{org['app']['id']}",
                                  {"loan_officer_id": str(org["other_broker"].public_id)})
    r = redeem(broker, org, token)
    assert r.status_code == 404
    assert m.DocumentAccessLog.objects.filter(document_id=doc["id"], action="denied", reason="access_revoked").exists()
    # A role downgrade (agent -> team member) has the same effect for the new broker.
    token2 = token_for(api_for(org["other_broker"]), org, doc["id"])
    Membership.objects.filter(workspace=org["ws"], user=org["other_broker"]).update(role=Role.MEMBER)
    assert redeem(api_for(org["other_broker"]), org, token2).status_code == 404
    assert m.DocumentAccessLog.objects.filter(document_id=doc["id"], action="denied", user=org["other_broker"]).exists()


def test_access_log_is_for_managers(org, doc):
    broker = api_for(org["broker"])
    redeem(broker, org, token_for(broker, org, doc["id"]))
    path = f"{base(org['ws'])}/lending/applications/{org['app']['id']}/access-log"
    assert broker.get(path).status_code == 403
    rows = body(api_for(org["manager"]).get(path))["data"]
    assert [r["action"] for r in rows] == ["download", "grant", "upload"]
    assert all(r["user"]["username"] == "d-broker" for r in rows)


def test_deleting_documents_and_applications_removes_ciphertext(org, doc, django_capture_on_commit_callbacks):
    row = m.SecureDocument.objects.get(pk=doc["id"])
    path = org["storage"] / row.storage_name
    assert path.exists()
    with django_capture_on_commit_callbacks(execute=True):
        assert api_for(org["broker"]).delete(f"{base(org['ws'])}/lending/documents/{doc['id']}").status_code == 204
    assert not path.exists()
    assert AuditEvent.objects.filter(action="crm.securedocument.delete", target_id=doc["id"]).exists()
    second = body(upload(api_for(org["broker"]), org))["data"]
    path2 = org["storage"] / m.SecureDocument.objects.get(pk=second["id"]).storage_name
    with django_capture_on_commit_callbacks(execute=True):
        assert api_for(org["manager"]).delete(f"{base(org['ws'])}/lending/applications/{org['app']['id']}").status_code == 204
    assert not path2.exists() and not m.SecureDocument.objects.exists()
