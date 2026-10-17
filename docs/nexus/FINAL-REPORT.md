# Nexus Office AI: final report

Nexus Office AI is a temporary test brand. On the branch `test/unified-business-workspace` it
turns Lumen Secure (end-to-end encrypted Matrix chat and calls) into an AI-assisted business
workspace. It adds contacts, deals, tasks and a timeline, real-estate and lending workflows,
automation, a calendar with meetings, reports, Gmail, HighLevel and Slack with a unified inbox,
an in-app AI assistant and a Claude (MCP) connector. This report is what you review: where the work
started, what is done, what isn't, what was tested and how, and what you still have to decide or
provide.

Everything below was observed on 2026-10-17. Commands and full outputs are in
[`evidence/final/`](evidence/final/). Screenshots of the end-to-end journey are in
[`screenshots/final/`](screenshots/final/).

## 1. Where it started, where it is

| | Commit | Notes |
|---|---|---|
| `main` | `856a1aa` "Initial commit" | README only. **Unchanged** (below) |
| Base | `eefa6ab` on `claude/dreamy-sagan-mheysz` | The tip of the Lumen branch when Nexus started |
| Lumen merged in | `711fcd8` (current tip of `claude/dreamy-sagan-mheysz`) | Merges `75c3570` (GUI polish, WireGuard by default) and `d88749b` (regression results); real merges, no rebase |
| Final branch | `test/unified-business-workspace` | Pushed to `origin`. The fixes below are in `4c6ec21`, then `ec0e5b0` (the journey's screenshot of the draft only). This report and the final evidence are in the documentation commit right after them (`git log -3 origin/test/unified-business-workspace`) |

**Why `eefa6ab` and not `main`:** `main` holds only the initial README. The whole product (portal,
chat app, calls, installer, mobile and desktop apps, tests) lives on `claude/dreamy-sagan-mheysz`.
Branching from `main` would have thrown away the encrypted chat that the product keeps at its
centre.

`main` was never written to:

```
$ git fetch origin && git rev-parse origin/main && git log --oneline -1 origin/main && git ls-remote origin refs/heads/main
856a1aa88dfa44f59e647168a54a9341cb045811
856a1aa Initial commit
856a1aa88dfa44f59e647168a54a9341cb045811	refs/heads/main
```

## 2. The end-to-end encryption boundary, in plain words

Chat messages and calls are locked on the sender's device and unlocked only on the recipients'
devices. The Nexus server never has the keys. So the server, the reports, the automations, the
in-app AI assistant and the Claude connector **cannot read your chats or listen to your calls**,
and nothing in Nexus changes that.

What the server does know about a conversation: that a person linked a room to a contact or a
deal, through the room's identifier (a code like `!abc:server`), never its words. The unified inbox
shows chat previews, but they are unlocked in your browser and never sent to the server. A
person can choose to copy a few chat messages into a contact's notes with **Save to record**. That
copy is no longer end-to-end encrypted, and the app says so when you do it. The feature is off
until a workspace owner or admin turns it on. Email, Slack and HighLevel content is not end-to-end
encrypted: it comes from those services. Nexus labels it as external and never treats it as
instructions for the AI.

## 3. Status by area

"Mock-based" means tested against local fake providers that imitate the real ones. Nothing in
this branch has talked to the real Google, Slack, HighLevel or Anthropic services, or to Claude
itself (section 5).

### Branding and test environment
* **Done:** the "Nexus Office AI" test brand through Lumen's brand hooks (`branding/`, `BRAND_*`;
  reverting it is a configuration change). `NEXUS_ENVIRONMENT=test|development` shows a permanent
  "Test environment · synthetic demo data" banner, `[Test]` page titles and `[Nexus · Test]` email
  subjects, and sends `X-Nexus-Environment` on every response. The 81 colour pairs pass WCAG 2.2 AA
  in light and dark. The local environment runs with slots (`dev/nexus/`), synthetic demo data
  (`nexus_demo_seed` / `nexus_demo_reset`, refused in production) and a dev homeserver. Installs of
  this branch render `NEXUS_ENVIRONMENT=test` by default.
* **Partial:** the Android and iOS apps and the desktop app's placeholders still say Lumen. They
  are outside the brand hooks.
* **Next:** decide the real product name before anything leaves the test environment.

