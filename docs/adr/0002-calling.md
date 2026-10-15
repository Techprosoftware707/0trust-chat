# ADR 0002 — Voice and video calling

- Status: accepted
- Date: 2026-10-15
- Scope: call signalling, media routing, authorization, NAT traversal, media
  encryption, client implementation, deployment, capacity and scaling
- Supersedes: the 1:1 legacy Matrix VoIP (`m.call.*`, peer-to-peer, coturn) of
  ADR 0001 §D9

## Context

Calling has to cover 1:1 and group calls with HD voice and video and screen
sharing. It must work across NATs and firewalls, keep media end-to-end
encrypted so that no server can decrypt it, and be installed by
`sudo bash install.sh`. It must not use a home-grown protocol, and it must say
honestly when encryption does not hold.

The 1.0 build had 1:1 legacy Matrix VoIP only: `m.call.*` events, a
peer-to-peer WebRTC connection, and coturn as the relay. That design has
three limits:

- it has no group calls;
- a mesh scales badly beyond 3–4 people;
- its only encryption is the DTLS-SRTP hop between the two peers. That hop is
  end-to-end only while there is no media server in the path.

## Options evaluated

| Option | Group calls | Media E2EE through a server | Matrix-native | Licence fit | Verdict |
|---|---|---|---|---|---|
| Legacy Matrix VoIP (`m.call.*`) + coturn | no (mesh only) | DTLS-SRTP peer-to-peer only | yes (deprecated path) | ok | Replaced |
| Jitsi Meet beside Matrix | yes | Jitsi E2EE (insertable streams), separate identity and key model | no: separate rooms and auth | Apache-2.0 | Rejected: a second identity and trust model |
| **MatrixRTC (MSC4143) + LiveKit SFU**, per-participant keys exchanged over Matrix | yes | yes: frame encryption in the client, keys sent as Olm-encrypted to-device messages | yes: call membership is room state, same protocol as Element Call / Element X | LiveKit Apache-2.0, livekit-client Apache-2.0, matrix-js-sdk Apache-2.0 | **Selected** |
| Embed Element Call (the reference MatrixRTC client) | yes | yes | yes | **AGPL-3.0-only**: embedding it would put the chat app under the AGPL | Rejected as a dependency; read for protocol details only, no code copied |
| New calling protocol | — | — | — | — | Forbidden |

## Decisions

### D1. Signalling: MatrixRTC

Call membership is room state:

- `org.matrix.msc4143.rtc.member` (slots) and the legacy
  `org.matrix.msc3401.call.member` events for older clients;
- delayed "leave" events (MSC4140) clear a membership when a client
  disappears;
- ring and notification events (with MSC4310 decline) handle incoming calls.

The homeserver advertises the SFU through `GET /rtc/transports` (MSC4143).
The client uses matrix-js-sdk's `MatrixRTCSession`, not its own protocol code.
A call is a MatrixRTC session in a Matrix room:

- the room's members are the people who may join;
- leaving or being removed from the room ends a person's eligibility.

This is the protocol Element Call and Element X use. Calls with users of those
clients in the same room interoperate as far as they implement the same MSC
revisions. This was **not tested** (see the test report).

### D2. Media: LiveKit SFU (v1.13.10), single node, host network

- **Topology.** A selective forwarding unit, not a mesh. Each participant
  uploads one simulcast stream, and the SFU forwards the layer each receiver
  can take.
- **Network mode.** LiveKit runs with `network_mode: host`, because media
  ports in Docker's userland proxy add latency and break ICE.
- **Signalling.** The WebSocket/HTTP server binds `127.0.0.1:7880` and is
  reached only through Caddy at `wss://rtc.<domain>` (TLS 1.2+/1.3).
- **Public media ports.** Only these are exposed:
  - UDP 7882–7889: ICE/UDP mux;
  - TCP 7881: ICE/TCP fallback;
  - UDP 3478: TURN.
- **Private surfaces.** The Twirp admin API, `/metrics`, `/debug` and the
  webhook path return 404 on the public site. They are reachable only from
  the dedicated `rtc` Docker network (172.30.42.0/28), which the
  authorization service and the worker use.
