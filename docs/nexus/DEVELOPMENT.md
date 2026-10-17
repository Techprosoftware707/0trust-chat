# Nexus Office AI: run the test environment locally

Everything here runs on one machine, against throwaway containers and synthetic demo data.
Nothing is deployed, nothing talks to a production system, and nothing touches another
checkout's containers or ports.

| Piece | Where | Started by |
|---|---|---|
| PostgreSQL 17 | container `nexus-pg`, `127.0.0.1:55433` | `dev/nexus/setup.sh` (or by hand, below) |
| Databases | `nexus` (pytest makes `test_nexus` from it), `nexus_dev` (the dev servers) | `setup.sh` |
| Matrix homeserver (Synapse) | container `lumen-chatdev-nexus`, `127.0.0.1:28108`, server name `chatdev.test` | `setup.sh` (via `tests/chat/devserver.mjs`) |
| Portal: website, portal, OAuth/OIDC provider, `/api/v1` | `http://127.0.0.1:8710` | `dev/nexus/run-portal.sh` |
| Chat SPA / workspace shell (Vite) | `http://127.0.0.1:5710` | `dev/nexus/run-chat.sh` |

Several independent environments can run side by side: `NEXUS_SLOT=N` (1-9) before any `dev/nexus/*.sh` command, or before `. dev/nexus/env.sh`, gives portal `8710+N`, chat `5710+N` and database `nexus_dev_N`. The homeserver is shared, and only slot 0 resets it (`setup.sh --fresh`). For pytest, pick a database name per environment as well, e.g. `POSTGRES_DB=nexus_b1` (pytest then uses `test_nexus_b1`).

All environment variables live in `dev/nexus/env.sh` (development values only; the OIDC
signing key is generated into the git-ignored `dev/nexus/.state/`). Every command below is
run from the repository root unless it says otherwise.

## 1. One-time prerequisites

```sh
# PostgreSQL for tests and dev servers (setup.sh creates it too if it is missing)
docker run -d --name nexus-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=lumen_app -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=nexus postgres:17-alpine
# after a Docker restart: docker start nexus-pg

# Python 3.13 virtualenv for the portal (requirements.txt is hash-pinned)
python3.13 -m venv /home/user/nexus-venv
/home/user/nexus-venv/bin/pip install --require-hashes -r services/portal/requirements.txt
/home/user/nexus-venv/bin/pip install pytest pytest-django hypothesis ruff

# Node dependencies of the chat SPA (also provides Playwright for the browser tests)
(cd services/chat && npm ci --ignore-scripts)
```

Playwright needs a Chromium build; in this container it is preinstalled under
`/opt/pw-browsers`. Elsewhere: `(cd services/chat && npx playwright install chromium)`.
A different venv path works too: `export NEXUS_VENV=/path/to/venv` before sourcing `env.sh`.

## 2. Set up the environment

```sh
bash dev/nexus/setup.sh          # idempotent: database, migrations, OAuth clients, demo data, homeserver, Matrix accounts
bash dev/nexus/setup.sh --fresh  # start over: drops nexus_dev and resets this environment's homeserver first
```

What it does, in order: starts `nexus-pg`, creates `nexus_dev`, runs `migrate`,
`lumen_bootstrap` (plans and entitlements from `config/plans.yml`, the Synapse OIDC client and
the public `nexus-web` OAuth client), `nexus_demo_seed --reset-passwords`, starts the
homeserver container and registers the demo people on it with the same usernames.

## 3. Run the dev servers

Two terminals (or background them):

```sh
bash dev/nexus/run-portal.sh     # http://127.0.0.1:8710  (Django runserver, --noreload)
bash dev/nexus/run-chat.sh       # http://127.0.0.1:5710  (Vite, config from dev/nexus/chat-config.json)
```

Then open `http://127.0.0.1:8710/accounts/login/`, sign in as a demo person, and use
**Open workspace** (or go to `http://127.0.0.1:5710/` directly and sign in with the same
username and password on the chat screen). After the Matrix sign-in the SPA obtains its API
token from the portal with a silent OAuth code + PKCE round trip (`prompt=none`); if the
portal session is missing, the workspace pages show a **Connect** button instead.

Both surfaces show the amber banner "Test environment · synthetic demo data", prefix page
titles with `[Test] `, and every portal response carries `X-Nexus-Environment: test`.

