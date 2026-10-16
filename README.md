# Lumen Secure

Self-hostable, end-to-end encrypted chat on the open **Matrix** network, with a
public website, customer portal, plans and billing, and a private operator
console — installed on one Ubuntu 24.04 server with one command.

* **Decentralised:** every Lumen server is a Matrix homeserver (Synapse) and
  federates with any other Matrix server, Lumen or not.
* **End-to-end encrypted by default:** Olm/Megolm in the browser through the
  audited Rust implementation (vodozemac via matrix-sdk-crypto). Lumen contains
  no home-made cryptography; the server stores only ciphertext.
* **Voice and video calls:** 1:1 and group calls with HD voice, up to 1080p
  video and screen sharing. They use MatrixRTC (the protocol Element Call
  uses) through a LiveKit SFU on your server. Media is end-to-end encrypted in
  the browser with keys exchanged over Matrix, so the SFU forwards ciphertext
  it cannot decrypt. TURN over UDP and TLS is included for restrictive
  networks, and nothing is recorded. See [ADR 0002](docs/adr/0002-calling.md).
* **Zero-trust layout:** separate services with separate credentials, an
  operator console that is not on the public internet, MFA and RBAC for
  operators, an append-only audit log, no hidden accounts, no Docker socket in
  any container.
* **Honest posture:** the website and console say what the server can see
  (metadata) and that message encryption is not post-quantum; hybrid
  post-quantum TLS is shown only when a real handshake negotiates it.

Name, logo, colours and domains are configuration (`BRAND_*`,
`/etc/lumen/branding`).

## Install

On a fresh Ubuntu Server 24.04 with DNS for `example.com`, `app.`, `matrix.`,
`rtc.` (calls) and `ops.` pointing at it ([DNS examples](docs/operations/dns.md)).
Open TCP 80 and 443, UDP 443, and the calls ports (7882–7889/udp, 7881/tcp,
3478/udp) in any cloud firewall in front of the server:

```bash
git clone <your Lumen repository> lumen && cd lumen
sudo bash install.sh                                   # interactive
sudo bash install.sh --config lumen.conf --yes         # unattended; see lumen.conf.example
```

**No domain yet?** `sudo bash install.sh --test` sets up a test server reachable by
its IP address (host names under `<ip>.sslip.io`, a private test CA that each test
device trusts once). See [Testing without a domain](docs/operations/admin-guide.md#test-setup).

The installer checks the machine, installs Docker from Docker's repository,
generates secrets, renders and validates all configuration before using it,
adds firewall rules without resetting existing ones (SSH stays open), enables
automatic security updates, starts the stack, creates the first operator (one-time
setup link, MFA mandatory), takes and test-restores the first encrypted backup,
verifies every public endpoint and prints a summary without secrets. It is safe
to run again.

Operations: `./lumenctl` (status, logs, apply config, operators, federation,
WireGuard, secrets, `calls-selftest`), `./update.sh`, `./backup.sh`, `./restore.sh`,
`./healthcheck.sh`, `./diagnose.sh`, `./uninstall.sh`.
Start with the [administrator guide](docs/operations/admin-guide.md).

## What runs

| Service | What it is |
|---|---|
| Caddy | TLS (Let's Encrypt), HTTP/3, security headers, routing to Unix sockets; console gate |
| portal | Django: website, sign-up/sign-in (Argon2id, TOTP, WebAuthn), customer portal, workspaces, plans and billing, OIDC provider for chat sign-in |
| ops | the same code on a private surface: operator console |
| worker | health probes, billing lifecycle, retention, account deletions, email |
| synapse | unmodified upstream Matrix homeserver + a small entitlement module |
| postgres | PostgreSQL 17 on an internal-only network |
| web chat | static React app on matrix-js-sdk + Rust crypto (WASM) |
| livekit | LiveKit SFU for calls (host network; forwards end-to-end encrypted media; embedded TURN) |
| lkjwt | MatrixRTC authorization service: SFU tokens only for room members, via the homeserver |
| optional | WireGuard (private operator access) |

Architecture decisions: [ADR 0001](docs/adr/0001-architecture.md) (platform),
[ADR 0002](docs/adr/0002-calling.md) (calls).

## Documentation

| Audience | Document |
|---|---|
| Users | [User guide](docs/user-guide.md) (also published on the website under Docs) |
| Operators | [Administrator guide](docs/operations/admin-guide.md) · [Disaster recovery](docs/operations/disaster-recovery.md) · [DNS](docs/operations/dns.md) · [`lumen.conf.example`](lumen.conf.example) |
| Security | [Security architecture](docs/security/architecture.md) · [Privacy & threat model](docs/security/threat-model.md) · [Post-quantum readiness](docs/security/post-quantum.md) |
| Everyone | [Known limitations](docs/known-limitations.md) · [Test report](docs/test-report.md) · [Dependencies & licences](docs/dependencies.md) |

## Repository layout

```
install.sh update.sh backup.sh restore.sh healthcheck.sh diagnose.sh uninstall.sh lumenctl
docker-compose.yml            the stack (images pinned in deploy/versions.env)
deploy/lib/                   installer libraries, config renderer (render.py), verification
deploy/host-agent/            root helper with a fixed operation allow-list (WireGuard, backups, restarts)
deploy/systemd/               agent, backup, backup-verify and health timers
deploy/templates/             PostgreSQL roles, Synapse SSO page templates
services/portal/              Django project (website, portal, IdP, console, worker) + tests
services/chat/                web chat client (React + matrix-js-sdk) + unit tests
services/synapse-module/      plan entitlements for media uploads (Synapse module API)
design/ branding/             design tokens, fonts, icons; default brand assets
tests/                        integration, UI, E2EE, federation, security, installer suites
docs/                         ADR, security, operations, user docs
```

## Development and tests

```bash
# Portal unit tests (PostgreSQL required; see services/portal/pytest.ini)
cd services/portal && python -m pytest
# Chat client
cd services/chat && npm ci && npm run typecheck && npm run lint && npm test
# Against a running stack (as root on the host):
node tests/ui/portal.e2e.mjs            # website, portal, operator console (Playwright)
node tests/chat/deployed.e2ee.mjs       # SSO + encrypted DM; DB holds only ciphertext
python3 tests/integration/entitlements.py
bash tests/security/scan.sh
bash tests/federation/run.sh            # second, independent homeserver
bash tests/calls/lab.sh up              # network namespaces = separate client networks
(cd services/chat && npm run test:calls) # real browser calls between namespaces (see tests/calls/)
bash tests/calls/wg_calls.sh            # calls with the operator WireGuard tunnel up
bash tests/calls/bench.sh 30            # SFU capacity on this host
# Installer, in a disposable systemd Ubuntu 24.04 container:
bash tests/installer/vm.sh lumen-it lumen-it.test
```

What was run, with results and what was not verified:
[docs/test-report.md](docs/test-report.md).

## Licence

No licence file has been chosen for this repository yet; see
[docs/dependencies.md](docs/dependencies.md) §6.2. Third-party components keep
their own licences (Synapse: AGPL-3.0-or-later or Element commercial).
