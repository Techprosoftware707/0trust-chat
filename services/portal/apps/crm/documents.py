"""Encrypted storage of lending documents (``SecureDocument``).

Encryption at rest, envelope style, with the existing ``cryptography`` dependency:

* every document gets a fresh random 256-bit data key and is encrypted with AES-256-GCM
  (random 96-bit nonce); the associated data binds the ciphertext to its workspace and
  document ID, so a file can't be swapped onto another document or tenant;
* the data key is stored only wrapped (AES-256-GCM) by the master key, which comes from the
  secret file ``NEXUS_DOCUMENT_KEY_FILE`` (``NEXUS_DOCUMENT_KEY`` in the environment is accepted
  only where env secrets are allowed, i.e. development and tests). Several keys may be given
  (comma- or newline-separated, base64); the first encrypts, all decrypt (rotation);
* ciphertext files live in ``NEXUS_SECURE_DOCUMENTS_DIR`` (directory 0700, files 0600, random
  names), which must not be inside any public, static or media path: the check refuses it.

Uploads are read from the request body into memory (bounded by
``NEXUS_DOCUMENT_MAX_BYTES``); plaintext never touches the disk, temporary files included.
The declared type must be on the allow-list AND match the file's leading bytes ("magic").
There is NO virus scanning in this build (documented gap): files are stored encrypted and
only ever handed back as downloads (``Content-Disposition: attachment``, ``nosniff``).

Contents are never logged, indexed, searched, put in notifications, analytics or given to
the AI assistant. Only metadata (name, type, size) is in the database.
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import secrets
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from apps.api.errors import ApiError, PayloadTooLarge, UnsupportedMediaType, ValidationFailed

FILE_MAGIC = b"NXD1"  # format marker of the ciphertext files
NONCE_LEN = 12


class StorageNotConfigured(ApiError):
    status, code, message = 503, "not_configured", "Secure document storage isn't set up on this server yet. Ask an administrator."


class DocumentIntegrityError(Exception):
    """The ciphertext doesn't decrypt (wrong key, tampered or swapped file)."""


# --- keys ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MasterKey:
    key_id: str
    key: bytes


def _parse_keys(raw: str) -> list[MasterKey]:
    keys = []
    for part in re.split(r"[\s,]+", raw.strip()):
        if not part:
            continue
        try:
            key = base64.b64decode(part, validate=True)
        except (ValueError, TypeError):
            raise ImproperlyConfigured("NEXUS_DOCUMENT_KEY must be base64 (generate one with: openssl rand -base64 32)") from None
        if len(key) != 32:
            raise ImproperlyConfigured("NEXUS_DOCUMENT_KEY entries must be 32 bytes (openssl rand -base64 32)")
        keys.append(MasterKey(hashlib.sha256(b"nexus-document-key:" + key).hexdigest()[:16], key))
    return keys


def master_keys() -> list[MasterKey]:
    """The configured master keys (first = current). Empty when not configured."""
    return _parse_keys(getattr(settings, "NEXUS_DOCUMENT_KEY", "") or "")


def _forbidden_roots() -> list[Path]:
    roots = [Path(settings.STATIC_ROOT), Path(settings.BASE_DIR) / "static", Path(settings.BASE_DIR) / "templates",
             Path(settings.BASE_DIR) / "staticfiles"]
    for entry in getattr(settings, "STATICFILES_DIRS", []):
        roots.append(Path(entry[1] if isinstance(entry, (tuple, list)) else entry))
    media = getattr(settings, "MEDIA_ROOT", "")
    if media:
        roots.append(Path(media))
    roots.append(Path(getattr(settings, "BRANDING_DIR", "/nonexistent-branding")))
    return [r.resolve() for r in roots]


def storage_dir() -> Path:
    """The ciphertext directory: configured, outside every public/static/media path,
    created 0700 if missing."""
    raw = getattr(settings, "NEXUS_SECURE_DOCUMENTS_DIR", "")
    if not raw:
        raise StorageNotConfigured()
    path = Path(raw).resolve()
    for root in _forbidden_roots():
        if path == root or root in path.parents or path in root.parents:
            raise ImproperlyConfigured(f"NEXUS_SECURE_DOCUMENTS_DIR must not be inside or contain a public/static path ({root})")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def is_configured() -> bool:
    try:
        return bool(master_keys()) and bool(getattr(settings, "NEXUS_SECURE_DOCUMENTS_DIR", ""))
    except ImproperlyConfigured:
        return False


def _aad(workspace_id, document_id) -> bytes:
    return f"nexus-secure-document:v1:{workspace_id}:{document_id}".encode()


def _wrap(master: MasterKey, data_key: bytes, aad: bytes) -> str:
    nonce = secrets.token_bytes(NONCE_LEN)
    return base64.b64encode(nonce + AESGCM(master.key).encrypt(nonce, data_key, aad + b":wrap")).decode()