- **Room settings.**
  - `room.auto_create: false`: a valid token cannot create a room; only the
    authorization service creates rooms.
  - No egress or recording component is deployed.

### D3. Authorization: element-hq lk-jwt-service (v0.9.0) as an application service

The homeserver proxies `/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`
to lk-jwt-service (MSC4512). The service then works as follows:

- it checks that the calling user is joined to the room (MSC4502 scope
  `rooms:is_joined`);
- it creates the LiveKit room if needed;
- it returns a LiveKit JWT that is:
  - scoped to that one room (`roomJoin`; no admin, no `roomCreate`);
  - valid for 1 hour;
  - issued for a **pseudonymous** participant identity (a hash). The room
    name is also a hash.

Results:

- **Anonymous requests** get 401; **non-members** get 403.
- **No user-facing permanent credential.**
  - The LiveKit API secret exists only in `/etc/lumen/secrets/livekit_keys`
    (0440 root:lumen-secrets), mounted into LiveKit and lk-jwt-service.
  - TURN credentials are minted by LiveKit per session and expire after
    5 minutes.
- **Logs.** lk-jwt-service runs at log level `warn`, because its info logs
  contain Matrix IDs and room IDs. The security scan checks that the SFU and
  authorization-service logs contain no Matrix user IDs.
- **Licence.** lk-jwt-service is AGPL-3.0. It runs unmodified as a separate
  container from the upstream image, pinned by digest. Lumen does not link to
  it or modify it (see `docs/dependencies.md`).

**Cost of this choice.** The application-service token can act for any local
user. That is how appservices work, and it is listed in the threat model.

### D4. NAT traversal: LiveKit's embedded TURN instead of coturn

LiveKit's TURN server (pion/turn) is configured as follows:

- UDP 3478;
- credentials from the same signed token flow (5-minute TTL);
- relaying to the WireGuard subnet, the `rtc` network and 172.16.0.0/12
  denied;
- relay ports 40000–40999, which are not opened in the firewall because the
  relay only talks to the local SFU;
- no TCP relay allocations.

Removing coturn removed one daemon, one long-lived shared secret and one set
of ports.

**Media addresses.** LiveKit uses only the address it advertises
(`rtc.ips.includes`). Behind 1:1 NAT, it uses only the default-route
interface (`CALLS_INTERFACE`). Unrestricted, it bound every host address,
including Docker bridges and wg0. In the call suite it then answered relayed
connectivity checks from an address the client had not permitted, so TURN
and ICE/TCP failed. With the restriction both work.

**ICE paths**, in the order a client can use them:

1. direct UDP to the SFU;
2. ICE/TCP 7881;
3. TURN/UDP 3478.

**No TURN over TLS.** LiveKit 1.13 always advertises TURN/TLS as
`turns:<domain>:443`, because it expects an external TLS terminator on 443.
On a single Lumen host, 443 is Caddy's.

- Offering it would need one of these, neither of which Lumen ships in 1.x:
  - a second public IP with its own `turn.<domain>` name and certificate;
  - an L4 SNI router in front of Caddy, such as Caddy built with the layer4
    module, passing `turn.<domain>` to LiveKit with PROXY protocol.
- Lumen therefore advertises no TURN/TLS rather than a broken one.
- Clients on networks that allow only HTTPS on 443 cannot join calls. They
  get a clear connection error (call suite test 15c).

A WireGuard tunnel is **not** assumed to make WebRTC work. Calls were tested
both with the VPN up and with the SFU address routed through the tunnel
(`tests/calls/wg_calls.sh`).

### D5. Media end-to-end encryption

- **Mechanism.**
  - The client encrypts every audio and video frame with LiveKit's
    frame-encryption worker (AES-GCM, insertable streams / RTCRtpScriptTransform).
  - Keys come from per-participant keys managed by matrix-js-sdk's MatrixRTC
    encryption manager (`manageMediaKeys`).
  - The keys are sent to the other participants as **Olm-encrypted to-device
    messages** and rotated on every membership change. Someone who leaves, or
    is removed from the room, does not get keys for media sent afterwards.
- **What the SFU sees.** Only ciphertext frames, plus metadata it needs to
  route:
  - who is connected, as pseudonyms;
  - when;
  - track kinds, sizes and timing;
  - audio levels from the RTP header extension, used for "who is speaking".