### Tenancy and roles
* **Done:** a workspace is the organisation. There are six roles: owner, admin, manager,
  agent/broker, team member and read-only. Existing owner, admin and member rows keep their values
  (member reads as "Team member"). All authorisation goes through `apps/crm/access.py`. Another
  workspace's records give 404, and so do invisible or malformed IDs. The isolation tests cover
  every model and endpoint. The upgrade from the base Lumen schema was checked on a real database
  (section 6).
* **Next:** optimistic concurrency (today the last write wins). Members can see the member list,
  which the assignment pickers need.

### CRM core
* **Done:** contacts (kinds, roles, owner, assignees, private or team visibility, follow-up date,
  tags, validated custom fields, sensitive fields), pipelines and stages, deals with a kanban and
  stage history, tasks, a timeline with untrusted external entries, a calendar API, conversation
  links (room IDs only), external record mappings, a JSON API with bearer tokens, PKCE, scopes, rate
  limits and audit, and the workspace shell with Home, Contacts, CRM, Pipelines and Tasks.
* **Fixed in the final integration:** meetings and their notes now show on the contact's or
  deal's timeline. Each lead on Home shows its next action and when it is due.
* **Next:** bulk actions, and a same-origin `/api` proxy (the SPA calls the portal across origins
  with CORS today).

### Real estate
* **Done:** properties (manual entry; a `source` field records where each came from, and nothing
  is invented: there is no MLS feed), people and deals per property, buyer preferences with
  matching against your own listings, viewings as calendar events, milestones and deadlines with
  templates (purchase, listing, lending), and urgency on Home and in reports.
* **Next:** a real listing import, if wanted (none exists, on purpose).

### Lending and secure documents
* **Done:** applications in their own seven-stage pipeline, borrowers, a loan officer, document
  checklists from per-product templates, staff, manager and private notes, and "request document"
  (it creates a task; nothing is sent to the borrower). Decisions are recorded only by staff with
  `lending.decide` and an explicit confirmation: no automated decisions. Secure documents use a fresh
  AES-256-GCM key per file, wrapped by a master key from a secret file. Downloads use single-use
  60-second tokens sent in a POST body, and every upload, download and refusal is in an access
  log. Agents see only the applications assigned to them.
* **Blocker (your decision):** on an installed server, document storage answers `503
  not_configured` until the installer wiring exists or an operator sets it up by hand (section 8).
* **Next:** virus scanning (none in this build), a re-encryption command for key rotation, a
  checklist template editor in the app (API only today), and contacting borrowers.

### Automation
* **Done:** six triggers, conditions, and four internal actions (assign an owner, create a task,
  notify in the app, update related tasks). Rules run as the person who last saved them, through
  the same access rules. There is loop protection, per-rule and per-workspace limits, retries with
  backoff, and a run history with manual retry. The four example rules are seeded in the demo
  workspace only. Notifications are in-app, with preferences.
* **Partial:** no email or push notifications. Automations can't take external actions;
  customer-facing actions always need a person's confirmation.
* **Next:** notification channels outside the app, if wanted.

### Calendar, calls and meetings
* **Done:** agenda, day and week views, internal invitations, and an end-to-end encrypted meeting
  room per event (created in the browser; only its ID is stored) with its MatrixRTC call. Notes
  are typed by people; "suggested next steps" become tasks only when a person confirms them.
  Recent calls are read on the device and never sent to the server. **Fixed:** meetings and their
  notes now reach the timeline, and private ones never do.
* **Partial:** invitations are internal only; external invitations wait for Gmail sending.
  There is no recording or transcription, on purpose, and the UI says so.

### Reports and Home
* **Done:** pipeline, team week, activity, tasks, lending checklist and deadline reports for
  owners, admins and managers, built only from records the viewer may see. Home shows today's
  tasks, overdue follow-ups, assigned leads with their **next action and due date** (fixed),
  today's meetings, approaching deadlines, applications missing documents, next steps to review
  and connected services.
* **Next:** reports are computed per request (fine at test sizes). There are no exports or
  snapshots.

### Gmail, GoHighLevel, Slack and the unified inbox
* **Done (mock-based):** OAuth with signed single-use state bound to the browser session, PKCE
  for Google, encrypted tokens with rotation and refresh, least-privilege scopes and webhooks
  (Slack HMAC, HighLevel Ed25519) with replay protection and dedup. Gmail syncs incrementally;
  bodies are sanitized and fetched on demand, never stored; replies go through drafts. Slack
  syncs selected channels and posts after confirmation. HighLevel gives conversations, missed
  calls, opportunities, pipelines and contact create/update after confirmation; workflow starts
  only in production with an admin opt-in. The unified inbox merges encrypted chats (in the
  browser) with synced items, with source badges, per-person unread, assignment, labels, mutes,
  record links and suggestions. Every external write needs a single-use confirmation token. Mock
  mode is labelled everywhere and refused in production.