### Demo accounts

Password: `nexus-demo-pass-2026` (or whatever `NEXUS_DEMO_PASSWORD` was when `setup.sh` ran).
Workspace: **Harborview Realty & Lending (demo)** (slug `nexus-demo`), profiles general, real
estate and lending, all rows flagged `is_demo`.

| Username | Name | Role | Sees |
|---|---|---|---|
| `demo-avery` | Avery Example | Owner | everything, including workspace settings |
| `demo-morgan` | Morgan Sample | Manager | all records, pipeline and stage configuration |
| `demo-riley` | Riley Placeholder | Agent / Broker | own, assigned and team-shared records; creates records |
| `demo-jordan` | Jordan Fictional | Agent / Broker | same as Riley |
| `demo-casey` | Casey Testcase | Team member | team-shared records; own tasks and events |
| `demo-sam` | Sam Mockwell | Read-only | team-shared records, no changes |

All people, companies, emails (`example.com/.org/.net`) and phone numbers (`555-01xx`) are
fictional.

### Demo data commands

```sh
. dev/nexus/env.sh && cd services/portal
"$NEXUS_VENV/bin/python" manage.py nexus_demo_seed                 # fills in anything missing; prints a generated password once if none is set
"$NEXUS_VENV/bin/python" manage.py nexus_demo_seed --reset-passwords   # also resets the demo people's passwords to NEXUS_DEMO_PASSWORD
"$NEXUS_VENV/bin/python" manage.py nexus_demo_reset                # deletes is_demo rows of demo workspaces only (keeps accounts)
```

Both refuse to run unless `NEXUS_ENVIRONMENT` is `development` or `test`. Reset deletes only
rows flagged `is_demo` inside workspaces whose settings are flagged demo, and keeps any demo
row a real row depends on (it says what it kept).

### Integrations in mock mode (team B2)

