# ADR 0001 — Lumen Secure platform architecture

- Status: accepted
- Date: 2026-10-15
- Scope: messaging protocol, homeserver, client SDK, identity, SaaS, database,
  payments, VPN, deployment, post-quantum posture

## Context

Lumen Secure must be a self-hostable *and* commercially operable secure
messaging product. Requirements that drive the decision:

1. Independently operated servers must interoperate (real decentralisation,
   not one big VPS).
2. End-to-end encryption must use an established, reviewed protocol and an
   upstream-maintained implementation. No home-grown cryptography.
3. The SaaS layer (website, billing, accounts) must never need access to
   message plaintext or user keys, and its outage must not expose content.
4. One command must deploy the whole stack on Ubuntu 24.04.
5. The post-quantum story must be honest.

## Options evaluated

| Option | Decentralisation | E2EE maturity | Multi-device / history | Ecosystem & maintenance | Verdict |
|---|---|---|---|---|---|
| **Tox / qTox** (TokTok fork, 1.18.x in 2026) | Pure P2P DHT | NaCl-based, custom protocol; limited formal review | No server-side history; both peers must be online; weak multi-device | Small team; no server federation model; poor fit for SaaS operation | Rejected as core; inspiration for UX only |
| **XMPP + OMEMO** | Federated | OMEMO versions fragmented across clients | MAM + OMEMO interop gaps | Many servers, inconsistent client support | Rejected |
| **Matrix** (Synapse + Olm/Megolm) | Federated, open spec, independent servers | Olm/Megolm via *vodozemac* (Rust), audited (Least Authority 2022), cross-signing, SAS verification, key backup | Server-side encrypted history, multi-device, key backup | Large ecosystem, spec process, element-hq maintains Synapse | **Selected** |
| MLS-based (MIMI drafts) | Draft federation | MLS RFC 9420 is strong | No mature, open, federated deployment | Not production-ready for federation | Future watch |
| New custom protocol | — | — | — | Forbidden by requirements and by good practice | Rejected |

## Decisions

### D1. Messaging protocol: Matrix federation

Matrix (spec v1.x) server–server federation over HTTPS. Our VPS runs **one**
homeserver; other operators run their own and talk to ours over the public
federation API. Our server is not a mandatory relay: rooms are replicated
between the servers of participating users only.

Federation ≠ peer-to-peer. Each user trusts their *own* homeserver for
availability and metadata, not for message confidentiality (which E2EE
provides). This is documented in `docs/security/threat-model.md`.

### D2. Homeserver: Synapse v1.163.0 (`ghcr.io/element-hq/synapse`, AGPL-3.0-or-later or Element commercial licence)

Most complete implementation (federation, OIDC SSO, admin API, account
suspension, media upload limit module callbacks, authenticated media).
Alternatives: Dendrite (maintenance mode), Conduit-family (younger, fewer
admin/SSO features). Synapse is run **unmodified** from the upstream image;
Lumen only adds a small out-of-tree module (`services/synapse-module`) through
the documented module API (imports only from `synapse.module_api`). The
module's source is published in this repository; licence considerations are in
`docs/dependencies.md` (not legal advice).

### D3. Client SDK: matrix-js-sdk 44 + Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`)

All E2EE (Olm/Megolm, cross-signing, SAS verification, secret storage, key
backup) is done by the upstream Rust crypto stack (vodozemac) compiled to
WASM. Lumen's web client is our own UI on top of that SDK; it never
implements cryptographic primitives. Encrypted attachments use the spec'd
AES-CTR scheme via `matrix-encrypt-attachment` (WebCrypto). Any spec-compliant
client (Element Web/Desktop, etc.) can use a Lumen homeserver.

### D4. Identity: SaaS portal is an OIDC provider; homeserver uses SSO

* The portal (Django 6.1 + django-allauth, whose built-in OIDC provider
  `allauth.idp.oidc` issues the tokens) owns
  accounts: Argon2id password hashing, email verification (when SMTP is
  configured), TOTP + WebAuthn + recovery codes, session management.
* Synapse is configured with `oidc_providers` (authorization-code + PKCE) and
  **no local passwords and no open registration**. Matrix accounts are
  provisioned on first SSO login from the portal's verified username.
* The portal authorises chat sign-in server-side (account active, not
  suspended, workspace MFA policy satisfied) before issuing a code.
* Identity is separate from encryption: compromising the portal lets an
  attacker *log in as* a user (a new, unverified device appears and other
  users see a warning) but not decrypt past messages, which require the
  user's device keys or recovery key.
* Upgrade path: Matrix Authentication Service (Synapse
  `matrix_authentication_service`, MSC3861 family / OAuth 2.0 API) with the
  portal as its upstream IdP. Deferred to keep the component count small.

### D5. Database: PostgreSQL 17