* **Fixed:** a HighLevel lead can now be added to Nexus from the inbox ("Add <name> to Nexus"),
  which runs the lead automations and notes the import on the timeline.
* **Not tested live:** no Google, Slack or HighLevel credentials were available (section 5).
* **Partial:** there are no Gmail push notifications (it polls), no replies to HighLevel
  conversations (it links out), Slack private channels only with an admin opt-in, and no
  Enterprise Grid.
* **Next:** live tests with real apps (INTEGRATIONS.md section 2). Google needs app
  verification and a security assessment for the restricted Gmail scopes before customers use it.

### AI assistant
* **Done:** one tool registry for the in-app assistant and the connector. Tools run as the person,
  in their workspace, through `access`. Changes are two-phase: a dry run, a stored proposal and a
  person's Confirm. External content is fenced as untrusted, and email drafts are created only
  after confirmation and never sent. Lending amounts and sensitive fields stay out unless the
  workspace opts in, and documents never reach the AI. Every question is audited, and content is
  kept only if the workspace chooses to. The development provider (no model, clearly labelled)
  answers the brief's questions with verified facts and sources. The Anthropic provider (Messages
  API over raw HTTPS) is tested with a mock HTTP session.
* **Not tested live:** no Anthropic API key was available.
* **Next:** set `AI_PROVIDER=anthropic`, `AI_MODEL` and the `ai_api_key` secret on a test server
  and try it with real questions.

### Claude MCP connector
* **Done:** `https://<domain>/mcp` (Streamable HTTP, protocol 2026-07-28 and 2025-11-25,
  2025-06-18 and 2025-03-26 through `initialize`) with discovery (RFC 9728, RFC 8414), Dynamic
  Client Registration and Client ID Metadata Documents (SSRF-safe), PKCE S256, `resource` (RFC
  8707), `iss` (RFC 9207), and refresh rotation with reuse detection. A connection is bound at
  consent to one person and one workspace, and Claude's own permission prompt guards
  `confirm_action`. The official MCP SDK (2.3.0 and 1.30.0) passed its conformance checks against
  the local portal. On the installed test server the metadata and the 401 challenge are correct.
* **Not tested:** a real Claude connection. Claude reaches connectors from Anthropic's egress range
  160.79.104.0/21 over public HTTPS with a valid certificate, which this sandbox can't offer.
* **Next:** deploy a test server with a public certificate, connect claude.ai and Claude Code, and
  record the result (CLAUDE-CONNECTOR.md section 4).

