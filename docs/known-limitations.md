# Known limitations

Honest list of what Lumen 1.0.0 does not do, does only partly, or has not been
verified. Updated 2026-10-15. Test evidence for everything else is in
[test-report.md](test-report.md).

## Security model

1. **Web delivery of the client.** The web chat app is JavaScript served by the
   operator. Whoever controls `app.<domain>` (operator, or an attacker with root)
   could ship code that steals keys. CSP, no third-party code and a static
   build reduce, but cannot remove, this risk. Users who do not trust the operator
   can use any independent Matrix client with their Lumen account.
2. **Metadata is visible to servers** (membership, timing, sizes, IPs, room
   names/topics, receipts, typing) — inherent to Matrix. See the threat model.
3. **A homeserver can add devices to its own users.** Protection relies on users
   verifying each other; unverified devices and identity changes are flagged in
   the client, not blocked.
4. **No post-quantum protection of message content**, server-side key backup or
   backups (classical X25519). Transport TLS is hybrid PQ where clients support
   it. See [post-quantum.md](security/post-quantum.md).
5. **Single host, root trusted.** One Ubuntu server runs everything; there is no
   high availability, no horizontal scaling and no Synapse worker processes.
   Host compromise exposes all server-side data (but not message content).
6. **Account recovery restores the account, not history.** Without a device or
   the recovery key, encrypted history is gone by design.

## Product scope

7. **Web chat client — not implemented:** QR-code verification, threads, spaces,
   rich-text editor, @mentions, rendering received HTML (plain-text body is
   shown), persistent search index (on-device search covers loaded history),
   web push, room settings beyond enabling encryption, multiple
   accounts.
7a. **Client apps** (Windows, macOS, Android, iOS/iPadOS; per-feature status in
   [apps/feature-matrix.md](apps/feature-matrix.md)):
   * **Nothing has run on a physical device**, and no build is signed for
     distribution or published to a store. Signing, notarization, store review
     and auto-update need the operator's own certificates and accounts
     ([apps/release.md](apps/release.md)).
   * **Android and iOS** were built and unit-tested in CI (iOS simulators,
     Android emulator for a subset), but have not signed in to a real server
     from the app. Their call path (Rust SDK widget driver + Lumen call widget +
     native SFU-token/transport answers) passed a real encrypted call only in
     the Linux harness, not inside the apps.
   * **Push notifications** to closed mobile apps need a Firebase project, an
     APNs key and `PUSH_ENABLED=true`; delivery was not tested. Without push,
     incoming calls ring only while the app runs, and the apps say so.
   * **Mobile gaps:** no screen sharing; no verified state for your other
     devices (the Rust SDK FFI doesn't expose it); Android shows formatted
     messages as plain text; iOS has no message search.
   * **Test setups without a domain** (`install.sh --test`): each device must
     trust the server's private test CA. This was checked from another machine
     (curl and the apps' SSO flow), not on a real Windows PC or Android phone.
     The Android test build trusts user-installed CAs only because it is a
     debug build (`debug-overrides`); release builds never do.
   * **Desktop:** calls hosted on another homeserver's SFU are outside the
     app's content security policy and don't connect. On Linux without a
     keyring the store key is only obfuscated (the app shows a warning).
8. **All rooms are encrypted** (`encryption_enabled_by_default_for_room_type:
   all`); public unencrypted rooms are not offered.
9. **Voice/video calls** (MatrixRTC + LiveKit; see ADR 0002 and the test
   report for what was actually exercised):
   * **No TURN over TLS.** Calls need UDP (direct or TURN on 3478) or TCP 7881.
     Networks that allow only HTTPS on port 443 cannot join calls; users see a
     "couldn't connect to the media server" message. LiveKit 1.13 offers
     TURN/TLS only on 443, which is Caddy's on a single host (ADR 0002, D4).
   * **One SFU node.** There is no multi-node SFU, no separate TURN host and no
     automatic failover. A LiveKit restart drops active calls; clients
     reconnect.
   * **The SFU sees metadata, including audio levels** (who speaks when).
     Media content stays end-to-end encrypted.
   * **Removal mid-call is cryptographic only.** Removing someone from the room
     stops new tokens and new media keys, but the server does not disconnect
     their existing SFU session.
   * **Not tested:**
     * other homeservers' users joining calls (federated MatrixRTC, served
       through the federation token path);
     * Element Call or Element X on the same call;
     * real internet NAT and carrier networks: the calls were tested in
       network namespaces on one host, with simulated loss, latency, UDP
       blocking and outages;
     * real cameras and microphones: browsers ran with synthetic media
       devices.
   * **Call history** comes from the room's call-membership and notification
     events. It is only as complete as the room timeline the client has
     loaded.
   * **Call media is not post-quantum.**
10. **SSO-only chat login.** A portal outage blocks *new* chat sign-ins (existing
    sessions continue). Third-party Matrix clients must support SSO login (most
    current ones do).
11. **Email is optional.** Without SMTP there is no email verification and no
    password reset by email; operators issue one-time recovery links instead
    (`lumenctl operator-link` for operators; console for customers). MFA
    enrolment does not require a verified email when SMTP is off.
12. **Billing.** Stripe is the only payment provider integration. It is tested
    against Stripe's real webhook signature scheme and object shapes with
    synthetic events; it has **not** been run against Stripe's live or test API
    from this environment (no credentials/network). No tax calculation (Stripe
    Tax is not integrated), no invoices generated by Lumen itself (Stripe's are
    linked), no usage-based billing. Out-of-order webhooks are corrected by the
    periodic reconciliation job rather than by event timestamps.
13. **Plans and entitlements** cover seats, invitations, upload size, a 30-day
    upload quota and the "require MFA" policy. Storage quotas for existing media
    are not enforced retroactively.
14. **Account deletion** (after a 7-day grace period) deactivates the Matrix
    account with Synapse's erasure flag (its messages are no longer served to
    people who join rooms later) and erases portal data. Copies already held by
    other room members' servers and devices remain, as with any Matrix
    deployment.