Two databases with separate roles and `pg_hba` rules: `synapse` (homeserver,
owned by `synapse`) and `lumen` (portal, owned by `lumen_app`). Billing,
customer, and audit data live in separate Django apps/tables of the `lumen`
database. Postgres is on an internal-only Docker network.

### D6. SaaS application: Django (server-rendered) + separate surfaces

One codebase, three processes with different privileges:

| Process | Exposure | Holds |
|---|---|---|
| `portal` | public via Caddy (website, portal, OIDC, Stripe webhook) | DB creds (app role), OIDC signing key, Stripe secret |
| `ops` | admin listener only (SSH tunnel / WireGuard), plus internal entitlement API for Synapse | Synapse admin token, host-agent socket |
| `worker` | no HTTP | outbound SMTP / Stripe / probes |

The public `portal` process does not even route admin URLs. Caddy injects a
gateway secret on the admin listener which `ops` verifies, so a compromised
portal container cannot use `ops` by reaching it on the Docker network.

### D7. Payments: provider abstraction

`none` (default: free plan only, paid plans shown as unavailable), `manual`
(operator-assigned, e.g. enterprise invoices) and `stripe` (Checkout, Billing
Portal, signed webhooks). Never simulates payment success.

### D8. Reverse proxy & TLS: Caddy 2.11.7

Automatic ACME issuance/renewal, HTTP/3, security headers, request limits.
Built with Go ≥ 1.24, so TLS 1.3 offers the hybrid **X25519MLKEM768** key
exchange by default (used when the client supports it). Caddy runs with host
networking so it sees real client IPs and can bind the admin listener with an
IP allowlist; backends are published on `127.0.0.1` only.

### D9. VPN: WireGuard, on by default, host-level

`wg-quick@wg0` on the host. Used only for private admin access and
(optionally) private server-to-server links. Never replaces E2EE, never
required for chat or federation. On by default since 2026-10: the installer
picks a free subnet, the endpoint and the port, brings up `wg0` and writes a
first operator device profile (root only) so that an operator ends the
installation with a ready-to-import profile. It is best-effort: where the host
can't run WireGuard (no kernel support and no TUN device for `wireguard-go`,
`wg-quick` failing, the port taken, or a `wg0` that isn't Lumen's), the
installer records "unavailable" with the reason and the SSH tunnel remains; it
never overwrites, starts or stops a WireGuard setup Lumen did not write. Each peer gets a preshared key (PSK) as
recommended by the WireGuard whitepaper for post-quantum resistance of the
symmetric layer. Management from the admin console goes through a small root
host agent on a Unix socket with a fixed allowlist of operations — the Docker
socket is never mounted into any container.

### D10. Voice/video

1:1 calls use the Matrix VoIP signalling implemented in matrix-js-sdk
(`m.call.*` events, encrypted in E2EE rooms) with WebRTC DTLS-SRTP media and an
optional coturn TURN relay (time-limited credentials via Synapse's
`turn_shared_secret`). Group calls (MatrixRTC / Element Call + LiveKit) are
out of scope for v1.

### D11. Post-quantum posture (summary; see `docs/security/post-quantum.md`)

* Matrix Olm/Megolm (vodozemac) is **classical** (X25519, Ed25519,
  AES-256-CBC/HMAC-SHA-256). As of 2026-10 there is no specified,
  interoperable PQ Olm/Megolm; vodozemac's PQXDH work never merged and its
  "Olm v2" is experimental and unspecified. Lumen does not claim PQ E2EE and
  does not show a PQ badge for messages.
* Transport: Caddy (Go) and Synapse's OpenSSL 3.5 support hybrid
  X25519MLKEM768 (FIPS 203 ML-KEM-768 + X25519). The admin console reports
  this only after an actual handshake probe negotiates it.
* WireGuard: per-peer PSK.
* No silent downgrade: nothing in Lumen negotiates crypto itself; protocol
  downgrade protection is whatever upstream Matrix/TLS provide.

### D12. Deployment

Docker Compose v2 on one Ubuntu 24.04 host, driven by `install.sh` (idempotent,
staged config rendering + validation, health-gated), with `update.sh`,
`backup.sh` (age-encrypted archives), `restore.sh`, `healthcheck.sh`,
`diagnose.sh` and `uninstall.sh`. Image tags pinned by digest in
`deploy/versions.env`.

## Consequences

* Lumen interoperates with the Matrix network; any Matrix server operator can
  talk to Lumen users if federation policy allows.
* Server operators still see metadata (who talks to whom, when, room
  membership, IP addresses). This is stated plainly in the privacy docs.
* SSO-only login means a portal outage blocks *new* chat logins; existing
  sessions continue working.
* PQ protection of message content depends on future Matrix spec work; the
  code isolates crypto behind the SDK so an upstream upgrade is a dependency
  bump, not a rewrite.
