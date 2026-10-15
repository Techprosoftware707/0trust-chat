# Security architecture

How a Lumen server is put together, where each trust boundary is, and how each
boundary authenticates. Decisions and rejected alternatives are in
[ADR 0001](../adr/0001-architecture.md) and, for calls,
[ADR 0002](../adr/0002-calling.md); the threat and privacy model is in
[threat-model.md](threat-model.md); post-quantum status in
[post-quantum.md](post-quantum.md).

## Components

```
 Internet ──► :80/:443 (tcp+udp) ── Caddy (host network, non-root, CAP_NET_BIND_SERVICE)
                  │   example.com          → portal   (unix socket)   website, sign-up, customer portal, OIDC provider
                  │   app.example.com      → static files            web chat app (matrix-js-sdk + Rust crypto, in the browser)
                  │   matrix.example.com   → synapse  (unix socket)   Matrix client + federation API
                  │
 SSH tunnel / WireGuard ──► ops.example.com:8443 ── Caddy (source-IP allow-list, then gateway secret)
                                                     → ops (unix socket)  operator console
 Internal only:
   postgres   (backend network, internal: true — no route out, no published port)
   worker     (probes, outbound email, billing lifecycle, retention, deletions)
   lumen-agent (root systemd service on the host; Unix socket; fixed operation allow-list)
                  │   rtc.example.com      → livekit  (127.0.0.1:7880)  call signalling (wss); /twirp, /metrics,
                  │                                                       /debug, /sfu_webhook → 404 publicly
 Internet ──► 7882-7889/udp, 7881/tcp ── livekit SFU (host network)   encrypted call media (ciphertext frames)
          ──► 3478/udp                ── livekit's embedded TURN      relay to the local SFU only
 Calls (default on, CALLS_ENABLED):
   lkjwt      (rtc + backend networks) MatrixRTC authorization service; Synapse proxies get_token to it
   rtc network 172.30.42.0/28: the only place the SFU admin API (/twirp) and metrics answer
 Optional:  wg0 (WireGuard, host kernel)
```

| Service | Image | Runs as | Filesystem | Networks | Reaches |
|---|---|---|---|---|---|
| caddy | upstream Caddy 2.11, digest-pinned | uid 10200, only `NET_BIND_SERVICE` | read-only root | host | unix sockets only (no container IPs) |
| portal | `lumen/portal` (built locally) | uid 10001, gid 10300 | read-only root, tmpfs `/tmp` | backend | postgres; serves `/sockets/portal.sock` |
| ops | same image, `SURFACE=ops` | uid 10001 | read-only | backend only (no egress) | postgres, host agent socket, Synapse admin API |
| worker | same image, `SURFACE=worker` | uid 10001 | read-only | backend + egress | postgres, SMTP, Stripe, probes |
| synapse | upstream Synapse 1.163, unmodified | uid 991 | read-only root; data volume | backend + egress | postgres, federation peers |
| postgres | upstream PostgreSQL 17 | uid 70 | data volume | backend (internal) | nothing |
| livekit | upstream LiveKit 1.13, digest-pinned | uid 10400 | read-only root, tmpfs `/tmp` | host (signalling and API bound to 127.0.0.1) | clients' media; TURN relays only to the local SFU (container, VPN and private ranges denied) |
| lkjwt | upstream element-hq lk-jwt-service 0.9, unmodified | uid 10401 | read-only root | backend + rtc | Synapse (membership checks as an application service), LiveKit API via Caddy on the rtc network |

All containers: `cap_drop: ALL`, `no-new-privileges`, no Docker socket anywhere,
no published database or application ports. Images are pinned by digest in
`deploy/versions.env`; the portal image is built locally from hashed Python
requirements (`pip --require-hashes`); the chat app is a static build with no
source maps.

## Trust boundaries and how each authenticates

