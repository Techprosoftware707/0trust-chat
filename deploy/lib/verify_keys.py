#!/usr/bin/env python3
"""Verify a Matrix /_matrix/key/v2/server response is validly self-signed.

Reads the JSON document from stdin; argv[1] is the expected server name.
Implements canonical JSON + Ed25519 verification. Uses the `cryptography`
package when available, otherwise falls back to OpenSSL's CLI (always present
on Ubuntu) so this works on a fresh host without extra Python packages.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile


def b64d(s: str) -> bytes:
    return base64.b64decode(s + "=" * (-len(s) % 4))


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def verify(pub: bytes, sig: bytes, msg: bytes) -> bool:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        try:
            Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
            return True
        except InvalidSignature:
            return False
    except ImportError:
        pass
    der = bytes.fromhex("302a300506032b6570032100") + pub  # SubjectPublicKeyInfo for Ed25519
    with tempfile.TemporaryDirectory() as d:
        open(f"{d}/k.der", "wb").write(der)
        open(f"{d}/s", "wb").write(sig)
        open(f"{d}/m", "wb").write(msg)
        r = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER", "-inkey", f"{d}/k.der", "-rawin", "-in", f"{d}/m", "-sigfile", f"{d}/s"],
            capture_output=True,
        )
        return r.returncode == 0


def main() -> int:
    name = sys.argv[1]
    doc = json.load(sys.stdin)
    if doc.get("server_name") != name:
        print(f"server_name is {doc.get('server_name')!r}, expected {name!r}", file=sys.stderr)
        return 1
    sigs = (doc.get("signatures") or {}).get(name) or {}
    keys = doc.get("verify_keys") or {}
    msg = canonical({k: v for k, v in doc.items() if k not in ("signatures", "unsigned")})
    for key_id, sig in sigs.items():
        if key_id in keys and verify(b64d(keys[key_id]["key"]), b64d(sig), msg):
            print(f"valid signature by {key_id}")
            return 0
    print("no valid self-signature", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