`env.sh` sets `NEXUS_INTEGRATIONS_MOCK=1` and a throwaway `NEXUS_INTEGRATIONS_KEY`, so
**Integrations** connects Gmail, Slack and HighLevel to local fake providers through a mock
consent page. The OAuth state, PKCE and session binding run for real. Everything they create
is labelled "Mock provider (development)": fictional `example.com` senders and "(mock data)"
subjects. Nothing reaches Google, Slack or HighLevel. **Sync now** on a connection runs a sync
immediately; the worker (`manage.py lumen_worker`) runs `integrations.sync` and
`integrations.retention` on their schedule. For the unconfigured state an administrator sees,
start the portal with `NEXUS_INTEGRATIONS_MOCK=0`. Real credentials go in the variables in
[CONFIG.md](CONFIG.md#integrations-and-the-unified-inbox-team-b2). Provider webhooks can't
reach `127.0.0.1`; the webhook handlers are covered by pytest.

## 4. Tests

### Portal (pytest, PostgreSQL)

```sh
cd services/portal
POSTGRES_PORT=55433 POSTGRES_DB=nexus /home/user/nexus-venv/bin/python -m pytest
# only the Nexus suites:
POSTGRES_PORT=55433 POSTGRES_DB=nexus /home/user/nexus-venv/bin/python -m pytest tests/test_nexus_*.py
```

`lumen/test_settings.py` reads `POSTGRES_*`; pytest-django creates `test_nexus` and runs every
migration from an empty schema (so the migrations themselves are tested on each run).
`tests/test_nexus_migrations.py` additionally migrates from the base schema to the Nexus
heads with existing rows in place. Do not source `env.sh` for pytest (its `POSTGRES_DB` is the
dev database); the explicit variables above are enough.

Lint. The repository has no ruff configuration (CI does not run ruff), so the Nexus code is
checked with pycodestyle, pyflakes and isort rules, run from `services/portal` so that `apps`
and `lumen` count as first-party:

```sh
cd services/portal
/home/user/nexus-venv/bin/ruff check --isolated --line-length 160 --select E,F,W,I \
  apps/api apps/crm apps/integrations apps/assistant apps/mcp apps/automation apps/core/extensions.py \
  tests/nexus_helpers.py tests/test_nexus_*.py ../../tests/nexus/brand_contrast.py
```

### Chat SPA (vitest, eslint, tsc, build)

```sh
cd services/chat
npm test            # vitest (jsdom), includes test/unit/workspace.test.tsx
npm run lint        # eslint
npm run typecheck   # tsc for app and node configs
npm run build       # tsc + vite build
```

### Browser smoke of the workspace shell (Playwright)

Needs the environment set up and both dev servers running (sections 2 and 3):

```sh
. dev/nexus/env.sh && node tests/nexus/shell.smoke.mjs            # resets + reseeds demo data, then 16 checks, screenshots
. dev/nexus/env.sh && node tests/nexus/shell.smoke.mjs --no-shots # same without screenshots
. dev/nexus/env.sh && node tests/nexus/shell.smoke.mjs --keep-data
```

Screenshots (light/dark, 1440px desktop and 390px phone) land in
`docs/nexus/screenshots/foundation/`. The smoke fails on console errors, horizontal overflow
or a missing environment banner.

### AI assistant and Claude connector (team B3)

Run the portal with the connector on (`NEXUS_MCP_ENABLED=1 bash dev/nexus/run-portal.sh`) and
let the demo workspace allow it (Settings → AI and connectors → "Members may connect Claude",
as Avery). Then:

```sh
. dev/nexus/env.sh && NEXUS_PORTAL_URL=http://127.0.0.1:$NEXUS_PORTAL_PORT NEXUS_APP_URL=http://127.0.0.1:$NEXUS_CHAT_PORT \
  node tests/nexus/assistant.smoke.mjs        # 8 checks, screenshots in docs/nexus/screenshots/b3/
# Protocol conformance with the official MCP SDK (dev-only, in a throwaway venv; skips with exit 77 without it):
python3 -m venv /tmp/mcp-sdk && /tmp/mcp-sdk/bin/pip install mcp==2.3.0
. dev/nexus/env.sh && /tmp/mcp-sdk/bin/python -I tests/nexus/mcp_sdk_conformance.py --server http://127.0.0.1:$NEXUS_PORTAL_PORT
```

The in-app assistant uses the development provider here (no model, labelled). For the
Anthropic API set `AI_PROVIDER=anthropic`, `AI_MODEL=<a current Claude model ID>` and
`AI_API_KEY` (allowed as a plain variable only in local development) before starting the portal.
See [CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md).

### Verticals, automation, calendar, meetings and reports (team B1)

Portal suites. They need only the test database and no external service. The Home test
calls B2's real health hook (network calls are blocked) and then fake and failing providers:

```sh
cd services/portal
POSTGRES_PORT=55433 POSTGRES_DB=nexus /home/user/nexus-venv/bin/python -m pytest \
  tests/test_nexus_verticals.py tests/test_nexus_documents.py tests/test_nexus_automation.py \
  tests/test_nexus_meetings_reports.py tests/test_nexus_isolation.py tests/test_nexus_migrations.py
```

The document tests use a temporary storage directory and a random key per test, and check
that no plaintext reaches the disk or the logs. The browser smoke needs the dev servers of the
slot running (sections 2 and 3). `env.sh` sets up secure document storage for the slot:

```sh
NEXUS_SLOT=1 . dev/nexus/env.sh && node tests/nexus/verticals.smoke.mjs             # 13 journeys, screenshots in docs/nexus/screenshots/b1/
NEXUS_SLOT=1 . dev/nexus/env.sh && node tests/nexus/verticals.smoke.mjs --no-shots
```

Without `--keep-data` it deletes and reseeds the demo workspace first. The journeys create
rows: a viewing, an encrypted upload, notes and tasks. The automation scans (overdue tasks,
appointment reminders) run on the worker's schedule; to run them once by hand:

```sh
. dev/nexus/env.sh && cd services/portal && "$NEXUS_VENV/bin/python" manage.py nexus_automation_scan
```

SPA unit tests of the verticals logic are in `services/chat/test/unit/verticals.test.tsx`.
They run as part of `npm test`.

### Integrations and the unified inbox (team B2)

All of these are mock-based (fake providers, no live service):

```sh
cd services/portal
POSTGRES_PORT=55433 POSTGRES_DB=nexus /home/user/nexus-venv/bin/python -m pytest tests/test_nexus_integrations_*.py
cd ../chat && npx vitest run test/unit/inbox-merge.test.ts
# browser smoke (portal and chat dev servers of the slot running, mock mode on): 11 checks, screenshots
. dev/nexus/env.sh && node tests/nexus/integrations.smoke.mjs            # docs/nexus/screenshots/b2/
. dev/nexus/env.sh && node tests/nexus/integrations.smoke.mjs --no-shots
```

The smoke removes the slot's mock connections first, then connects all three providers,
syncs, and walks the inbox, an email reply sent through the confirmation dialog, a Slack
reply, record linking, an agent's view, dark mode and phone width.

### End-to-end journey (final integration)

The brief's key flow in one browser run, on synthetic data, mock-based (fake providers, the
development AI provider). Needs the slot's portal and chat dev servers in mock mode (`env.sh`
default); it deletes and reseeds the slot's demo workspace first unless `--keep-data`:

