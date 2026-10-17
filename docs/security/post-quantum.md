# Post-quantum readiness

Status as of 2026-10-15. This document says what is and is not protected against
an adversary with a cryptographically relevant quantum computer (CRQC), layer by
layer, and what Lumen will change when upstream standards allow it.

**Summary: Lumen does not provide post-quantum end-to-end encryption.** Message
content is protected by Matrix's Olm/Megolm, which is classical cryptography.
Transport TLS to Lumen uses a hybrid post-quantum key exchange where the client
supports it, and the operator console shows this only when a real handshake
negotiates it. Nothing in the product displays a "post-quantum" badge for messages.

## Threat model

Two different quantum threats matter:

| Threat | What it breaks | When the attacker needs the CRQC |
|---|---|---|
| **Harvest now, decrypt later (HNDL)** | Key agreement and public-key encryption (X25519, RSA, ECDH). Recorded ciphertext is decrypted years later. | Later — so data recorded today is already exposed to this risk. |
| **Forgery** | Signatures (Ed25519, ECDSA, RSA). The attacker impersonates a device, server or certificate. | At the time of the attack — signatures made today are not retroactively harmful. |

Hence the priority: key agreement and anything stored or recorded long-term first;
signatures can follow.

## Standards

NIST published FIPS 203 (ML-KEM, key encapsulation), FIPS 204 (ML-DSA, signatures)
and FIPS 205 (SLH-DSA, hash-based signatures) in August 2024. The IETF hybrid TLS
key exchange `X25519MLKEM768` (ML-KEM-768 combined with X25519) is deployed in
Go's TLS stack (default since Go 1.24), OpenSSL 3.5 and current browsers.
"Hybrid" means the session key is safe if *either* component holds, so it is not
weaker than classical X25519 even if ML-KEM were broken.

## Layer by layer

| Layer | Mechanism in Lumen | Post-quantum status |
|---|---|---|
| Message and file content (E2EE) | Matrix Olm (X25519 3DH + Double Ratchet) to share Megolm room keys; Megolm (AES-256-CBC + HMAC-SHA-256, Ed25519 signatures) via vodozemac in `matrix-sdk-crypto` | **Not PQ.** HNDL exposure: an adversary holding the encrypted events (any homeserver in the room keeps them) and the Olm to-device traffic that carried the room keys could recover content with a CRQC by breaking X25519. |
| Server-side key backup | `m.megolm_backup.v1.curve25519-aes-sha2`: room keys encrypted to a Curve25519 backup key | **Not PQ.** The backup ciphertext lives on the homeserver indefinitely; it is an HNDL target. |
| Secret storage (cross-signing private keys, backup key) | AES-256-CTR + HMAC-SHA-256 under a key derived from the user's recovery key | Symmetric 256-bit; Grover's algorithm gives at most a quadratic speed-up. Considered adequate. |
| Device and user verification | Ed25519 device keys and cross-signing; SAS emoji comparison | Not PQ, but forgery needs a CRQC at attack time. |
| Browser ↔ Lumen (website, portal, chat app, homeserver API) | TLS 1.3 by Caddy 2.11 (Go ≥ 1.24) | **Hybrid PQ key exchange** (`X25519MLKEM768`) when the browser offers it. Measured, not assumed — see below. Certificates are classical (ECDSA). |
| Homeserver ↔ homeserver (federation) | Inbound: through Caddy (as above). Outbound: Synapse (Twisted/pyOpenSSL) with OpenSSL 3.5 in the upstream image | Inbound: hybrid when the remote server offers it. Outbound: OpenSSL 3.5 offers `X25519MLKEM768` by default, so hybrid is likely with modern peers — **not measured by Lumen**. Server signing keys (Ed25519) are classical. |
| Call media (E2EE) | Per-frame AES-GCM with 128-bit per-participant keys (livekit-client frame encryptor). The keys are sent over Olm-encrypted to-device messages (X25519) by matrix-js-sdk's MatrixRTC encryption manager. | **Not PQ.** The frame cipher is symmetric, but the keys travel under Olm. Someone who records the to-device key messages and the media stream could decrypt the call with a future CRQC (HNDL). The app shows no PQ label for calls. |
| Call signalling (browser ↔ `rtc.<domain>`) | TLS 1.3 by Caddy, reverse-proxied to LiveKit on loopback | Same as other Caddy sites: hybrid `X25519MLKEM768` when the browser offers it. |
| Call media transport (browser ↔ SFU) | DTLS-SRTP, run by the browser's WebRTC stack and LiveKit's pion/dtls: DTLS 1.2 with classical ECDHE | **Not PQ** (hop-by-hop layer under the E2EE). |
| Inside the host | Unix domain sockets and an internal Docker network (no TLS) | Not network-exposed. |
| WireGuard admin tunnel (on by default) | Noise IK (Curve25519, ChaCha20-Poly1305) **plus a per-peer preshared key** | The PSK is mixed into the handshake, so recorded tunnel traffic stays confidential against a CRQC as long as the PSK stays secret. The PSK reaches the operator inside the peer configuration file: downloaded once over the hybrid-TLS console, or, for the installer's first device, copied from the root-only `first-device.conf` over SSH (classical key exchange unless the SSH client and server negotiate a PQ hybrid such as `mlkem768x25519-sha256`, OpenSSH 9.9+) or scanned as a QR code, then deleted (`lumenctl wireguard forget-profile`). Peer authentication remains classical. |
| Backups | `age` with X25519 recipients (Ubuntu 24.04 package) | **Not PQ.** Off-site backup copies are an HNDL target. Mitigation: keep backups on storage you control and encrypt that storage too; see "Roadmap". |
| Passwords | Argon2id | Not affected beyond Grover. |
| Portal sessions, invitation and setup tokens, webhook signatures | Random 256-bit tokens, SHA-256 hashes, HMAC-SHA-256 | Symmetric; adequate. |
| OIDC tokens (portal → homeserver) | Signed JWTs (classical signature) | Forgery needs a CRQC at attack time; tokens are short-lived. |