| Boundary | Mechanism |
|---|---|
| Browser → any public site | TLS 1.3 (Let's Encrypt via ACME; hybrid `X25519MLKEM768` key exchange when offered), HSTS, strict per-site CSP (no inline script or style), `frame-ancestors 'none'`, COOP/CORP, no third-party origins. |
| Person → portal | Username/email + password (Argon2id), optional TOTP / WebAuthn / recovery codes; rate limits per IP and per account; session cookies `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`; idle and absolute timeouts; step-up re-authentication for sensitive actions. |
| Chat app → homeserver | Matrix access token obtained **only** via SSO: homeserver → portal OIDC (authorization code + PKCE, `client_secret_post`) → single-use login token. Password login at the homeserver is disabled. The portal can refuse chat sign-in by policy (suspended account, pending deletion, workspace requires MFA). |
| Device → device (message content) | Matrix Olm/Megolm end-to-end encryption in the browser (vodozemac via `matrix-sdk-crypto-wasm`); cross-signing and emoji (SAS) verification; encrypted key backup with a recovery key only the user holds. Rooms are encrypted by default (`encryption_enabled_by_default_for_room_type: all`). |
| Homeserver → homeserver | Matrix federation: TLS + Ed25519 request signing (`X-Matrix` auth) and server signing keys; optional allow-list or closed federation; Synapse's private-IP blocklist stays on in production. |
| Operator → console | 1) network: Caddy drops (`abort`) any connection not from loopback (SSH tunnel), the WireGuard subnet or `ADMIN_ALLOWED_CIDRS`; the port is not opened in the firewall. 2) gateway: Caddy adds a secret header read from a root-owned secret file; the ops app returns 404 without it. 3) identity: operator account (no default account, no default password; created by a one-time link), MFA mandatory before any page, RBAC per view (owner, admin, support, billing, auditor), step-up re-authentication for destructive actions, typed confirmations. Every action is audit-logged. |
| Ops → host | `lumen-agent` (root, systemd) on `/run/lumen-agent/agent.sock`; the socket directory is mounted only into the ops container; the agent accepts only root or the app UID 10001 (checked with `SO_PEERCRED`) and only a fixed list of operations with validated arguments (WireGuard peers, backups, restart of named services, diagnostics). No shell, no arbitrary command. |
| Homeserver → ops (entitlements) | Synapse module calls `http://ops:8000/internal/v1/media-limits` on the backend network with a bearer token from a secret file; the path is blocked at Caddy on every public site. |
| Stripe → portal | Webhook signature verification (`Stripe-Signature` HMAC with timestamp tolerance) before anything is parsed, body size limit, rate limit, idempotency by event ID. The verified payload is applied; the worker's reconciliation job periodically re-reads subscriptions from Stripe's API to correct missed or out-of-order events. Payment success is only ever shown from Stripe's own state, never from a redirect. |
| Chat app → call (SFU) | The app asks the homeserver for an SFU token (`/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`, Matrix access token required). The homeserver proxies the request to lkjwt (MSC4512). lkjwt checks that the user is joined to the room (MSC4502) and returns a LiveKit JWT scoped to that one room: join only, no room creation or admin, 1 h, pseudonymous identity. Anonymous requests get 401, non-members 403. LiveKit refuses tokens not signed with this server's key and does not auto-create rooms. TURN credentials are minted per session with a 5-minute lifetime; no long-term TURN secret is ever given to clients. |
| Participant → participant (call media) | Frame-level end-to-end encryption in the browser (LiveKit's AES-GCM frame encryptor in a worker). Per-participant keys are sent over Olm-encrypted Matrix to-device messages by matrix-js-sdk's MatrixRTC encryption manager and rotated whenever someone joins or leaves. The SFU forwards ciphertext. DTLS-SRTP between each client and the SFU, and TLS on signalling, are extra hop-by-hop protection; they are not what the "end-to-end encrypted" label refers to. |
| App → database | Separate PostgreSQL roles and databases for the portal and Synapse, passwords from secret files, `REVOKE ALL ON DATABASE … FROM PUBLIC`, `scram-sha-256` in `pg_hba.conf`, database reachable only on the internal network. |

## Secrets

* Generated by the installer with a CSPRNG (`/etc/lumen/secrets`, `root:10100`
  mode 0440 or tighter); external secrets (SMTP password, Stripe keys) are read
  with hidden prompts and written straight to their files.
* Delivered to containers as Compose file secrets (`/run/secrets/...`), never
  as environment variables in production (`*_FILE` convention); Synapse reads
  `*_path` settings and a libpq passfile (0600, uid 991).
* Never printed: the installer summary, `lumenctl config`, `diagnose.sh` and the
  console's configuration page show only whether a secret is set. Logs pass
  through a redaction filter; the installer test greps all logs for every
  secret value (see `tests/installer/lifecycle.sh`).
* Rotation: `lumenctl rotate <name>` for each internal secret.
* Not in backups' plaintext: backups are age-encrypted before they touch the
  backup directory; the age identity is generated on the server and must be
  copied off it.

## Data at rest

| Data | Where | Protection |
|---|---|---|
| Message and file content | Synapse database and media store | End-to-end ciphertext (the server has no keys) |
| Room membership, timestamps, device lists, IPs (28 days) | Synapse database | Server-readable metadata — see threat model |
| Account data (portal) | `lumen` database | Passwords Argon2id; invitation/setup tokens stored as SHA-256 hashes; TOTP secrets in allauth's table |
| Audit log | `lumen` database | Append-only (UPDATE/DELETE blocked by trigger), SHA-256 hash chain verifiable from the console |
| Backups | `/var/backups/lumen` (+ optional off-site rsync) | age (X25519) encryption, per-file SHA-256 manifest, restore verified in an isolated, network-less PostgreSQL container |

Disk encryption of the host is outside Lumen's control and recommended.

## Logging and privacy in logs

Caddy access logs mask client IPs to /24 (IPv4) or /48 (IPv6) and redact
sensitive query parameters (`access_token`, `loginToken`, OIDC `code` and
`state`, `session`); Synapse logs at INFO without request bodies;
the portal's logging filter redacts keys that look like secrets. Security events
(sign-ins, MFA, rate limits) keep full IPs for 90 days for abuse handling, as
stated in the privacy policy.

## What is deliberately not here

* No component can decrypt messages: there is no key escrow, no "compliance
  export" of plaintext and no admin endpoint for message content.
* No hidden or default accounts, no SSH keys, no telemetry to the vendor.
* No Docker socket in any container; host actions go through the agent's fixed
  allow-list.