```sh
. dev/nexus/env.sh && node tests/nexus/journey.smoke.mjs            # 11 checks, screenshots in docs/nexus/screenshots/final/
. dev/nexus/env.sh && node tests/nexus/journey.smoke.mjs --no-shots
```

A manager routes new leads to an agent (the seeded automation); the owner connects HighLevel
(mock) and adds the lead "Pat Mockperson" from the inbox; the automation assigns it and creates
a follow-up task; the agent links an encrypted conversation, schedules a meeting with a meeting
room, writes notes and confirms a next step into a task, asks the assistant "What follow-ups are
overdue?", connects Gmail (mock), links an email and confirms an AI-prepared reply as a Gmail
**draft** (checked: nothing sent). Pat's timeline then shows all of it, and Home shows the next
action with its due date. Its server-side counterpart is
`services/portal/tests/test_nexus_final_integration.py`.

### Brand contrast (WCAG 2.2 AA)

```sh
python3 tests/nexus/brand_contrast.py             # exit 1 if any pair fails
python3 tests/nexus/brand_contrast.py --markdown  # the table in ARCHITECTURE.md
```

### Existing chat suites against this environment's homeserver

```sh
cd services/chat && . ../../dev/nexus/env.sh
npm run test:e2ee   # E2EE on the wire (needs the homeserver: setup.sh or npm run devserver:up)
npm run test:ui     # production build + full chat UI suite
```

`env.sh` sets `CHATDEV_CONTAINER=lumen-chatdev-nexus` and `CHATDEV_PORT=28108`, so these use
this environment's homeserver, never another checkout's. `test:ui` rewrites the tracked
screenshots in `tests/chat/screenshots/`; restore them with
`git checkout -- tests/chat/screenshots` unless you mean to update them. It registers its own
users; run `bash dev/nexus/setup.sh` again afterwards if the demo Matrix accounts are gone.

### Installer render tests

```sh
python3 -m unittest discover -s tests/deploy -v
```

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` on 55433 | `docker start nexus-pg` (re-create with the command in section 1 if it is gone) |
| Chat sign-in fails, `M_FORBIDDEN` | homeserver was reset: `bash dev/nexus/setup.sh` re-registers the demo people |
| Workspace pages say "Connect your workspace" | press **Connect workspace** (signs in to the portal at 8710 if needed, then returns) |
| Pipelines missing stages after many resets | `bash dev/nexus/setup.sh --fresh` |
| Port 8710 or 5710 in use | a previous dev server is still running; stop it (`pkill -f "runserver 127.0.0.1:8710"`, `pkill -f "vite --port 5710"`) |
| `invalid_client` / redirect mismatch on the OAuth round trip | `lumen_bootstrap` registers `nexus-web` with exactly `LUMEN_APP_BASE_URL/oauth/callback`; open the SPA at `http://127.0.0.1:5710`, not `localhost` |
| vitest misses an area file that exists (e.g. after a pull) | vitest 5's file cache kept an old `import.meta.glob` expansion: `find services/chat/node_modules/.vitest-cache -maxdepth 1 -type f -delete` (only removes this checkout's links) |
| Integrations page says "Not set up on this server yet" | no `NEXUS_INTEGRATIONS_KEY` (every provider), or mock mode is off and the provider has no client ID and secret (Gmail, Slack; HighLevel still offers a private integration token): source `dev/nexus/env.sh` or set the variables in CONFIG.md |

## Not part of this environment

The other checkout's Docker dev stack (`restore-env.sh`, its `55432` database and 8000-range
ports), `lumenctl apply`, and every remote server. `design/tokens.css` is shared Lumen source:
brand changes go in `branding/theme.css`.