def _unwrap(wrapped: str, key_id: str, aad: bytes) -> bytes:
    master = next((k for k in master_keys() if k.key_id == key_id), None)
    if master is None:
        raise DocumentIntegrityError("the key that encrypted this document is not configured")
    raw = base64.b64decode(wrapped)
    try:
        return AESGCM(master.key).decrypt(raw[:NONCE_LEN], raw[NONCE_LEN:], aad + b":wrap")
    except InvalidTag:
        raise DocumentIntegrityError("the document key does not decrypt") from None


@dataclass
class Sealed:
    storage_name: str
    key_id: str
    wrapped_key: str


def seal(workspace_id, document_id: uuid.UUID, plaintext: bytes) -> Sealed:
    """Encrypts ``plaintext`` and writes the ciphertext file (atomically, mode 0600)."""
    keys = master_keys()
    if not keys:
        raise StorageNotConfigured()
    directory = storage_dir()
    aad = _aad(workspace_id, document_id)
    data_key = AESGCM.generate_key(bit_length=256)
    nonce = secrets.token_bytes(NONCE_LEN)
    blob = FILE_MAGIC + nonce + AESGCM(data_key).encrypt(nonce, plaintext, aad)
    name = secrets.token_hex(24) + ".bin"
    tmp = directory / f".{name}.part"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, directory / name)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return Sealed(storage_name=name, key_id=keys[0].key_id, wrapped_key=_wrap(keys[0], data_key, aad))


def _path_of(storage_name: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{48}\.bin", storage_name or ""):
        raise DocumentIntegrityError("bad storage name")
    return storage_dir() / storage_name


def open_sealed(doc) -> bytes:
    """Decrypts a ``SecureDocument``'s file. Only the download view calls this."""
    blob = _path_of(doc.storage_name).read_bytes()
    if not blob.startswith(FILE_MAGIC):
        raise DocumentIntegrityError("not a Nexus document file")
    aad = _aad(doc.workspace_id, doc.pk)
    data_key = _unwrap(doc.wrapped_key, doc.key_id, aad)
    body = blob[len(FILE_MAGIC):]
    try:
        return AESGCM(data_key).decrypt(body[:NONCE_LEN], body[NONCE_LEN:], aad)
    except InvalidTag:
        raise DocumentIntegrityError("the document does not decrypt (tampered or swapped)") from None


def remove_sealed(storage_name: str) -> None:
    try:
        _path_of(storage_name).unlink(missing_ok=True)
    except DocumentIntegrityError:
        pass


# --- upload checks ------------------------------------------------------------------------------------

ALLOWED_TYPES = {
    "application/pdf": (".pdf",),
    "image/jpeg": (".jpg", ".jpeg"),
    "image/png": (".png",),
    "image/tiff": (".tif", ".tiff"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (".docx",),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (".xlsx",),
}


def max_bytes() -> int:
    return int(getattr(settings, "NEXUS_DOCUMENT_MAX_BYTES", 15 * 1024 * 1024))


def _ooxml_kind(data: bytes) -> str | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = set(z.namelist()[:2000])
    except (zipfile.BadZipFile, ValueError, OSError):
        return None
    if "[Content_Types].xml" not in names:
        return None
    if any(n.startswith("word/") for n in names):
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if any(n.startswith("xl/") for n in names):
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return None


def sniff(data: bytes) -> str | None:
    """The type the file's leading bytes say it is (only the allowed types are recognised)."""
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"II*\x00") or data.startswith(b"MM\x00*"):
        return "image/tiff"
    if data.startswith(b"PK\x03\x04"):
        return _ooxml_kind(data)
    return None


def clean_filename(raw: str) -> str:
    name = unicodedata.normalize("NFC", raw or "")
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    if len(name) > 180:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: 180 - len(ext) - 1] + "." + ext) if dot and len(ext) <= 8 else name[:180]
    return name


def check_upload(declared_type: str, filename: str, data: bytes) -> tuple[str, str]:
    """Validates an upload. Returns (content_type, clean filename) or raises."""
    if len(data) > max_bytes():
        raise PayloadTooLarge(f"Documents can be at most {max_bytes() // (1024 * 1024)} MB.")
    if not data:
        raise ValidationFailed(fields={"file": ["The file is empty."]})
    ctype = (declared_type or "").split(";")[0].strip().lower()
    if ctype not in ALLOWED_TYPES:
        raise UnsupportedMediaType("Upload a PDF, JPEG, PNG, TIFF, Word (.docx) or Excel (.xlsx) file.")
    actual = sniff(data)
    if actual != ctype:
        raise ValidationFailed(fields={"file": ["The file's contents don't match its type."]})
    name = clean_filename(filename)
    if not name:
        raise ValidationFailed(fields={"filename": ["Give the file a name."]})
    if not name.lower().endswith(ALLOWED_TYPES[ctype]):
        raise ValidationFailed(fields={"filename": [f"The name should end in {' or '.join(ALLOWED_TYPES[ctype])} for this type of file."]})
    return ctype, name