## How the console measures transport PQ

The worker's TLS probe (`services/portal/apps/ops/probes.py`, `negotiated_group`)
connects to each public hostname with the OpenSSL 3.5 command-line client,
offering `X25519MLKEM768` first and `X25519` second, and records the group the
server actually chose. **Operator console → Security events → Cryptography in
use** shows a "Hybrid" badge for a hostname only if that measurement returned an
ML-KEM hybrid group; otherwise it shows "No" or "not measured". The probe runs
every few minutes; the page shows when it last ran.

What this does *not* show: which group a particular user's browser negotiated
(older browsers fall back to X25519, which is still secure classically), and
outbound federation connections made by Synapse.

## What Lumen will not do

* Claim post-quantum security for messages or calls, or show a PQ badge in the chat app.
* Invent or patch in a PQ extension to Olm/Megolm. A key agreement that only
  Lumen clients speak would break interoperability with the Matrix network and
  would be unreviewed cryptography — both are explicitly out of scope
  (ADR 0001, D1/D3/D11).
* Silently downgrade. Lumen does not negotiate cryptography itself; downgrade
  protection is that of TLS 1.3 and of the Matrix protocol.

## Roadmap (dependent on upstream)

1. **Message E2EE.** When the Matrix specification adopts a post-quantum (likely
   hybrid ML-KEM) key agreement for Olm or a successor, and `matrix-sdk-crypto`
   (vodozemac) ships it, Lumen adopts it by upgrading `matrix-js-sdk` and its
   Rust crypto WASM. The chat client keeps all cryptography behind the SDK, so this
   is a dependency upgrade plus UI wording, not a redesign. Rooms will only use it
   once all members' clients support it — mixed rooms stay classical, and the UI
   must say so per room rather than globally.
2. **Key backup.** Requires a new backup algorithm in the Matrix spec; same path.
3. **Backups.** Move backup encryption to a hybrid ML-KEM recipient type once a
   packaged, reviewed `age` release with such recipients is available on the
   supported OS, and re-encrypt retained archives.
4. **Signatures (FIPS 204/205).** Device, cross-signing and server signing keys
   follow the Matrix spec; TLS certificates follow the WebPKI. No action is
   possible ahead of those ecosystems.
5. **Verification.** Each step ships with a test that measures the negotiated or
   used algorithm, like the TLS probe — the same rule as today: show it only
   when it is measured.

## Practical advice for operators and users today

* Treat message history as protected against today's attackers, and as
  potentially readable in the long term by a well-resourced adversary that
  records it. Don't keep long-lived secrets in chat history: delete messages
  you no longer need (deleting removes the ciphertext from this homeserver after
  Synapse's redaction retention period; copies already federated to other
  servers are outside your control).
* Keep off-site backups on storage you control; restrict who can copy them.
* Use the WireGuard path (with its PSK) rather than exposing the operator console.
