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
| Call audio, video and screen share | Participants | Plaintext only on participants' devices; the SFU forwards AES-GCM-encrypted frames; never recorded or stored |
| Call media keys | Participants | Devices only; sent to other participants as Olm-encrypted to-device messages; rotated on every join or leave |
| Call metadata: who is in a call, when, track types, bitrates, audio levels, client IPs | Participants (privacy), operator (custody) | Homeserver (membership state events), SFU memory while the call lasts, console counters (aggregate only) |

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
| Curious or compromised **operator of the call server (SFU)** | Everything LiveKit and lkjwt see; can change their configuration or code | **Content: yes, with the shipped client. Metadata: no.** | Media is encrypted per frame in the browser with keys the server never receives. The SFU sees who is connected (pseudonymous IDs that the homeserver can link to users), when, from which IP, track types, bitrates and **audio levels** (the RTP audio-level header is not encrypted, so the SFU can tell who is speaking when). It cannot listen in: it has no keys, there is no recording component, and there is no hidden participant role. To join a call it would need a Matrix membership in the room, which is visible to the participants. A server that serves a malicious web app can still break this (row "Malicious web-app delivery"). |
| Someone outside the room trying to join a call | Network access to the SFU | **Yes** | SFU tokens are issued only by the homeserver to signed-in users who are joined to the room (401 anonymous, 403 non-member). Tokens cover one room, join only, 1 h, and are signed with this server's key; the SFU does not auto-create rooms. A token alone gives no media keys: those are sent only to devices that appear in the call's Matrix membership. |
| Participant removed from a room during a call | Was a member; still has an SFU connection and old keys | **Future media: yes. Connection: not forcibly closed.** | They cannot get new SFU tokens. The remaining clients rotate media keys without them, so media sent after the removal is ciphertext to them. The SFU does not automatically disconnect them; their existing connection lasts until they leave or it drops. |
| lkjwt's application-service token | Held by the authorization service | Bounded by design | An appservice with a `.*` user namespace can act as any local user on the client-server API. lkjwt uses it only to check room membership (MSC4502 scope) and to manage delayed leave events. It is a secret file (0440 root:lumen-secrets) mounted only into Synapse and lkjwt, and it is not exposed publicly. A compromised lkjwt is equivalent to a compromised homeserver for local users' accounts, **not** for E2EE content. |
| TURN abuse (open relay) | Use the server to reach other hosts | **Yes** | TURN credentials are minted per session (5-minute TTL). Relaying to the WireGuard subnet, the calls network and 172.16.0.0/12 is denied, and relaying to other private addresses (loopback, RFC 1918, link-local) is blocked by LiveKit's default restrictions. TCP relay allocations are not offered. |
| Push providers (Google FCM, Apple APNs), when the operator enables push | See every push to a device | **Content: yes. Metadata: no.** | The homeserver sends only room ID, event ID and unread counts (`push.include_content: false`; the apps register `event_id_only` pushers). The device fetches and decrypts the message itself. Google and Apple learn which device received a notification and when, and the room and event identifiers (opaque IDs, not names). Operators who do not want this leave `PUSH_ENABLED=false`; the apps then notify only while running. |
| Legal compulsion of the operator | Order to hand over data | Content: no plaintext to hand over. Metadata: yes | The operator can disclose metadata and ciphertext. The privacy policy states what is kept and for how long. |

## What the operator can see (metadata inventory)

* **Homeserver**: user IDs, display names and avatars; room IDs, names, topics,
  avatars and membership; who sent each event and when; event types and sizes
  (not content for encrypted rooms); read receipts and typing notifications
  (unencrypted in Matrix); device IDs and display names; client IP addresses and
  user agents (kept 28 days, `user_ips_max_age`); push notification metadata if
  push is used; media file sizes and upload times (content encrypted in encrypted
  rooms).
* **Calls (SFU and authorization service)**: while a call lasts, the SFU holds
  pseudonymous participant identities, client IP addresses and ports, track
  types, bitrates, packet statistics and audio levels. Room names are hashed.
  The SFU logs at `info` level in JSON to Docker's rotated log files (10 MB ×
  5 per container). Those logs carry pseudonymous identities, hashed room
  names, track and connection events, and client SDK/OS information. They
  never carry Matrix IDs; the security scan checks this. The authorization service logs at `warn`, so per-request Matrix
  IDs are not logged. Call membership (who joined, when) is ordinary room
  state on the homeserver. The console's Calls page stores only aggregate
  counters. Nothing records audio, video or transcripts.
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

## Security properties of call media encryption

Provided by matrix-js-sdk's MatrixRTC encryption manager and livekit-client's
frame encryptor, not by Lumen cryptography code:

* **Confidentiality and integrity** of each audio and video frame
  (AES-GCM-128), between participants who hold the sender's current key.
* **Membership-bound keys**: each participant has their own media key. It is
  sent only to the devices listed in the call's Matrix membership, over Olm.
  When someone joins or leaves, every participant switches to a new key.
  Someone who joins does not get keys for earlier media, and someone who
  leaves does not get later ones.
* **Device trust** is that of Matrix to-device messaging. Keys go to the
  devices that have joined the call. Unverified devices are shown as such in
  the chat, and the call view lists every participant.
* **No PQ protection**: Olm (X25519) and the frame key exchange are
  classical; see [post-quantum.md](post-quantum.md).
* **Not hidden from the SFU**: frame sizes and timing, packet counts, audio
  levels, and the unencrypted parts of each frame (for example the VP8 frame
  header, so the SFU can do simulcast and keyframe requests).
* **Label honesty**: the app shows "end-to-end encrypted" only when its own
  key is set and every remote participant's media is encrypted with a key
  received over Matrix. Unencrypted publishers, missing keys and decryption
  errors are shown as such.

## Known limitations

See [docs/known-limitations.md](../known-limitations.md) for the complete list.
The security-relevant ones:

1. Web delivery of the client (operator can ship malicious JS).
2. Matrix metadata is visible to every server in a room.
3. A server can add devices to its users; protection depends on users verifying.
4. No post-quantum protection of message content.
5. Single-host deployment: host root is fully trusted.
6. Account recovery (portal) restores the account, not encrypted history.
7. Calls: the SFU sees call metadata, including audio levels. A participant
   removed mid-call is not disconnected by the server; it is only excluded
   from new keys.
8. No post-quantum protection of call media.