15. **Accessibility**: semantic HTML, keyboard navigation and contrast-checked
    colours were built in, but no automated or manual accessibility audit
    (WCAG) has been performed.

## Operations

16. **TLS via ACME (Let's Encrypt) has not been tested end-to-end** here: the test
    environment has no public DNS or public IP. Internal-CA mode was used for all
    tests. Caddy's ACME support is upstream and widely used, but the first real
    deployment should be watched.
17. **Federation was tested against an independent Synapse on a private network**
    with a test CA, not against the public Matrix network (matrix.org etc.).
18. **Installer tests ran in a systemd Ubuntu 24.04.5 container** (privileged,
    own Docker daemon), not on a VM or bare metal: shared kernel, no real NTP
    (the clock check correctly reports "not synchronised"), no cloud firewall.
    UFW behaviour was exercised inside that container.
19. **WireGuard** was tested end-to-end with a peer in a separate network
    namespace (wireguard-go where the kernel module was unavailable), not from a
    remote machine across the internet. The installer's automatic setup (on by
    default) ran in the systemd test container, whose kernel has no WireGuard
    module, so the server side used Ubuntu's `wireguard-go` package there; the
    kernel path (`ip link add … type wireguard`) is the standard one but was not
    exercised by these tests. The endpoint the installer writes (`WG_ENDPOINT`)
    is a best guess: the primary domain if it resolves to the server, else the
    public IPv4 seen by an outside service, which can be wrong behind some NATs
    or with changing egress addresses. Check it in the summary. A provider
    firewall (security group) in front of the server is not visible to the
    installer; UDP 51820 must be allowed there by hand.

    **DNS inside the tunnel** (how phones reach the console by name): device
    profiles set `DNS = <tunnel address>` and a forwarder on that address
    answers the console's name. It was tested with a Linux peer in a network
    namespace (resolver = the profile's DNS server, no hosts entry), not with
    the Android, iOS, Windows or macOS apps on real devices; how those apply
    the DNS line is documented from their source code
    ([admin guide](operations/admin-guide.md#wireguard)). On a device whose
    Android Private DNS is set to a provider hostname, or whose browser uses
    its own secure DNS with a fixed provider, the console's name still
    resolves publicly and the console doesn't load: the hosts-file line (or
    the setting) is the way out. The test servers had no systemd-resolved, so
    there the forwarder followed `/etc/resolv.conf`; the systemd-resolved
    choice (`/run/systemd/resolve/resolv.conf`) is covered by unit tests.
    While a device is connected, the server sees its DNS lookups (not logged
    by Lumen); without the DNS line a device needs the hosts-file line,
    which phones can't add. Profiles issued before this feature have no DNS
    line: add the DNS server in the app, or issue a new profile.
20. **Backups** restore the whole server (databases, media, signing key,
    optionally config); there is no per-user or per-room restore. Off-site copy
    is rsync over SSH only (no S3 integration).
21. **Rate limits are per IP.** Many users behind one NAT share limits for portal
    sign-up (10/hour/IP) and sign-in. The homeserver's SSO login limits were
    raised for this reason (burst 30, 0.5/s per IP).
22. **Time sync is required** (TOTP, certificates, federation). The installer warns
    but does not configure NTP itself.

## Upstream / dependency notes

23. Django 6.1 deprecates the `EMAIL_BACKEND` setting in favour of `MAILERS`
    (removal in 2028); Lumen still uses `EMAIL_BACKEND` and must migrate before
    that release.
24. django-allauth's OIDC provider issues no ID token to clients that
    authenticate with `client_secret_basic` (the client ID is read from the
    request body). Lumen configures Synapse with `client_secret_post`.
25. Synapse is licensed AGPL-3.0-or-later (or under Element's commercial licence);
    operators who modify it must offer the source to its users.
    Lumen runs the unmodified upstream image and an out-of-tree module whose source
    is in this repository. See [dependencies.md](dependencies.md).
26. matrix-js-sdk sends unencrypted to rooms it has not synced; the client only
    sends to joined, synced rooms (composer refuses otherwise).
