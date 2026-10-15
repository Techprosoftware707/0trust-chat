# Test report — Lumen 1.0.0

Date: 2026-10-15. Every result below was observed in this session, on the code at
or just before the commit that adds this file. Raw outputs are in
[`docs/test-results/`](test-results/). Anything not listed under "Results" was
**not** tested; see "Not verified" at the end and
[known-limitations.md](known-limitations.md).

## Environment

| | |
|---|---|
| Host | Ubuntu 24.04.5 LTS userland in a Firecracker microVM (kernel 6.18), 4 vCPU, 15 GB RAM, Docker 29.8.2, Compose 5.6. **No systemd as PID 1** — the host agent was started by hand for the dev stack. |
| "Dev stack" | Lumen installed on that host with `install.sh`, `TLS_MODE=internal` (Caddy local CA), domains `lumen.test`, `app.`, `matrix.`, `ops.`, `rtc.` resolved to 127.0.0.1, WireGuard enabled, calls enabled (`CALLS_PUBLIC_IP=10.200.0.1`, the lab bridge address, with `CALLS_ALLOW_PRIVATE_NODE_IP=true`). |
| Call lab | `tests/calls/lab.sh`: bridge `lumenlab` 10.200.0.1/24 and network namespaces `lab-a`, `lab-b`, `lab-c` (10.200.0.11–13). Each has its own interface, routes, firewall (used to block UDP) and `netem` shaping (loss, delay, bandwidth, outages). Every browser or WebRTC client in a call test runs in its own namespace, so its media really crosses a separate network path to the SFU. |
| Installer test server | `tests/installer/vm.sh`: a privileged **systemd** container from `ubuntu:24.04` (24.04.5), its own Docker 29.9.1 installed by the installer from download.docker.com, its own storage. Shares the host kernel; no NTP; no public IP. |
| Outbound network | Through a TLS-inspecting egress proxy; its CA was supplied to image builds with `LUMEN_BUILD_EXTRA_CA` (build-time secret, not baked into images — checked). |
| Browsers | Playwright Chromium (headless), Node 22. |

## Results

