# Lumen Secure

Self-hostable, end-to-end encrypted chat on the open **Matrix** network, with a
public website, customer portal, plans and billing, and a private operator
console — installed on one Ubuntu 24.04 server with one command.

* **Decentralised:** every Lumen server is a Matrix homeserver (Synapse) and
  federates with any other Matrix server, Lumen or not.
* **End-to-end encrypted by default:** Olm/Megolm in the browser through the
  audited Rust implementation (vodozemac via matrix-sdk-crypto). Lumen contains
  no home-made cryptography; the server stores only ciphertext.
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

On a fresh Ubuntu Server 24.04 with DNS for `example.com`, `app.`, `matrix.`
and `ops.` pointing at it ([DNS examples](docs/operations/dns.md)):

```bash
git clone <your Lumen repository> lumen && cd lumen
sudo bash install.sh                                   # interactive
sudo bash install.sh --config lumen.conf --yes         # unattended; see lumen.conf.example
```

The installer checks the machine, installs Docker from Docker's repository,
generates secrets, renders and validates all configuration before using it,
adds firewall rules without resetting existing ones (SSH stays open), enables
automatic security updates, starts the stack, creates the first operator (one-time
setup link, MFA mandatory), takes and test-restores the first encrypted backup,
verifies every public endpoint and prints a summary without secrets. It is safe
to run again.

Operations: `./lumenctl` (status, logs, apply config, operators, federation,
WireGuard, secrets), `./update.sh`, `./backup.sh`, `./restore.sh`,
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
| optional | coturn (1:1 voice/video), WireGuard (private operator access) |

Architecture decisions: [ADR 0001](docs/adr/0001-architecture.md).

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
# Installer, in a disposable systemd Ubuntu 24.04 container:
bash tests/installer/vm.sh lumen-it lumen-it.test
```

What was run, with results and what was not verified:
[docs/test-report.md](docs/test-report.md).

## Licence

No licence file has been chosen for this repository yet; see
[docs/dependencies.md](docs/dependencies.md) §6.2. Third-party components keep
their own licences (Synapse: AGPL-3.0-or-later or Element commercial).
