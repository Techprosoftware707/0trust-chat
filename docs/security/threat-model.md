# Privacy and threat model

What Lumen protects, from whom, and what it does not. Written for operators,
security reviewers and curious users. Companion documents:
[architecture.md](architecture.md) (mechanisms) and
[post-quantum.md](post-quantum.md).

## Assets

| Asset | Owner | Where it lives |
|---|---|---|
| Message text, files, reactions, edits in encrypted rooms | Users | Ciphertext on every homeserver in the room; plaintext only on members' devices |
| Message keys (Megolm sessions), device keys, cross-signing keys | Users | Devices (IndexedDB, sealed); encrypted key backup and secret storage on the homeserver |
| Recovery key | User | Only where the user stores it |
| Account credentials | Users | Portal (Argon2id hash, TOTP/WebAuthn data) |
| Metadata: who is in which room, when messages are sent, device lists, IP addresses | Users (privacy), operator (custody) | Homeservers in the room; portal security log |
| Billing data | Workspace owners | Portal (plan, status, invoice amounts); card data only at Stripe |
| Server identity (federation signing key), TLS keys, internal secrets | Operator | Host (`/var/lib/lumen/synapse/signing.key`, `/etc/lumen/secrets`), encrypted backups |
| Audit trail | Operator, customers | Portal database (append-only, hash-chained) |

## Adversaries and what Lumen does about them

| Adversary | Capability | Protected? | How / residual risk |
|---|---|---|---|
| Network attacker (Wi-Fi, ISP, transit) | Observe and modify traffic | **Content: yes. Metadata: mostly.** | TLS 1.3 everywhere, HSTS, E2EE inside. Sees which servers you talk to and traffic volume/timing. |
| Curious or compromised **homeserver operator** (including us, for the hosted service) | Full access to server, database, backups | **Content: yes. Metadata: no.** | The server stores ciphertext and never has message keys. It sees room membership, sender, timestamps, sizes, device lists, IPs, room names/topics (state events are not encrypted in Matrix), profile names and avatars. It can delete or withhold messages and **can add devices to accounts it hosts** — which is why device verification matters (an unverified device is flagged in every member's client). |
| Operator acting maliciously to read future messages | Issue a login for a user (e.g. via the IdP) and add a new device | **Detectable, not preventable server-side.** | Cross-signing: a new device that the user did not verify shows as unverified to their contacts; the identity-change banner appears if the attacker resets the user's cryptographic identity. Users who verify each other are warned. Users who ignore warnings are not protected. |
| Another federated server (remote homeserver in a shared room) | Everything the local operator can do, for its own users and for rooms it participates in | Same as above | Federation policy (open / allowlist / closed) limits who can join; rooms are invite-only by default. |
| Portal / SaaS compromise | Control accounts and sign-ins (OIDC IdP) | **Content: yes, past messages. Future: detectable.** | The portal never holds message keys. An attacker controlling the IdP can sign in as a user and create a new device — same detection as above. Billing and portal data (emails, names, plans, IPs in the security log) are exposed. |
| Stolen or seized **device** | Unlocked browser profile | **No** for that device's history | Content the device can decrypt is readable. Mitigation: sign out the device from another session (server deletes it; other clients stop sharing keys with it); OS disk encryption and screen lock. |
| Lost recovery key + all devices | — | Availability, not confidentiality | Encrypted history is unrecoverable by design. The account itself can be recovered through the portal; history cannot. |
| Credential stuffing / phishing of portal passwords | Online guessing, reused passwords | Partially | Argon2id, per-IP and per-account rate limits, recent failed sign-ins shown in the security center, optional MFA (workspace owners can require it on paid plans). Phishing-resistant MFA: WebAuthn. |
| Malicious **operator console user** (insider) | Their RBAC role | Limited and audited | Roles (owner, admin, support, billing, auditor), MFA mandatory, step-up re-auth and typed confirmations for destructive actions, append-only hash-chained audit log, no access to message content anywhere in the console. A host root user can still do anything (see below). |
| Root on the host | Everything on the machine | **Content: yes** (no keys on server). Everything else: no | Can read the database, change code, serve a malicious web app (see next row), read backups' key. This is the operator trust boundary. |
| Malicious web-app delivery | The chat app is JavaScript served by the operator | **No — this is the main limit of web E2EE** | Whoever controls `app.<domain>` can ship code that exfiltrates keys. Mitigations: strict CSP (`script-src 'self'`), no third-party scripts, reproducible static build, pinned dependencies. Users who don't trust the operator should use an independently installed Matrix client (any spec-compliant client works with Lumen accounts). |
| Supply chain (npm, PyPI, container registries) | Malicious dependency | Reduced | Lockfiles with integrity hashes (`package-lock.json`, `pip --require-hashes`), digest-pinned images, no install scripts in the chat build (`npm ci --ignore-scripts`), dependency audit (`pip-audit`, `npm audit`). Not eliminated. |
| Quantum adversary (future) | Break X25519/Ed25519 | **No for message content recorded today** | See [post-quantum.md](post-quantum.md). Transport TLS is hybrid PQ where clients support it. |
| Legal compulsion of the operator | Order to hand over data | Content: no plaintext to hand over. Metadata: yes | The operator can disclose metadata and ciphertext. The privacy policy states what is kept and for how long. |

## What the operator can see (metadata inventory)

* **Homeserver**: user IDs, display names and avatars; room IDs, names, topics,
  avatars and membership; who sent each event and when; event types and sizes
  (not content for encrypted rooms); read receipts and typing notifications
  (unencrypted in Matrix); device IDs and display names; client IP addresses and
  user agents (kept 28 days, `user_ips_max_age`); push notification metadata if
  push is used; media file sizes and upload times (content encrypted in encrypted
  rooms).
* **Portal**: account name, email, display name, workspace membership and roles,
  plan and billing status, sign-in times and IP addresses in the security log
  (90 days), support requests, audit log entries (365 days).
* **Not collected**: analytics or tracking scripts, third-party fonts or CDNs,
  message previews in push or email (none are sent), contact lists or phone
  numbers.

Retention periods are configurable (`RETENTION_*` settings) and listed in the
public privacy policy; the worker job `retention` enforces them hourly.

## Security properties of the end-to-end encryption

Provided by the Matrix protocol as implemented in `matrix-sdk-crypto`
(vodozemac), not by Lumen code:

* **Confidentiality and integrity** of message content between devices that
  hold the room keys.
* **Forward secrecy**: per-session ratcheting (Megolm ratchets forward; Olm uses
  the Double Ratchet). Megolm sessions are rotated (by message count/time and when a
  member leaves or a device is removed), limiting exposure from a leaked session key. Megolm does
  not provide post-compromise security within a session.
* **Key backup**: server-side, encrypted to a key derived from the user's
  recovery key; enables history on new devices. It trades some forward secrecy
  for availability (backed-up keys can decrypt old messages if the recovery key
  leaks).
* **Deniability** is not a goal of Megolm (messages are signed by the sender's
  device).

## Known limitations

See [docs/known-limitations.md](../known-limitations.md) for the complete list.
The security-relevant ones:

1. Web delivery of the client (operator can ship malicious JS).
2. Matrix metadata is visible to every server in a room.
3. A server can add devices to its users; protection depends on users verifying.
4. No post-quantum protection of message content.
5. Single-host deployment: host root is fully trusted.
6. Account recovery (portal) restores the account, not encrypted history.