### Security
* **Done:** server-side authorisation for every read and write with tenant isolation (404, never
  403, for other workspaces' IDs; a uniform 400 for unknown IDs in a body). There are isolation
  tests for every model and endpoint. Every write is audited (field names only) in Lumen's
  hash-chained audit log, and sensitive reads are audited. Secrets are Docker secret files; no
  credentials are in code (the CI secret grep is clean); no TLS verification is disabled (the CI
  grep is clean). Integration tokens are AES-256-GCM encrypted, never logged and never returned.
  There are rate limits on the API, AI, MCP and webhooks. External content is untrusted data, and
  consequential external actions happen only after a person's confirmation. The production npm
  dependency audit found nothing.
* **Partial:** no virus scanning of lending documents. Contact-read audit writes one event per view
  (to be sampled at scale). Document storage needs installer wiring (section 8).
* **Next:** an external security review before real customer data. The Google security assessment
  for Gmail's restricted scopes.

### Tests
* **Done:** the portal suite (pytest, PostgreSQL, every migration from an empty database each
  run), the chat unit tests (vitest), lint, typecheck and builds, the deploy renderer tests, the
  CI shared checks, the brand contrast check, five browser smokes including the new end-to-end
  journey, the chat E2EE and UI suites against the Nexus homeserver, MCP SDK conformance, an
  upgrade from the base Lumen schema on a real database, and a fresh install in a systemd test
  server (section 5).
* **Not run here:** GitHub CI (it costs money; `main` runs it at the end), and the mobile and
  desktop app suites (unchanged by Nexus).

## 4. Integration defects found and fixed in this pass

The brief's key flow, run as one browser journey, showed three gaps between teams. Each was fixed
minimally, with tests, in `4c6ec21`:

| Defect | Fix | Tests |
|---|---|---|
| A meeting scheduled with a contact, and its notes, never appeared on the contact's timeline (the calendar wrote no timeline entries) | Team-visible events and notes keep one system entry on their contact or deal, in step with the event or note, attributed to its author. Private and attendee-only ones never get one; an entry goes when its event or note turns private or is deleted. The SPA links entries to the meeting | `test_nexus_final_integration.py` (5 tests), `workspace.test.tsx` |
| A HighLevel lead couldn't be brought into Nexus from the app: the import API had no screen | "Add <name> to Nexus" on a HighLevel conversation or missed call: import, then link. The import notes itself on the timeline (untrusted, no human actor) and flags mock-provider contacts as demo data | `test_nexus_final_integration.py` (mock and non-mock), `inbox-merge.test.ts`, the journey |
| Home said "No follow-up set" for a lead whose automation had just created its follow-up task | Each assigned lead carries its earliest open task the viewer may see, shown as "Next: … · due …" | `test_nexus_final_integration.py`, `workspace.test.tsx`, the journey |

One existing assertion changed with the behaviour: in `test_nexus_crm.py`, the contact summary's
latest timeline entry is now the meeting scheduled after the email.

## 5. What was run, and what it showed

All of these ran on this machine against the fix commit `4c6ec21`, from a fresh state: a new test
database, `setup.sh --fresh` (database and dev homeserver), and a new installer test server.
The journey's recorded run and screenshots are from `ec0e5b0`, which changes only how one of its
screenshots is taken. A first pass on the untouched branch (`d88749b`) had already passed every
check that existed then, everything here except the new journey and tests. Its evidence is in
commits `dda1a5d` and `df7019c`. There, the first run of the installed-server checks failed one
check because of a bug in the check script itself (a pipe closed early); the fixed script passed
16/16 on the same server. The journey, written next, is what found the three defects.
**Mock** = fake providers or a mock HTTP session; **live (local)** = the real component running
locally.

Two more checks, run by the coordinator on the final commit `abfc095`:
- An independent full run of the portal suite on yet another new test database
  (`POSTGRES_DB=nexus_verify`): **819 passed** in 7 minutes.
- GitHub Actions `ci` run [39033399383](https://github.com/Techprosoftware707/0trust-chat/actions/runs/39033399383),
  covering portal tests on PostgreSQL, the web client (typecheck, lint, unit tests, build, call widget,
  dependency audit) and the shared checks (tokens, deploy unit tests, shellcheck, TLS-bypass and secret
  greps): **success**. The Android, iOS and desktop workflows were not run on this branch, because Nexus
  doesn't change those apps; they passed on the Lumen branch (docs/test-report.md).

| # | Command (from the repository root unless noted) | Kind | Observed result | Evidence |
|---|---|---|---|---|
| 1 | `cd services/portal && POSTGRES_PORT=55433 POSTGRES_DB=nexus_final python -m pytest --create-db` (new test database: every migration from empty, Lumen's and the eight Nexus ones) | live (local PostgreSQL); integrations and Anthropic mocked | **819 passed**, 0 failed (811 before the fixes) | `portal-pytest-full.txt` |
| 2 | `ruff check --isolated --line-length 160 --select E,F,W,I` over the Nexus apps and tests | lint | All checks passed | `portal-ruff.txt` |
| 3 | `cd services/chat && npm test` (after clearing `node_modules/.vitest-cache`) | unit (jsdom) | **173 passed** in 13 files (169 before the fixes) | `chat-vitest.txt` |
| 4 | `npm run lint` | lint | clean | `chat-lint.txt` |
| 5 | `npm run typecheck` | typecheck | clean | `chat-typecheck.txt` |
| 6 | `npm run build`, `npm run build:widget` | build | both built | `chat-build.txt`, `chat-build-widget.txt` |
| 7 | `npm audit --omit=dev --audit-level=high` (CI step) | live (npm registry) | found 0 vulnerabilities | `chat-npm-audit.txt` |
| 8 | `python3 -m unittest discover -s tests/deploy -v` | unit | **61 tests OK** | `deploy-unittests.txt` |
| 9 | `python3 design/tools/gen_tokens.py --check` (CI step) | check | up to date | `design-tokens-check.txt` |
| 10 | CI `shellcheck -x -S warning` over every tracked shell script | lint | clean (45 `.sh` files and the top-level scripts) | `ci-shellcheck.txt` |
| 11 | CI TLS-bypass `git grep -nP` over `apps` and `services/chat` | check | nothing found | `ci-tls-bypass-grep.txt` |
| 12 | CI secret grep (private keys, live tokens, credential files) | check | nothing found | `ci-secret-grep.txt` |
| 13 | `python3 tests/nexus/brand_contrast.py` | check | **81 pairs, 0 failing** (WCAG 2.2 AA) | `brand-contrast.txt` |
| 14 | Upgrade from the base Lumen schema: `eefa6ab`'s migrate and code, then this branch's `migrate` and `lumen_bootstrap` | live (local PostgreSQL) | rows identical, roles mapped, plan value kept | `migrations-from-base-lumen.txt` |
| 15 | `bash dev/nexus/setup.sh --fresh` (slot 0: new `nexus_dev`, homeserver reset) | live (local) | ready; every migration applied from empty; six demo Matrix accounts registered | `dev-setup-fresh.txt` |
| 16 | `node tests/nexus/shell.smoke.mjs --no-shots` | browser, live (local servers) | **16/16** | `smoke-shell.txt` |
| 17 | `node tests/nexus/verticals.smoke.mjs --no-shots` | browser, live (local) | **13/13** | `smoke-verticals.txt` |
| 18 | `node tests/nexus/integrations.smoke.mjs --no-shots` (`NEXUS_INTEGRATIONS_MOCK=1`) | browser, **mock providers** | **11/11** | `smoke-integrations-mock.txt` |
| 19 | `node tests/nexus/assistant.smoke.mjs --no-shots` (portal with `NEXUS_MCP_ENABLED=1`, the demo workspace allowing the connector) | browser, **development AI provider** | **8/8** | `smoke-assistant.txt` |
| 20 | `tests/nexus/mcp_sdk_conformance.py` with the official `mcp` **2.3.0** (throwaway venv, deleted afterwards) | live (local portal), real SDK client | **28/28** (protocol 2026-07-28 and 2025-11-25) | `mcp-sdk-2.3.0-conformance.log`, `.json`, `.freeze.txt` |
| 21 | the same with `mcp` **1.30.0** | live (local portal), real SDK client | **15/15** (2025-11-25, localhost redirect) | `mcp-sdk-1.30.0-conformance.log`, `.json`, `.freeze.txt` |
| 22 | `node tests/nexus/journey.smoke.mjs` (new: the brief's key flow) | browser, **mock providers + development AI provider** | **11/11**, 9 screenshots | `smoke-journey.txt`, [`screenshots/final/`](screenshots/final/) |
| 23 | `cd services/chat && npm run test:e2ee` (against `lumen-chatdev-nexus`) | live (local homeserver) | **5/5**: ciphertext only on the server | `chat-test-e2ee.txt` |
| 24 | `npm run test:ui` (production build + full chat UI suite; tracked screenshots restored afterwards) | browser, live (local homeserver) | **23/23** | `chat-test-ui.txt` |
| 25 | Installer: `tests/installer/vm.sh` (fresh Ubuntu 24.04 systemd test server), `install.sh` with `lumen-it-current.conf` + `NEXUS_ENVIRONMENT=test` + `NEXUS_MCP_ENABLED=true`; then the Nexus checks; then the server and its volumes removed | live (real install, internal test CA) | **Result: SUCCESS — all endpoint checks passed**; portal image and chat app built; migrations applied; Nexus checks **16/16** (below) | `installer-run.txt`, `installer-install.txt`, `installer-nexus-checks.txt` |

The Nexus checks on the installed server (TLS verified against the installer's test CA, never
skipped): `/api/v1/me` answers 401 with `WWW-Authenticate: Bearer` and 200 with a token; the
protected-resource metadata names `https://lumen-it.test/mcp` and the authorization server with
the MCP scopes; the authorization-server metadata offers S256 only, DCR, public clients, the MCP
scopes and `iss`; `/mcp` answers 401 with `WWW-Authenticate: Bearer
resource_metadata="https://lumen-it.test/.well-known/oauth-protected-resource/mcp"` and refuses the
SPA's token; Gmail and Slack show "Not set up on this server", HighLevel "Not connected" (it can
take a private integration token once the installer's key exists) and mock mode is off; a lending
document upload answers `503 not_configured`, as expected without the deploy-wiring patch. The
installer's own warnings were the expected ones for a test server: free disk below 40 GB, no NTP,
the internal test CA, and push enabled without a credential.

The scripts that ran these are in [`evidence/final/scripts/`](evidence/final/scripts/)
(`final-pass.sh` runs them all in order).

**Not tested live, and why:**
* Google (Gmail), Slack and HighLevel: no credentials. Every test uses the fake providers,
  which answer the documented URLs and shapes (INTEGRATIONS.md section 11 lists the documentation
  checked).
* A real Claude connection: Claude connects from 160.79.104.0/21 over public HTTPS, and this
  sandbox has no public server with a valid certificate. The official MCP SDK conformance ran
  against the local portal instead.
* The Anthropic Messages API: no API key. The provider is tested with a mock HTTP session, and
  the journey uses the development provider.
* Webhook deliveries from Slack and HighLevel (they can't reach 127.0.0.1). The handlers are
  covered by pytest with signed fake requests.

## 6. Upgrading an existing Lumen installation

[`evidence/final/migrations-from-base-lumen.txt`](evidence/final/migrations-from-base-lumen.txt)
shows the following. A fresh database was migrated by `eefa6ab`'s own code (taken with `git archive`,
with no worktree or branch touched). That code then wrote four users, two workspaces, five
memberships (owner, admin, member), three invitations (one revoked) and an operator-edited plan
value. After this branch's `migrate` (eight new migrations) and `lumen_bootstrap`:

* every user, workspace, membership and invitation row was identical in every compared column (IDs, names, slugs, flags, emails, roles, invitation token hashes and revocations);
* `owner`, `admin` and `member` read as Owner, Admin and Team member, with the expected capabilities (Team member: team view, no configuration, no settings);
* the operator's plan value survived, and the new entitlement keys were added;
* no workspace became a business workspace on its own (that needs an owner's opt-in).

`tests/test_nexus_migrations.py` checks the same in the test suite.

## 7. Files and migrations

**Migrations added** (none of Lumen's migrations were changed):

| Migration | What it does |
|---|---|
| `workspaces.0002_nexus_roles` | Widens the role choices (manager, agent, read-only). Choice-only; no SQL; existing rows unchanged |
| `crm.0001_initial` | Business settings, contacts, tags, custom fields, pipelines and stages, deals, stage history, tasks, timeline, calendar events, conversation links, external mappings, record links |
| `crm.0002_verticals_meetings_event_kind` | Properties, preferences, milestones, lending applications, checklists, secure documents and access log, meeting notes, action items, `CalendarEvent.kind` |
| `crm.0003_pipeline_stage_restrict` | Pipeline and stage of deals and lending applications `RESTRICT` (deals were `PROTECT`), so deleting a workspace cascades again while a used pipeline or stage still can't be deleted on its own |
| `automation.0001_initial` | Rules, events, executions, notifications, notification preferences |
| `integrations.0001_initial` | Connections, encrypted credentials, OAuth states, webhook dedup, inbox items, read state, mutes, links, pending actions, email messages and drafts, external records |
| `assistant.0001_initial` | AI settings, AI interactions (audit), pending actions (proposals) |
| `mcp.0001_initial` | Grants (one person, one workspace, one client, chosen at consent) and hashes of rotated refresh tokens (reuse detection). Client registrations use allauth's existing tables |

**Major files.** Against the Lumen branch the diff is about 423 files, +59,600 / −110 lines. Of
these, 278 files and +55,059 / −110 lines are outside `docs/`; the rest is documentation,
screenshots and evidence:

| Area | Files |
|---|---|
| API plumbing and auth | `services/portal/apps/api/` (`decorators.py`, `auth.py`, `oauth.py`, `schema.py`, `http.py`), `apps/oidc/views.py` (`login_required`, `iss`) |
| Tenancy, CRM, verticals | `apps/crm/access.py` (all authorisation), `models.py`, `models_verticals.py`, `models_meetings.py`, `services.py`, `realestate.py`, `lending.py`, `documents.py`, `meetings.py`, `reports.py`, `home.py`, `api_views.py`, `api_verticals.py`, `demo*.py`, `signals.py` |
| Automation | `apps/automation/` (`engine.py`, `services.py`, `notifications.py`, `jobs.py`) |
| Integrations | `apps/integrations/` (`oauth.py`, `tokens.py`, `crypto.py`, `http.py`, `providers/`, `sync.py`, `webhooks.py`, `services.py`, `actions.py`, `mock/providers.py`) |
| AI and connector | `apps/assistant/` (`registry.py`, `chat.py`, `providers/`, `actions.py`, `safety.py`, `save_to_record.py`), `apps/*/ai_tools*.py`, `apps/mcp/` (`server.py`, `oauth.py`, `cimd.py`, `views.py`) |
| Settings, templates, brand | `lumen/settings.py`, `config/plans.yml`, `templates/` (banner, role picker, business settings), `branding/` |
| Deploy | `deploy/lib/render.py`, `deploy/lib/stack.sh`, `docker-compose.yml`, `lumenctl`, `lumen.conf.example` |
| Chat SPA | `services/chat/src/workspace/` (shell, registry, auth, API client, `areas/*.tsx`, `verticals/`, `integrations/`, `assistant/`), `styles/workspace.css`, `styles/integrations.css` |
| Dev and tests | `dev/nexus/`, `services/portal/tests/test_nexus_*.py`, `services/chat/test/unit/*`, `tests/nexus/*.mjs`, `tests/nexus/brand_contrast.py`, `tests/nexus/mcp_sdk_conformance.py` |
| Docs | `docs/nexus/` (ARCHITECTURE, DEVELOPMENT, CONFIG, INTEGRATIONS, CLAUDE-CONNECTOR, IMPLEMENTATION-NOTES, this report) |

## 8. Your decision: installer wiring for secure document storage

**Without it** (the branch as it is), an installed server has no document key or directory.
Lending works, except that document uploads and downloads answer `503 not_configured`, and the
Lending area says "Secure document storage isn't set up on this server yet". The fresh install
in section 5 shows exactly this. An operator can set it up by hand (CONFIG.md, "Secure lending
documents", 5 steps). The manual change to `docker-compose.yml` must then be checked after every
update, and backups don't include the documents.

**The proposed patch** (team B1, kept outside the repository and **not applied**:
`/tmp/claude-0/-home-user/e6bb18e2-ef15-525e-9375-04c4a4514dbf/scratchpad/b1-deploy-wiring.patch`,
141 lines) would:
* generate the secret `nexus_document_key` (32 bytes) with the installer's other secrets (`deploy/lib/stack.sh`);
* create `${LUMEN_DATA_DIR}/nexus-documents` with mode 0700 for the app user;
* give **only the portal** the key file and the directory (`docker-compose.yml`), so no other service, Caddy above all, can mount them;
* add the ciphertext to backups as `nexus/documents.tar`, even with `--no-media`, and have restore put it back (`backup.sh`, `restore.sh`);
* add deploy tests (`tests/deploy/test_render_apps.py`).

Apply it if lending documents should work on installed test servers. Leave it out to keep
installs document-free until virus scanning and a retention policy exist. Either way the key
must be backed up off the server: losing it makes every document unreadable.

## 9. What an administrator must still provide

| For | What | Where it is described |
|---|---|---|
| Gmail | Google Cloud OAuth web client (`NEXUS_GOOGLE_CLIENT_ID`, secret `nexus_google_client_secret`), the Gmail API, the consent screen with the two restricted scopes, Google verification before customers use it | [INTEGRATIONS.md §2](INTEGRATIONS.md#google-gmail), [CONFIG.md](CONFIG.md#integrations-and-the-unified-inbox-team-b2) |
| HighLevel | A Marketplace app (`NEXUS_GHL_CLIENT_ID`, secret `nexus_ghl_client_secret`, optional `NEXUS_GHL_APP_ID`) or a private integration token per workspace; webhook URL | [INTEGRATIONS.md §2](INTEGRATIONS.md#gohighlevel) |
| Slack | A Slack app (`NEXUS_SLACK_CLIENT_ID`, secrets `nexus_slack_client_secret` and `nexus_slack_signing_secret`), Events API URL, bot scopes | [INTEGRATIONS.md §2](INTEGRATIONS.md#slack) |
| In-app AI with a model | `AI_PROVIDER=anthropic`, `AI_MODEL` (a current Claude model ID; no default on purpose), secret `ai_api_key` | [CLAUDE-CONNECTOR.md §8](CLAUDE-CONNECTOR.md#8-the-in-app-assistants-model-anthropic-api), [CONFIG.md](CONFIG.md#ai-assistant-and-claude-connector-team-b3) |
| Claude connector | `NEXUS_MCP_ENABLED=true`, a public HTTPS domain with a valid certificate reachable from 160.79.104.0/21, then "Members may connect Claude" per workspace | [CLAUDE-CONNECTOR.md §1-4](CLAUDE-CONNECTOR.md) |
| Lending documents | Your decision in section 8 (or the manual steps) | [CONFIG.md](CONFIG.md#secure-lending-documents) |
| Business workspaces | A plan with `crm_enabled` (and `vertical_profiles` for real estate and lending), then an owner picks the business profiles | [ARCHITECTURE.md §8](ARCHITECTURE.md#8-features-profiles-and-plans) |
| The integrations key | Generated by the installer (`nexus_integrations_key`); keep it, and rotate it as described | [CONFIG.md](CONFIG.md#rotating-the-integrations-key) |

## 10. Run the test environment locally from a fresh clone

Needs Docker, Python 3.13, Node 22 and git. Everything runs on 127.0.0.1 with synthetic data.

```sh
git clone https://github.com/Techprosoftware707/0trust-chat.git nexus && cd nexus
git checkout test/unified-business-workspace

# PostgreSQL for the dev servers and the tests (setup.sh also creates it when missing)
docker run -d --name nexus-pg -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=lumen_app -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=nexus postgres:17-alpine

# Python (hash-pinned) and Node dependencies, plus Playwright's Chromium for the browser tests
python3.13 -m venv ~/nexus-venv
~/nexus-venv/bin/pip install --require-hashes -r services/portal/requirements.txt
~/nexus-venv/bin/pip install pytest pytest-django hypothesis ruff
export NEXUS_VENV=~/nexus-venv
(cd services/chat && npm ci --ignore-scripts && npx playwright install chromium)

# Database, migrations, OAuth clients, demo data, dev homeserver, demo Matrix accounts
bash dev/nexus/setup.sh

# Dev servers (two terminals); the connector is optional
NEXUS_MCP_ENABLED=1 bash dev/nexus/run-portal.sh     # http://127.0.0.1:8710
bash dev/nexus/run-chat.sh                           # http://127.0.0.1:5710
```

Open `http://127.0.0.1:5710/` and sign in as `demo-avery` (owner), `demo-morgan` (manager),
`demo-riley` (agent), `demo-casey` (team member) or `demo-sam` (read-only). The password is
`nexus-demo-pass-2026`. Integrations run against the labelled mock providers by default.

Tests (details in [DEVELOPMENT.md](DEVELOPMENT.md)):

```sh
(cd services/portal && POSTGRES_PORT=55433 POSTGRES_DB=nexus "$NEXUS_VENV/bin/python" -m pytest)
(cd services/chat && npm test && npm run lint && npm run typecheck && npm run build)
python3 -m unittest discover -s tests/deploy
python3 tests/nexus/brand_contrast.py
. dev/nexus/env.sh && node tests/nexus/journey.smoke.mjs     # with both dev servers running
```

## 11. Reviewing the branch and opening a pull request

1. **Review the Nexus changes alone.** Compare
   `claude/dreamy-sagan-mheysz...test/unified-business-workspace` on GitHub. The Lumen tip
   `711fcd8` is an ancestor of this branch, so the comparison shows only Nexus: about 423 files,
   278 of them outside `docs/`. Start with ARCHITECTURE.md, this report and the journey
   screenshots.
2. **Mind what a PR into `main` would contain.** `main` holds only a README. A pull request from
   this branch into `main` would contain the **whole Lumen platform plus Nexus**: about 1,840
   files and +178,600 lines. Pick one of these:
   * merge the Lumen branch first: a PR `claude/dreamy-sagan-mheysz` → `main`, reviewed and merged;
     then `test/unified-business-workspace` → `main` shows only Nexus; or
   * open the Nexus PR with base `claude/dreamy-sagan-mheysz`, for a Nexus-only diff, and bring
     Lumen and Nexus to `main` together later.
3. **Let CI run once** on the PR (shared checks, web, portal). It hasn't run for these commits:
   every commit says `[skip ci]`, because CI costs money.
4. **Before any real customer data:** decide the product name, the document-storage wiring
   (section 8), and live tests of Gmail, HighLevel, Slack, the Anthropic API and a real Claude
   connection on a test server with a public certificate (sections 3 and 9).