| Suite | What it proves | Result | Evidence |
|---|---|---|---|
| Portal unit/integration (pytest, PostgreSQL 17) | accounts, sign-up rules, MFA, sessions, idle timeout, no superusers; workspace tenant isolation (IDOR), invitations, seat limits, plan entitlements; billing lifecycle, Stripe webhook signatures (Stripe's real scheme), idempotency; OIDC claims/policy; console RBAC, gateway secret, step-up, audit append-only + hash chain, internal API auth, security headers, no inline scripts, rate limits (atomic); crypto-posture display | **97 passed** | `portal-unit.txt` |
| Chat unit (vitest) | config validation, timeline/rooms/media/session-store logic | **64 passed** | `chat-unit.txt` |
| Chat typecheck + lint | TypeScript strict, ESLint | **clean** | — |
| Chat E2EE (Node + real Synapse) | two users, encrypted DM and file; server responses (`/messages`, admin API, `/sync`) contain only `m.room.encrypted`; tampered file rejected | **5/5** | `chat-browser-suites.txt` |
| Chat UI (Playwright, production build + production CSP) | login, secure backup, DM, formatting, receipts, reply/react/edit/delete, encrypted images, search, emoji verification, identity banners, new-device recovery, sessions, notifications, offline, theme, sign-out wipe, no CSP violations | **22/22** | `chat-browser-suites.txt` |
| Chat VoIP (Playwright, fake media) | 1:1 voice/video connect; DTLS-SRTP badge only after `getStats()` confirms; decline | **4/4** | `chat-browser-suites.txt` |
| **Deployed app E2EE** (`tests/chat/deployed.e2ee.mjs`) | two people sign up on the portal, SSO into `https://app.lumen.test`, encrypted DM both ways; then the homeserver's PostgreSQL is queried: only `m.room.encrypted` message events exist and the plaintext markers appear nowhere in `event_json` | **7/7** | `chat-deployed-e2ee.txt` |
| SSO integration (`tests/integration/sso_flow.py`) | portal sign-up → homeserver SSO → portal OIDC (PKCE) → login token → `/whoami` | **pass** | `sso-flow.txt` |
| Plan entitlements end to end (`tests/integration/entitlements.py`) | Free user: `/media/config` = 25 MB, 25 MB+1 KB upload refused by the homeserver (413); Pro workspace member: 100 MB advertised, same upload accepted | **5/5** | `entitlements.txt` |
| Website, portal, console UI (`tests/ui/portal.e2e.mjs`) | all public pages (one h1, no CSP/console errors, link crawl, dark mode, theme toggle, 390 px no overflow), sign-up, weak-password error, workspace + invitation link, billing without provider never shows success, TOTP enrolment, sign-in with TOTP (wrong code rejected), data export, operator onboarding by one-time link with mandatory MFA, link single-use, every console page, metadata-only user view, step-up + audit for suspension, audit-chain verification, mobile console | **73/73** | `ui-portal-console.txt`, screenshots in `tests/ui/output/` (not committed) |
| Federation (`tests/federation/run.sh`) | independent vanilla Synapse (`remote.test`) with its own CA: discovery, notary key fetch, encrypted-by-default room, federated invite/join, messages both ways, worker reachability probe, allow-list denial | **13/13** from a clean remote | `federation.txt` |
| WireGuard (`tests/integration/wireguard_e2e.sh`) | peer created by the host agent (server-generated keys + PSK), console reachable only through the tunnel, PSK handshake, revocation | **7/7** | `wireguard-e2e.txt` |
| Security scan (`tests/security/scan.sh`) | listeners/published ports, internal DB network, console network gate (with control), TLS 1.0/1.1 refused, TLS 1.3, HTTP→HTTPS, HSTS/CSP/nosniff/no Server header, admin/console/internal paths hidden, CSRF, open redirects, SSO-only homeserver, registration closed, container hardening ×8, no secrets in env/image/history/repository; **calls**: SFU listeners (signalling/metrics loopback-only), `/twirp` `/metrics` `/sfu_webhook` `/debug` hidden (404), SFU API refused outside the calls network (with control), forged token 401, valid token cannot create rooms (404), anonymous token request 401, TURN/TLS refuses TLS 1.0/1.1, TURN credential TTL and relay denies, relay range closed in UFW, no recording service, no Matrix IDs in SFU/authorization logs | **123/123** on the dev host and **123/123** on the installer test server (there the repository check is vacuous: no git checkout) | `security-scan.txt`, `security-scan-installer-server.txt` |
| Static analysis | bandit (portal): 0 high, 0 medium, 14 low (reviewed: event labels, rate-limit strings, test settings, fixed-argv subprocess); shellcheck on all shell scripts: no errors/warnings; pip-audit (hashed requirements): no known vulnerabilities; npm audit (production deps): 0 | **clean** | — |
| **Installer: fresh install** on the systemd Ubuntu 24.04.5 test server | preflight → Docker → secrets → staged config validation → UFW (SSH kept) → unattended upgrades → images → DB → services → agent/timers → operator link → backup + isolated restore → 20 endpoint and exposure checks incl. TURN STUN | **SUCCESS, exit 0** (twice, on fresh servers) | `installer-fresh-install.txt` |
| **Installer lifecycle** (`tests/installer/lifecycle.sh`) | re-install keeps secrets/signing key/data; healthcheck; diagnose; encrypted backup unreadable without key; verify-only; full restore rolls data back; update; uninstall keeps data/backups; re-install on kept data; secret-leak scan of all logs | round 1: 25/29 → bugs fixed → round 2 on a new server: **29/29** | `installer-lifecycle-round1.txt`, `…-round2.txt` |
| **Installer with calls: fresh install** (Ubuntu 24.04.5 systemd test server, `CALLS_ENABLED=true`) | everything above plus: calls ports in UFW, `rtc.` certificate copied for TURN/TLS, authorization service healthy, SFU running; verification: SFU signalling, transports advertised, anonymous token 401, non-member 403, admin API hidden, UDP/TCP media listeners, TURN STUN, TURN/TLS certificate, **real media self-test** (LiveKit load tester: audio + video publishers, 2 subscribers, 4/4 tracks received) | **SUCCESS, exit 0** (twice, on fresh servers) | `installer-fresh-install-calls.txt` |
| **Installer lifecycle with calls** | the lifecycle above plus a media self-test after re-install, SFU restart (`lumenctl restart livekit lkjwt`: config unchanged, data untouched), restore, update, uninstall + re-install; calls off (containers removed, Lumen's calls firewall rules closed, SFU no longer advertised, app without calls) and on again (rules back, media flows) | round 1: 37/38 (**bug: re-running the installer failed preflight on Lumen's own SFU ports**) → fixed → round 2 on a new server: **47/47** | `installer-lifecycle-calls-round1.txt`, `…-round2.txt` |
| **Calls × WireGuard** (`tests/calls/wg_calls.sh`) | a client namespace with a real WireGuard profile issued by the host agent; real WebRTC participants (LiveKit load tester) publish audio + video through the SFU: (1) profile as issued (split tunnel): media flows; (2) SFU address routed through the tunnel: media flows and ~2.8 MB crossed the tunnel interface | **3/3** | `calls-wireguard.txt` |
| **Disaster recovery** (`tests/installer/dr.sh`) | a *second* fresh server installs, then restores the first server's backup with the offline key and `--with-config`: same server identity, accounts present, healthy, installer converges | **10/10** | `installer-disaster-recovery.txt` |

## Defects found by testing (all fixed before the final runs)

| Found by | Defect | Fix |
|---|---|---|
| portal tests | Idle-timeout/suspension logout crashed (message middleware order) | middleware order |
| portal tests | Stripe SDK v16 objects are not dicts | `.to_dict()` after signature verification |
| UI suite | **MFA could never be enabled without SMTP** (allauth requires a verified email) | `MFA_ALLOW_UNVERIFIED_EMAIL = not EMAIL_ENABLED` + tests |
| UI suite | HTML `pattern` attributes invalid under browsers' v-flag regex mode (validation silently skipped) | escaped patterns |
| UI suite | Mobile overflow (app grid, tables, key/value lists); unreadable install terminal on the home page; broken health rows in the console | CSS/template fixes |
| UI review | TLS probe flagged 12 h internal-CA certificates as expiring | TLS_MODE-aware thresholds |
| federation suite | Reachability probe could never detect external reachability (a notary returns only cached keys for "all keys" queries) | query specific key IDs with `minimum_valid_until_ts` |
| deployed E2EE test | Homeserver login rate limit (burst 5, then ~1 per 5.5 min per IP) would lock out teams behind one NAT with SSO-only login | `rc_login` tuned (burst 30, 0.5/s); float emission fixed in the YAML renderer |
| chat deployment | Caddy pinned the old chat directory after the atomic rebuild swap (404 until restart) | mount the parent `www/` directory |
| calls lifecycle test | Re-running `install.sh` failed preflight: Lumen's own LiveKit holds the calls ports and was not recognised as Lumen's | preflight recognises the running `livekit` container of the `lumen` project |
| calls lifecycle review | `CALLS_ENABLED=false` left the SFU running and its firewall rules open | SFU/authorization containers removed; the installer closes its own `lumen: calls` rules |
| calls privacy check | lk-jwt-service's info-level logs contained Matrix user IDs and room IDs | log level `warn`; the security scan checks the logs |
| repository review | `docs/test-results/` was git-ignored (Playwright's `test-results/` rule), so the cited raw outputs were never committed | `.gitignore` exception; files committed after a secret scan |
| installer lifecycle | **coturn could not start at all** (file capability vs `cap_drop: ALL`), and the installer reported success anyway | `cap_add: NET_BIND_SERVICE` only; installer now verifies TURN with a STUN request |
| ADR review | ADR claimed a measured PQ TLS report that did not exist | implemented: probe measures the negotiated group; console shows it per host |
| licence inventory | chat bundle shipped without third-party/font licence texts; module used an internal Synapse import | Vite `build.license` + font licences; public module API import |
| chat-client tests (build agent) | stale backup nudge, profile edit race, timeline not pinned, stuck unread, inaccurate offline banner, verification requests rendered as messages, 25 s sign-out | fixed in the client |

## Not verified

* **Real Ubuntu VM or bare metal.** The installer ran in a systemd container
  on Ubuntu 24.04.5 (shared kernel). Not run on a cloud VM, bare metal, or
  arm64.
* **ACME / Let's Encrypt** certificate issuance, public DNS, and federation with
  the public Matrix network (no public IP or DNS here). All TLS used the internal
  CA.
* **Stripe live/test API**: webhook handling was tested with Stripe's real
  signature scheme and synthetic events; Checkout and the Customer Portal were not
  exercised against Stripe.
* **SMTP delivery**: email code paths are unit-tested with Django's in-memory
  backend; no real mail server was used.
* **Calls across the real internet**: all call tests ran on one machine, between
  network namespaces. No real NAT, carrier-grade NAT, mobile network or
  separate physical hosts were involved; TURN relaying was exercised only
  where the lab forced it (see the calls section).
* **Third-party Matrix clients** (Element etc.) against a Lumen server.
* **Load, soak and failover** behaviour; no performance testing was done.
* **Accessibility audit** (WCAG) and cross-browser testing beyond Chromium.
* **External penetration test**: the security checks above are automated
  self-tests, not an independent assessment.

## Reproducing

```bash
# on a host with a Lumen test install (TLS_MODE=internal), as root
cd services/portal && python -m pytest                       # needs PostgreSQL; see pytest.ini
cd services/chat && npm ci && npm run typecheck && npm run lint && npm test
npm run devserver:up && npm run test:e2ee && npm run test:ui && npm run test:voip
node tests/ui/portal.e2e.mjs
node tests/chat/deployed.e2ee.mjs
python3 tests/integration/sso_flow.py --base lumen.test --ca /etc/lumen/ca/bundle.crt
python3 tests/integration/entitlements.py
bash tests/integration/wireguard_e2e.sh
bash tests/federation/run.sh
bash tests/security/scan.sh
# installer, fresh server each time
LUMEN_TEST_EXTRA_CA=<proxy CA, if any> bash tests/installer/vm.sh lumen-it lumen-it.test
docker cp lumen.conf lumen-it:/root/lumen-it.conf
docker exec lumen-it bash -c 'cd /root/lumen && bash install.sh --config /root/lumen-it.conf --yes'
docker exec lumen-it bash /opt/lumen/tests/installer/lifecycle.sh /root/lumen-it.conf
```

All test traffic comes from one IP, so the portal's per-IP sign-up limit
(10/hour) was reset between runs on the test server — `tests/federation/run.sh`
does this itself; for the other suites:
`sudo ./lumenctl compose exec -T postgres psql -qU postgres -d lumen -c "DELETE FROM lumen_cache WHERE cache_key LIKE ':1:allauth:rl:%'"`.
Production rate limits are unchanged.