- **Transport layers.** DTLS-SRTP (client↔SFU) and TLS on signalling are
  transport protection *in addition*. They are not treated as end-to-end
  encryption.
- **What the UI claims.** The client shows "end-to-end encrypted" for a call
  only when:
  - its own key is set;
  - each remote participant's media is encrypted with a key received over
    Matrix.

  Participants who publish unencrypted media, or connections not backed by a
  room membership, are flagged and the badge is withheld. The badge is not
  derived from the presence of TLS.
- **Post-quantum.** This design is classical cryptography: Olm (Curve25519),
  AES-GCM, DTLS with ECDHE. It is not post-quantum. See
  `docs/security/post-quantum.md`.

### D6. Client: our own implementation on Apache-2.0 SDKs

The Lumen web app implements the call UI and media handling itself. The code
is in `services/chat/src/calls/`, built on `matrix-js-sdk` (MatrixRTC) and
`livekit-client`.

- **HD Voice** (default):
  - Opus at 48 kHz with up to 40 kbit/s;
  - DTX and RED (redundant audio) on;
  - echo cancellation, noise suppression and AGC, using the browser's
    WebRTC audio processing, each switchable;
  - a level meter.
- **High-fidelity mode:**
  - Opus at up to 96 kbit/s (mono) or 128 kbit/s (stereo);
  - DTX off, RED on;
  - processing off for music or instruments.
- **Video:**
  - VP8 by default, after a capability probe; H.264, VP9 and AV1 are
    evaluated per browser (see the codec report in the call settings);
  - simulcast with two lower layers, adaptive stream and dynacast;
  - presets: Auto, Standard (360p30), HD (720p30) and Highest available
    (1080p30 when the camera and browser deliver it);
  - screen share at up to 3 Mbit/s at 15 fps.
- **Stats.** Shown in the call's diagnostics panel, taken from
  `RTCPeerConnection.getStats()`: RTT, jitter, loss, bitrates, resolution,
  frame rate, ICE candidate types (including relay/TURN use) and reconnects.
  The client computes no synthetic quality score.

### D7. Operations and capacity

- **Install.** `install.sh` installs LiveKit and lk-jwt-service by default
  (`CALLS_ENABLED=true`). It also handles:
  - the `rtc.<domain>` name and certificate;
  - the UFW rules;
  - readiness checks.
- **Media self-test.** A real check, not a simulation: the installer and
  `lumenctl calls-selftest` use LiveKit's load tester to send real audio and
  video through the SFU to real WebRTC subscribers.
- **Monitoring.** The operator console "Calls" page shows the SFU's own
  counters, sampled every minute by the worker:
  - rooms, participants and tracks;
  - throughput;
  - CPU and memory;
  - RTT, jitter and loss.

  It shows no identities and no call content, and media is never recorded.
- **Capacity.** No fixed maximum is configured
  (`CALLS_MAX_PARTICIPANTS=0` means unlimited). `tests/calls/bench.sh`
  measures what a given host does, and the results are in
  `docs/test-results/calls-sfu-benchmark.txt`.
- **Scaling path:**
  1. move TURN to its own host;
  2. run LiveKit as a multi-node cluster with Redis;
  3. point `LUMEN_RTC_DOMAIN` at it.

  None of this is automated in 1.x.

## Consequences

- **What users get:**
  - group calls;
  - encrypted media through a server that cannot decrypt it;
  - a working path through restrictive networks.
- **New infrastructure:**
  - two containers;
  - public ports: the UDP range 7882–7889 (one rule), TCP 7881 and UDP 3478;
  - one extra DNS name.
- **New trust in third-party code:**
  - LiveKit;
  - lk-jwt-service and its appservice token;
  - livekit-client's frame encryption.
- **Metadata stays visible to the SFU operator:** who calls when, with
  pseudonymous identities that the operator could link through the
  homeserver.
- **Revocation is cryptographic, not forced disconnection.**
  - A removed user cannot get new tokens.
  - A removed user gets no new media keys.
  - Their existing SFU connection is not torn down by the server; what it
    still receives is ciphertext under keys they do not have.
