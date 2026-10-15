# Administrator guide

For the person who installs and runs a Lumen server. Assumes basic Linux and
DNS knowledge. Disaster recovery has its own guide:
[disaster-recovery.md](disaster-recovery.md). DNS records:
[dns.md](dns.md).

## 1. Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu Server 24.04 LTS, x86_64 or arm64, systemd | fresh install, nothing else on ports 80/443 |
| CPU / RAM | 2 vCPU / 4 GB | 4 vCPU / 8 GB (hundreds of active users) |
| Disk | 20 GB free | 40 GB+ for `/var/lib` and `/var/backups` (media and backups grow) |
| Network | public IPv4; ports 80/tcp, 443/tcp+udp; for calls 7882–7889/udp, 7881/tcp, 3478/udp | IPv6 too; UDP 51820 for WireGuard; bandwidth for calls (see [Calls](#calls)) |
| DNS | A/AAAA records for `example.com`, `app.`, `matrix.`, `rtc.` (calls) and `ops.` (console certificate) | see [dns.md](dns.md) |
| Time | NTP synchronised (`timedatectl`) | — |

The installer checks all of these (preflight) and refuses to continue on hard
failures (wrong OS, ports taken by another program, no internet). It never
replaces an existing reverse proxy, resets a firewall or stops unrelated services.

## 2. Install

```bash
git clone <your Lumen repository> lumen && cd lumen
sudo bash install.sh                                  # interactive
# or unattended:
cp lumen.conf.example lumen.conf && nano lumen.conf
sudo bash install.sh --config lumen.conf --yes
```

The installer copies itself to `/opt/lumen` and runs from there. Phases:
configuration → preflight → host packages and Docker (from download.docker.com)
→ secrets → render + validate configuration in a staging directory → firewall
and unattended upgrades → WireGuard (optional) → images (digest-pinned pulls,
portal image and chat app built locally) → database → services (health-gated) →
host agent and timers → first operator → first encrypted backup and an isolated
restore test → verification of every public endpoint → summary.

It is idempotent: run it again at any time; existing secrets, data, signing key
and configuration are kept. The summary never prints secrets. Exit code 0 means
every endpoint check passed; exit 3 means the stack is up but a check failed
(the summary says which).

## 3. Where things are

| Path | Contents |
|---|---|
| `/opt/lumen` | the installed code; run `./lumenctl`, `./update.sh`, … from here |
| `/etc/lumen/lumen.conf` | your configuration (see `lumen.conf.example`) |
| `/etc/lumen/secrets/` | generated and external secrets (root:lumen-secrets, 0440) — never edit by hand; use `lumenctl rotate` / `set-secret` |
| `/etc/lumen/rendered/` | generated configuration (Caddyfile, homeserver.yaml, …); `rendered.prev` is the previous version |
| `/etc/lumen/branding/` | `logo.svg`, `favicon.svg`, `theme.css` — your brand (kept across updates) |
| `/etc/lumen/backup/` | `identity.txt` (backup decryption key — copy off the server!), `recipients.txt`, optional `ssh_key` |
| `/etc/lumen/ca/` | internal test CA certificates (TLS_MODE=internal only) |
| `/etc/lumen/wireguard/` | WireGuard server keys and peer registry |
| `/var/lib/lumen/postgres` | PostgreSQL data (portal and homeserver databases) |
| `/var/lib/lumen/synapse` | homeserver signing key (**server identity**) and media store |
| `/var/lib/lumen/caddy` | TLS certificates and ACME account |
| `/etc/lumen/rendered/livekit/livekit.yaml` | generated SFU configuration (no secrets; the API key is in `/etc/lumen/secrets/livekit_keys`) |
| `/var/lib/lumen/www/chat` | built web chat app |
| `/var/lib/lumen/sockets` | Unix sockets between Caddy and the apps |
| `/var/backups/lumen` | encrypted backups |
| `/var/log/lumen` | install, update, backup, restore logs |

Container users: app 10001 (group 10300 for sockets, 10100 for secrets), Caddy
10200, Synapse 991, PostgreSQL 70, LiveKit SFU 10400, calls authorization
service 10401. Host groups `lumen-secrets` (10100) and
`lumen-sockets` (10300) are created by the installer.

## 4. The operator console

The console is **not on the public internet**. Caddy serves it on
`ops.<domain>:8443` and drops connections that don't come from localhost, the
WireGuard subnet or `ADMIN_ALLOWED_CIDRS`; the firewall does not open 8443.

Reach it with an SSH tunnel:

```bash
ssh -N -L 8443:127.0.0.1:8443 you@server
# on your computer, hosts file:  127.0.0.1  ops.example.com
# browse to https://ops.example.com:8443/
```

or through WireGuard (`WIREGUARD_ENABLED=true`, then add a peer in the console
or with `sudo ./lumenctl wireguard add-peer laptop`). `sudo ./lumenctl
admin-tunnel` prints these instructions for your server.

**First operator.** The installer creates the account named by
`OPERATOR_USERNAME` with no password and stores a one-time setup link in
`/etc/lumen/operator-setup-link.txt` (root-only, 24 h). Open it through the
tunnel, choose a password, sign in, enrol TOTP or a security key (mandatory for
operators), save the recovery codes. More operators: `sudo ./lumenctl
create-operator <user> <email> [role]`. Lost password or MFA device:
`sudo ./lumenctl operator-link <user>` prints a new one-time link (it is
audit-logged).

**Roles.**

| Role | Can |
|---|---|
| owner | everything, including managing operators and their roles (the last owner cannot be demoted) |
| admin | users, workspaces, plans, platform (backups, WireGuard, restarts, settings), security and audit |
| support | view and manage customer accounts (suspend, sign out, recovery links), support inbox, security events |
| billing | plans, subscriptions, webhooks, workspaces; view users |
| auditor | read-only: users, workspaces, billing, security events, audit log (and chain verification) |

Destructive actions (suspend, delete, MFA reset, role change, restore, peer
removal, restarts) ask for re-authentication if the last sign-in is older than
5 minutes, and some require typing the target's name. Every action is written to
the append-only, hash-chained audit log (**Audit log → Verify chain**).

What the console shows is metadata only; there is no view of message content
anywhere.

## 5. Day-to-day commands

```bash
sudo ./lumenctl status                    # containers, health, versions
sudo ./lumenctl logs synapse -f           # portal | ops | worker | synapse | caddy | postgres | livekit | lkjwt
sudo ./lumenctl restart portal
sudo ./healthcheck.sh                     # pass/fail of every component (exit 0/1/2)
sudo ./diagnose.sh                        # explains DNS/TLS/federation/SMTP/payment problems
sudo ./lumenctl config                    # resolved configuration (no secrets)
sudo ./lumenctl manage <command>          # Django management command in a one-off container
```

A systemd timer runs `healthcheck.sh --quiet --record` every 5 minutes; the
console's **Service health** page shows the probes the worker runs continuously
(website, console, chat app, homeserver, database, federation, TLS including the
negotiated key exchange, email, calls SFU, TURN, backups, disk, payments).

## 6. Changing configuration

Edit `/etc/lumen/lumen.conf`, then:

```bash
sudo ./lumenctl apply
```

This renders the new configuration into a staging directory, validates it
(Caddy, Synapse, Compose), and only then activates it and restarts what
changed. Invalid configuration is never activated. Shortcuts:
`lumenctl federation open|closed|allowlist a.example,b.example`.

`MATRIX_SERVER_NAME` (default: the primary domain) cannot change once users
exist — it is part of every user ID and of the federation identity.

## 7. Registration, federation, email

* `REGISTRATION_MODE=open|invite|closed`. Invite mode: people can only sign up
  through a workspace invitation link.
* `FEDERATION_MODE=open|allowlist|closed`. The console's **Homeserver &
  federation** page shows discovery, signing-key verification and (with a
  notary) external reachability. Federation needs `/.well-known/matrix/server`
  on the primary domain, which Lumen serves.
* SMTP: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_SECURITY`, `SMTP_FROM`
  in `lumen.conf`, then `sudo ./lumenctl set-secret smtp_password` and
  `sudo ./lumenctl apply`. Email verification then becomes mandatory for new
  accounts and password reset by email is enabled. Without SMTP the product says
  so wherever email would be involved; nothing pretends an email was sent.

## 8. Voice and video calls<a id="calls"></a>

Calls are on by default (`CALLS_ENABLED=true`). They use MatrixRTC, the same
protocol as Element Call. Media goes through a LiveKit SFU on this server, and
access is granted by a small authorization service (`lkjwt`) that the
homeserver consults. The design and its limits are described in
[ADR 0002](../adr/0002-calling.md).

**What the server can and cannot see.** Media is end-to-end encrypted by the
participants' apps. The SFU forwards encrypted frames and cannot decrypt them.
Nothing is recorded: no recording component is installed.

The SFU does see call metadata:

- pseudonymous participant IDs;
- when people join and leave;
- track types and bitrates;
- audio levels (used for the "speaking" indicator).

**DNS and certificate.** Point `rtc.<domain>` (or `LUMEN_RTC_DOMAIN`) at the
server; see [dns.md](dns.md). Caddy obtains its certificate and serves call
signalling (`wss://rtc.<domain>`) on 443.

**Ports.** The installer opens these in UFW. Open them in your cloud
provider's firewall or security group as well:

| Port | Purpose |
|---|---|
| 443/tcp | call signalling (`wss://rtc.<domain>`), through Caddy |
| 7882–7889/udp (`CALLS_UDP_PORTS`) | media (ICE/UDP); the best path |
| 7881/tcp (`CALLS_TCP_PORT`) | media over TCP when UDP is blocked |
| 3478/udp (`CALLS_TURN_UDP_PORT`) | TURN relay for clients behind strict NATs |

**No TURN over TLS.** LiveKit 1.13 advertises TURN/TLS only as
`turns:<domain>:443`, because it expects a TLS-terminating load balancer there.
On a Lumen server, 443 belongs to Caddy, so Lumen does not offer TURN/TLS
rather than advertise a path that cannot work. What this means:

- Clients behind firewalls that block UDP still connect through **ICE over
  TCP on 7881**.
- Clients on networks that allow only HTTPS on port 443 cannot join calls.
  They see a clear "couldn't connect to the media server" message.

Some ports are never opened:

- the SFU's API (`127.0.0.1:7880`, reachable only from the internal `rtc`
  Docker network);
- its metrics (`127.0.0.1:6789`);
- the TURN relay range (40000–40999/udp; the relay only talks to the local
  SFU).

**The server's public address.** The SFU must advertise the address clients
reach it on. With `CALLS_PUBLIC_IP` empty, LiveKit discovers it at startup
with a STUN request to public STUN servers (LiveKit's default: Google's).
Set `CALLS_PUBLIC_IP=<public IPv4>` in three cases:

- you know the address;
- the server is behind 1:1 NAT, such as a cloud VM with an elastic IP;
- you don't want that startup request.

Without the right address, signalling works but media never connects. **HTTPS
working does not prove calls work.** `sudo ./diagnose.sh` compares the
address the SFU advertises with the server's public IPv4 and says what to
fix.

**Checks.**

```bash
sudo ./lumenctl calls-selftest       # real audio+video through the SFU to test subscribers
sudo ./healthcheck.sh                # includes SFU, authorization service, TURN
sudo ./diagnose.sh                   # explains call problems: advertised IP, DNS/TLS for rtc., firewall, TURN
```

The installer runs the same checks, plus the media self-test. The console's
**Calls** page shows the following, read from the SFU's own counters every
minute:

- active calls, participants and tracks;
- throughput, CPU and memory;
- RTT, jitter and packet loss.

The page shows no names and no call content. Its **Run media self-test**
button runs the same test as `lumenctl calls-selftest`. The self-test runs on
the server, so it does **not** prove that clients on the internet can reach
the media ports. To prove that, make a call from outside.

**WireGuard.** Calls do not depend on the operator VPN. Both setups were
tested and work:

- a VPN profile that routes only the server's WireGuard address;
- a VPN profile that routes the server's public address through the tunnel.

A VPN being up does not by itself guarantee WebRTC connectivity. ICE picks
whichever path works.

**Capacity.** No participant limit is set (`CALLS_MAX_PARTICIPANTS=0`). Set
one if you want a hard cap per call. The limiting resources are outbound
bandwidth first, then CPU. Each receiver gets about 1.2–2.5 Mbit/s per visible
720p video tile, plus about 30–50 kbit/s per speaking voice. To measure your
own host:

```bash
sudo bash tests/calls/bench.sh 30
```

The results this project measured are in
`docs/test-results/calls-sfu-benchmark.txt`. They are what one test host did,
not a promise. Scaling beyond one server means three things:

- a TURN server on another host;
- LiveKit's multi-node mode with Redis;
- pointing `LUMEN_RTC_DOMAIN` at it.

None of these is automated.

**Turning calls off.** Set `CALLS_ENABLED=false` and run
`sudo bash install.sh`. The call buttons disappear from the app, the
homeserver stops advertising the SFU, and the SFU and authorization-service
containers are removed. Keys and configuration stay in `/etc/lumen`, so
calls can be turned back on later. `sudo ./lumenctl apply` does the same
except for the firewall. The installer also
removes the firewall rules it labelled `lumen: calls`. Rules that Lumen did
not add are never touched.

**Restarts.** `sudo ./lumenctl restart livekit lkjwt` drops active calls;
clients reconnect automatically. It touches no other data.

## 8a. Mobile and desktop apps, push notifications<a id="apps"></a>

The Windows, macOS, Android and iOS/iPadOS apps
([ADR 0003](../adr/0003-client-apps.md)) need no per-server build. A user types
your server name, and the app reads everything else from
`https://<domain>/.well-known/matrix/client`:

- the homeserver;
- the `io.lumen.app` block: portal, sign-up and account links, the call
  widget URL, and the push gateway URL when push is enabled.

See [the integration reference](../apps/integration.md). Sign-in is the same
single sign-on as on the web. The apps open it in the system browser and
return to the app through the `io.lumen.secure:/sso-callback` address, which
Lumen allows in the homeserver's SSO configuration.

**Verified links** (`https://app.<domain>/…` opening the app). Set the
identities of **your signed builds** and run `sudo ./lumenctl apply`:

- `APP_LINKS_ANDROID_SHA256` for Android: the signing certificate's SHA-256
  fingerprint from Play App Signing;
- `APP_LINKS_APPLE_TEAM_ID` for iOS.

**Push notifications** (Android and iOS) are optional. Without them the
mobile apps show notifications only while they run, and say so in their
settings. To enable push:

1. Create a Firebase project for your Android build and an APNs auth key
   (`.p8`) for your iOS bundle ID. The release guides
   `docs/apps/release-android.md` and `docs/apps/release-ios.md` show where.
2. Store the credentials:
   - `sudo ./lumenctl set-secret push_fcm_service_account < service-account.json`
   - `sudo ./lumenctl set-secret push_apns_key < AuthKey_XXXXXXXXXX.p8`
3. In `lumen.conf`, set `PUSH_ENABLED=true`, `PUSH_FCM_PROJECT_ID`,
   `PUSH_APNS_TEAM_ID` and `PUSH_APNS_KEY_ID`, then run `sudo bash install.sh`.

How the gateway runs:

- **Where.** The Sygnal push gateway runs on this server, listening on
  `127.0.0.1` only. The homeserver reaches it through Caddy at
  `https://matrix.<domain>/_matrix/push/v1/notify`. Requests from public
  addresses get 404.
- **What it sends.** The homeserver sends only room ID, event ID and unread
  counts (`push.include_content: false`). Google and Apple learn that a
  device received a notification and when, never the content. The app
  fetches and decrypts the message itself.
- **Checks.** `sudo ./healthcheck.sh` and the installer's verification test
  the gateway and the homeserver's path to it.

What can't be checked from the server: delivery to real devices. Check it
with a signed build on a phone.

## 9. Billing

`BILLING_PROVIDER=none` (everyone on Free), `manual` (operators assign plans in
**Workspaces → plan**, e.g. for invoiced customers) or `stripe`.

Stripe setup:

1. In Stripe, create a product and recurring prices for each paid plan.
2. In the console, **Plans & entitlements → edit plan**: set the Stripe monthly
   and yearly price IDs; review limits and prices shown on the website.
3. In Stripe, add a webhook endpoint `https://<primary domain>/billing/webhooks/stripe/`
   with events `checkout.session.completed`,
   `customer.subscription.created|updated|deleted`, `invoice.paid`,
   `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.finalized`.
4. On the server: set `BILLING_PROVIDER=stripe` (and `STRIPE_PUBLISHABLE_KEY`)
   in `lumen.conf`, then
   `sudo ./lumenctl set-secret stripe_secret_key`,
   `sudo ./lumenctl set-secret stripe_webhook_secret`,
   `sudo ./lumenctl apply`.
5. **Webhooks** in the console lists every event received and whether it was
   verified and processed; **Subscriptions → reconcile** re-reads one from Stripe.

Lifecycle: `past_due` keeps paid entitlements for `BILLING_GRACE_DAYS`, then the
workspace falls back to Free limits. Downgrades never delete data; they block
new seats or uploads above the new limits. Plans and limits can be edited in
the console without code changes; `services/portal/config/plans.yml` only seeds
a new installation.

## 10. Branding

Replace `/etc/lumen/branding/logo.svg` and `favicon.svg`, and override colour
tokens in `/etc/lumen/branding/theme.css` (e.g. `--brand-primary`), set
`BRAND_NAME`, `BRAND_SHORT_NAME`, `BRAND_LEGAL_NAME`, contact addresses in
`lumen.conf`, then `sudo ./lumenctl apply`. Review the privacy policy and terms
pages with counsel before going live; they are templates filled with your
configuration.

## 11. Backups and updates

* Backups: daily at `BACKUP_SCHEDULE` (default 03:17), age-encrypted, 7 daily
  + 4 weekly kept; a weekly job restores the latest backup into an isolated,
  network-less database to prove it works. Manual: `sudo ./backup.sh`.
  **Copy `/etc/lumen/backup/identity.txt` somewhere safe off the server** — it
  is the only key that decrypts the backups. Configure `BACKUP_REMOTE` for an
  off-site copy. Full procedures: [disaster-recovery.md](disaster-recovery.md).
* Updates: `sudo ./update.sh`. It takes a pre-update backup, pulls the new code
  (fast-forward only), renders and validates configuration, pulls the pinned
  images, rebuilds, migrates, restarts and verifies; on failure it restores the
  previous configuration, images and chat build. Database migrations cannot be
  rolled back automatically — restore the pre-update backup if needed (the
  command is printed).
* OS security updates are installed automatically (`unattended-upgrades`, no
  automatic reboot); reboot during a maintenance window when
  `/var/run/reboot-required` exists (the console shows pending updates).

## 12. Secrets

| Command | Effect |
|---|---|
| `sudo ./lumenctl rotate ops-gateway` | new Caddy↔console gateway secret |
| `sudo ./lumenctl rotate internal-api` | new homeserver↔console API token |
| `sudo ./lumenctl rotate synapse-admin` | new homeserver service-account token |
| `sudo ./lumenctl rotate oidc-client` | new OIDC client secret (portal ↔ homeserver) |
| `sudo ./lumenctl rotate db-passwords` | new database passwords, applied to roles |
| `sudo ./lumenctl rotate django` | new Django secret key (signs everyone out of the portal) |
| `sudo ./lumenctl set-secret <name>` | SMTP password, Stripe keys |

The homeserver signing key is the server's identity on the federation; never
rotate or lose it casually (it is in every backup).

## 13. Security checklist for production

- [ ] `TLS_MODE=acme` with real DNS; `ADMIN_EMAIL` reachable.
- [ ] Console reachable only via SSH tunnel or WireGuard; `ADMIN_ALLOWED_CIDRS` empty unless needed.
- [ ] Every operator has MFA (enforced) and a personal account; no shared logins.
- [ ] Backup key copied off the server; `BACKUP_REMOTE` configured; restore tested.
- [ ] SSH: key-only authentication, no root login (Lumen does not change SSH).
- [ ] Host disk encryption if the provider supports it.
- [ ] SMTP configured, or a documented process for recovery links.
- [ ] Privacy policy, terms and `SECURITY_EMAIL` reviewed.
- [ ] `sudo ./healthcheck.sh` clean; console shows no failed probes.

## 14. Uninstall

```bash
sudo ./uninstall.sh                  # stop and remove containers and units; keep data, config, backups
sudo ./uninstall.sh --purge-data     # also delete databases, media, config and secrets (typed confirmation)
```

A final encrypted backup is taken first unless `--no-final-backup` is given;
backups are never deleted. Firewall rules added by Lumen carry the comment
`lumen:` and are removed; other rules are left alone.
