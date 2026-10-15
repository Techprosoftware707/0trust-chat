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
| Network | public IPv4, ports 80/tcp, 443/tcp+udp open | IPv6 too; UDP 3478 and 49160–49200 if voice/video is on; UDP 51820 for WireGuard |
| DNS | A/AAAA records for `example.com`, `app.`, `matrix.` (and `ops.` for the console name) | see [dns.md](dns.md) |
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
| `/var/lib/lumen/www/chat` | built web chat app |
| `/var/lib/lumen/sockets` | Unix sockets between Caddy and the apps |
| `/var/backups/lumen` | encrypted backups |
| `/var/log/lumen` | install, update, backup, restore logs |

Container users: app 10001 (group 10300 for sockets, 10100 for secrets), Caddy
10200, Synapse 991, PostgreSQL 70. Host groups `lumen-secrets` (10100) and
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
sudo ./lumenctl logs synapse -f           # portal | ops | worker | synapse | caddy | postgres | coturn
sudo ./lumenctl restart portal
sudo ./healthcheck.sh                     # pass/fail of every component (exit 0/1/2)
sudo ./diagnose.sh                        # explains DNS/TLS/federation/SMTP/payment problems
sudo ./lumenctl config                    # resolved configuration (no secrets)
sudo ./lumenctl manage <command>          # Django management command in a one-off container
```

A systemd timer runs `healthcheck.sh --quiet --record` every 5 minutes; the
console's **Service health** page shows the probes the worker runs continuously
(website, console, chat app, homeserver, database, federation, TLS including the
negotiated key exchange, email, TURN, backups, disk, payments).

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

## 8. Billing

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

## 9. Branding

Replace `/etc/lumen/branding/logo.svg` and `favicon.svg`, and override colour
tokens in `/etc/lumen/branding/theme.css` (e.g. `--brand-primary`), set
`BRAND_NAME`, `BRAND_SHORT_NAME`, `BRAND_LEGAL_NAME`, contact addresses in
`lumen.conf`, then `sudo ./lumenctl apply`. Review the privacy policy and terms
pages with counsel before going live; they are templates filled with your
configuration.

## 10. Backups and updates

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

## 11. Secrets

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

## 12. Security checklist for production

- [ ] `TLS_MODE=acme` with real DNS; `ADMIN_EMAIL` reachable.
- [ ] Console reachable only via SSH tunnel or WireGuard; `ADMIN_ALLOWED_CIDRS` empty unless needed.
- [ ] Every operator has MFA (enforced) and a personal account; no shared logins.
- [ ] Backup key copied off the server; `BACKUP_REMOTE` configured; restore tested.
- [ ] SSH: key-only authentication, no root login (Lumen does not change SSH).
- [ ] Host disk encryption if the provider supports it.
- [ ] SMTP configured, or a documented process for recovery links.
- [ ] Privacy policy, terms and `SECURITY_EMAIL` reviewed.
- [ ] `sudo ./healthcheck.sh` clean; console shows no failed probes.

## 13. Uninstall

```bash
sudo ./uninstall.sh                  # stop and remove containers and units; keep data, config, backups
sudo ./uninstall.sh --purge-data     # also delete databases, media, config and secrets (typed confirmation)
```

A final encrypted backup is taken first unless `--no-final-backup` is given;
backups are never deleted. Firewall rules added by Lumen carry the comment
`lumen:` and are removed; other rules are left alone.
