# Nexus Office AI: implementation notes (foundation)

"Nexus Office AI" is an **experimental, test-branded** evolution of Lumen Secure (end-to-end
encrypted Matrix chat and calls) into an AI-assisted business workspace. These notes record
where the work started, why, and the assumptions the foundation makes. The contracts that the
other teams build on are in [ARCHITECTURE.md](ARCHITECTURE.md); how to run everything locally
is in [DEVELOPMENT.md](DEVELOPMENT.md).

## Starting point

| Fact | Value |
|---|---|
| Branch | `test/unified-business-workspace` (pushed to `origin`) |
| Created from | `eefa6ab` "Design tokens: light-mode accent, subtle text and status colours meet WCAG AA as text", the tip of `claude/dreamy-sagan-mheysz` |
| `origin/main` | `856a1aa` "Initial commit" (README only); an ancestor of `eefa6ab` |
| Worktree | `/home/user/nexus` |

**Why not branch from `main`:** `main` holds only the initial README. The whole existing
product (portal, chat SPA, calls, apps, installer, tests) lives on `claude/dreamy-sagan-mheysz`.
Branching from `main` would have discarded the chat app that the product keeps at its centre,
so the branch starts from that branch's tip. `main` and `claude/dreamy-sagan-mheysz` are never
written to from this work (other agents work on the latter in `/home/user/0trust-chat`).

## Ground rules followed

* Nothing is deployed anywhere: no production, no VPS, no `lumenctl apply`, and the other
  tree's Docker dev stack (its containers, port 55432, the 8000 range, `restore-env.sh`) is not
  used. This work uses its own PostgreSQL (`nexus-pg`, 127.0.0.1:55433), its own homeserver
  container (`lumen-chatdev-nexus`, 127.0.0.1:28108) and its own dev-server ports (portal 8710,
  chat SPA 5710). See [DEVELOPMENT.md](DEVELOPMENT.md).
* No new Python or npm dependencies were added (the hash-pinned `requirements.txt` and
  `package-lock.json` are unchanged).
* `design/tokens.css` is shared with the Lumen branch and is not edited; the Nexus look is a
  layer in `branding/theme.css` (operator brand hooks).

## Assumptions

1. **Organisation = workspace.** `workspaces.Workspace` is the tenant ("organisation") and
   `workspaces.Membership` the membership. No second tenancy model exists.
2. **Roles.** `owner`, `admin` and `member` keep their stored values; `member` is presented as
   "Team member". `manager`, `agent` ("Agent / Broker") and `readonly` are new values of the same
   `role` column. The migration only widens the choice list: every membership and invitation row
   is kept as it is.
3. **The portal account is the business identity.** The SPA calls the API with a bearer token
   issued by the portal's own OAuth server to the first-party public client `nexus-web`. The
   Matrix account is only used for chat; in production both come from the same portal account
   (SSO), and the SPA warns when they do not match (local test set-ups can mix them).
4. **End-to-end encryption is untouched.** The server, the API, the future AI assistant and the
   MCP connector never see native chat content. CRM rows store Matrix room and event IDs only.
5. **Business features are opt-in per workspace** (`crm.OrgSettings.business_profiles` and
   plan entitlements). A workspace without CRM enabled behaves exactly like before.
6. **Demo data is synthetic** and created only by `manage.py nexus_demo_seed`, which, like
   `nexus_demo_reset`, refuses to run unless `NEXUS_ENVIRONMENT` is `development` or `test`.
7. **The brand is temporary.** "Nexus Office AI" defaults exist on this branch only, set through
   the existing brand hooks (`BRAND_*` settings, `branding/`), so reverting the brand is a
   configuration change.

## Log

The full hand-off (files, migrations, contracts) is in [ARCHITECTURE.md](ARCHITECTURE.md),
including its [Foundation status](ARCHITECTURE.md#foundation-status) with the known gaps; the
commands are in [DEVELOPMENT.md](DEVELOPMENT.md).

Findings outside the brief, recorded here so nobody re-discovers them:

* **OIDC `prompt=none` without a portal session** raised a server error in allauth's
  authorization view (an anonymous user was stored with the code). `apps/oidc/views.py` now
  answers `login_required` to a registered redirect URI, as OpenID Connect requires, and a
  400 page otherwise (commit `ec90f00`, tests in `test_nexus_auth.py`).
* **`tests/deploy/test_tokens.py::test_themes_differ_and_use_brand_palette` fails at the
  starting commit `eefa6ab` already** (`design/tokens.css` dark `--bg` is `#081024`, the
  palette's `lm-midnight-950` is `#050b1a`). `design/` and that test are shared Lumen files
  this branch must not touch, so it is left failing and reported. Fixed on the Lumen side in `01c7773`
  and passing since the [merge of the Lumen polish](#merge-of-the-lumen-polish).
* **Chat UI suite (`npm run test:ui`)**: one run had "sign out wipes local data" time out
  waiting for the signed-out notice; the immediate re-run passed 23/23. The workspace
  sign-out hook is a no-op without a `workspace` block in the chat config (as in that suite),
  so this looks like timing in the suite rather than this branch; worth watching.
* **ruff** has no configuration in this repository and CI does not run it; the Nexus Python
  code is clean under `E,F,W,I` (command in DEVELOPMENT.md). Ruff's wider default set reports
  `RUF012` (mutable Django `Meta`/class attributes) here as it does in the existing apps.

## Merge of the Lumen polish

**What.** `origin/claude/dreamy-sagan-mheysz` up to `01c7773` was merged into this branch with
`git merge --no-ff` (merge commit `75c3570`, parents `e45c540` and `01c7773`): 528 files of
GUI polish for the web chat, desktop, portal/website/console, Android and iOS, the WCAG AA
token fixes, WireGuard on by default and configured by the installer, docs and tests. It is a
real merge, never a rebase or squash, so the next batch of Lumen fixes merges the same way
from merge base `01c7773`.

### Conflicts and how they were resolved

Every resolution keeps both sides: the polished layout, markup, copy and accessibility, plus
the Nexus banner, `[Test]` title prefix, brand hooks, role picker and business settings.

| File | Lumen polish | Nexus | Result |
|---|---|---|---|
| `static/lumen/css/lumen.css` | rewrote the component layer; moved the old tail rules (`.diag-output`, `.history`, `.text-right`) up into their sections | appended the banner, role picker and fieldset/legend rules | polished file + the Nexus block at the end. The role `<select>` keeps right padding for the polished chevron and reaches 44 px on touch devices like the other controls |
| `templates/base.html` | `viewport-fit`, robots block, Open Graph, per-scheme `theme-color`, icons in maintenance/announcement banners | `[Test]` title prefix, environment banner, Nexus navy `theme-color` | polished head with the prefix and banner; `theme-color` follows the Nexus backgrounds (`#f4f6fa` light, `#060c1d` dark) and `mask-icon` the Nexus navy (`#0a1430`) |
| `templates/portal/base_portal.html` | off-canvas sidebar (`sidebar-inner`, close button, `aria-label`s) | "Open workspace" link | polished sidebar with "Open workspace" before "Open chat" |
| `templates/portal/dashboard.html` | "Welcome back", copyable address chip, two-column grid, Matrix card | "Open workspace" button next to "Open chat", Business badge on workspace rows | polished page with both buttons (workspace primary) and the badge in the polished workspace row |
| `templates/portal/workspace_detail.html` | member actions in a "Manage" row menu (Make admin/member, Make owner, Remove, Leave); invitation copy and placeholder | role picker with all six roles instead of the admin/member toggle; invite role for owners and admins with help text | role picker inline, row menu keeps Make owner, Remove and Leave (the toggle is replaced by the picker); polished invitation copy with the Nexus role field, its help text now linked with `aria-describedby` |
| `templates/site/base_site.html` | "Your account" instead of "Dashboard" | "Open workspace" instead of "Open chat" | "Your account" and "Open workspace" |

### Auto-merged files checked for semantic clashes

* **`room/RoomHeader.tsx`**: the polished header folds its secondary actions into a "More
  options" menu when the header is narrow (container query). The Nexus room-panel buttons
  (the CRM panel) were always shown; they are now `wide-only` and appear as items of that menu
  in a narrow header, like Search, Call history and Details.
* **`ChatApp.tsx`**: Lumen sizes `.app` to the visual viewport (`--app-height`) so the composer
  stays above the on-screen keyboard. With the environment banner, `workspace.css` made
  `.app` `height: auto` inside a 100 %-high `#root`, which bypassed that. `#root` now takes
  `var(--app-height, 100dvh)` when the banner is shown, and `.app` fills the rest.
* **`RoomView.tsx`** (loading skeleton, `PanelId` types), **`render.py`** (WireGuard defaults and
  `WG_ENDPOINT` next to `NEXUS_ENVIRONMENT` and the chat `workspace` block), **`settings.py`**
  (`WIREGUARD_ENABLED` defaults to on next to the Nexus settings), **`accounts/views.py`**
  (`returning`, the Business flag and assignable roles) and `workspace_settings.html`: the
  changes are independent; nothing to adapt.
* **Brand strings.** The polished chat (About tab, sign-in) and the website/portal templates
  already use `config.brand.shortName` / `brand.short_name`, so this branch says "Nexus runs
  on Matrix" (the configured short name; `BRAND_SHORT_NAME=Nexus Office AI` would make it
  "Nexus Office AI runs on Matrix") with the same facts (Matrix, end-to-end encryption, WireGuard only for server
  administration). One polished sentence hardcoded the name: the console's Calls page ("…
  does not offer TURN over TLS") now uses `brand.short_name`. Left as they are: the
  `Lumen {{ lumen.version }}` labels (they name the software release, as before the merge),
  the desktop app's static placeholders (replaced at run time from its discovered brand), and
  the Android and iOS apps, which are called Lumen throughout and are outside the brand hooks.
* **Design tokens.** `python3 design/tools/gen_tokens.py --check` passes and
  `tests/deploy/test_tokens.py` passes with Lumen's `01c7773` (lifted dark backgrounds as
  palette entries). `branding/theme.css` overrides every value it needs, so the measured
  Nexus contrast is unchanged (81 pairs pass).

### Fixes made while verifying

* **Environment banner and sticky layouts** (portal `lumen.css`, chat `workspace.css`). The
  banner is sticky (portal) or in flow (chat) with a high `z-index`, and things that stick to
  or cover the top of the window slid under it: the website header and the portal's phone bar
  when scrolling, the bottom of the portal sidebar (Sign out was cut off at 900 px high; this
  predates the merge), and in the chat SPA the full-window side panels on phones and tablets
  and the call screen (the CRM panel's close button was unreachable on a phone). The banner
  is now one fixed-height line at every width (30 px portal, 26 px chat) and these elements
  start below it (`--env-banner-h`). To fit one line on phones, the note "Don't enter real
  customer information." is read by screen readers only below 640 px; the visible text
  ("Test environment · synthetic demo data") is unchanged.
* **Members row menu** (a Lumen-side gap): an admin looking at another admin got an empty
  "Manage" menu. The menu now appears only when it has an item.
* **Smoke test** (`tests/nexus/shell.smoke.mjs`, 16 checks): the polished chat sign-in says
  "Welcome back", so the smoke waits for the Sign in button; a new phone check opens the CRM
  panel from "More options" and closes it with its own close button.

### Verification after the merge (observed)

Portal pytest 367 passed (346 before the merge + Lumen's 21 new `test_ui_pages.py` tests); chat
`npm test` 129 passed, `lint`, `typecheck` and `build` clean; `unittest discover -s
tests/deploy` 56 OK; CI shellcheck, TLS-bypass and secret greps clean; `brand_contrast.py`
81 pairs, 0 failing; `npm run test:e2ee` 5/5 and `npm run test:ui` 23/23 against
`lumen-chatdev-nexus`; `shell.smoke.mjs` 16/16 against the slot-0 dev servers. The
screenshots in `screenshots/foundation/` were refreshed (all that changed visibly) and
`room-crm-panel--phone-light.png` was added.

**WireGuard on by default** now applies to installs of this branch too: the installer brings
up the operator tunnel and creates a first device profile (`WG_ENDPOINT` is new; see the Lumen
docs). It is for server administration only; chat stays protected by Matrix end-to-end
encryption, and the local Nexus test environment does not run it.

## Team B3: AI assistant and Claude connector

What was built is described in [CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md) and the settings in
[CONFIG.md](CONFIG.md#ai-assistant-and-claude-connector-team-b3). Decisions and findings:

* **No new dependencies.** The Anthropic provider uses raw HTTPS with `requests` (already a
  dependency), not the `anthropic` SDK. The official MCP SDK (`mcp` 2.3.0 and 1.30.0, approved
  by main as dev-only conformance clients) lived in throwaway venvs in the scratchpad. Their
  `pip freeze` is in `docs/nexus/evidence/b3/`. Evidence lives in `docs/nexus/evidence/`
  because `test-results/` is ignored by the repository's `.gitignore`.
* **`@api_endpoint(atomic=False)`** (shared change in `apps/api/decorators.py`). The chat view
  must not hold one request transaction around model calls that take seconds, because the
  audit chain takes `pg_advisory_xact_lock`. Each tool runs in its own short transaction
  instead. Tools that call an external provider (`Tool.atomic=False`) and `confirm` manage
  their own transactions, so a provider's rotated token is never rolled back.
* **`iss` on every authorization response** (RFC 9207, `apps/oidc/views.py`), including the
  SPA's `nexus-web` flow. `tests/test_nexus_auth.py` expects it.
* **allauth gaps worked around** (`apps/mcp/oauth.py`, `apps/oidc/adapter.py`):
  * DCR without `token_endpoint_auth_method` defaulted to `client_secret_basic`; it is
    normalised to `none` (public).
  * `localhost` loopback redirects didn't match any port; `clientkit.is_loopback` is patched in
    `McpConfig.ready()` so `localhost` counts like `127.0.0.1` (Claude Code uses both).
  * `prompt=none` (silent authorization) would issue a code without the consent screen; for
    MCP clients it now answers `consent_required`, so every connection is approved explicitly.
  * allauth's own CIMD support (2 KB limit, no SSRF protection) is not used. `apps/mcp/cimd.py`
    fetches documents itself: pinned to the vetted public IP, no redirects, size and time
    limits.
  * Refresh-token reuse can't be detected from allauth's table, because the old token is
    deleted on rotation. Hashes of rotated tokens are kept (`RotatedRefreshToken`) until they
    would have expired, and presenting one revokes the connection.
  * Validation errors at the token endpoint became 500s; the wrapper answers `invalid_request`.
* **A connection is bound to one workspace at consent** (`McpGrant`). The consent screen asks
  when the person belongs to several, so a token can never be used in another workspace.
* **Consent CSP**: `form-action` is extended with the redirect origin on the consent page.
  Browsers otherwise block the redirect that follows the form POST.
* **"Save to record"** is a panel in the room's CRM sidebar with a picker of this device's
  decrypted text messages, not a selection mode in Lumen's timeline. That would have meant
  editing shared Lumen chat components.
* **SPA routes assumed for other teams' records**: `#/properties/<id>` and `#/lending/<id>`
  (verticals) and `#/inbox/<id>` (integrations). They are registered with `register_link` in
  `apps/crm/ai_tools_verticals.py` and `apps/integrations/ai_tools.py`, so they are easy to
  change.
* **AI-suggested next steps** (`suggest_next_step`) use `meetings.propose_action_item(source="ai_suggestion")`,
  as main asked. The proposed action item is itself the proposal a person confirms in Nexus;
  there is no extra PendingAction.
* **Integrations**: drafts only. `prepare_email_reply_draft` is two-phase. Confirming creates
  the Gmail draft; sending stays in B2's UI flow. There are no tools for Slack posts or
  HighLevel writes: B2's confirmation token would reach the model, and there is no UI to
  confirm an AI-prepared external action.
* **Dev environment**: `dev/nexus/setup.sh` on slot 3 reported failed Matrix shared-secret
  registrations for the demo people. Those accounts already existed on the homeserver and
  signing in worked. During the SDK conformance run the shared `nexus-pg` hit its 100-connection
  limit (other slots' runservers held idle connections); main is adding `POSTGRES_CONN_MAX_AGE`.

## Team B1: verticals, automation, calendar, meetings and reports

What was built is in [ARCHITECTURE.md](ARCHITECTURE.md) section 12, and the settings are in
[CONFIG.md](CONFIG.md#verticals-lending-documents-automation-and-reports-team-b1). Decisions,
assumptions and findings:

* **No new dependencies.** Encryption uses `cryptography` (AES-256-GCM), tokens use
  `django.core.signing`, and the SPA uses only what was already installed.
* **Lending applications are their own records with their own pipeline**, not deals. They
  get a `Pipeline(kind="lending")` with the brief's seven stages. The Pipelines page opens a
  deal pipeline by default and, on a lending pipeline, points to the Lending area; the
  dashboard's deal pipeline summary leaves lending pipelines out. The demo's former lending *deals* were replaced by five applications, APP-0001 to
  APP-0005. An application can point to a deal and a property.
* **Checklist status `pending`** was added before `requested`: an item from a template
  hasn't been asked for yet. Outstanding = pending, requested or rejected, for required items.
* **Decisions are staff records only.** `decision` is empty until someone with
  `lending.decide` records one with `"confirm": true` and an optional note. Nothing in the
  code sets it otherwise. The UI says "Authorised staff make every lending decision. Nexus
  never approves or rejects anything". Automations can't touch it: there is no action for it.
* **"Request document"** creates a private task for the requester (related to the
  application) and marks the item `requested`. Nothing reaches the borrower. The checklist
  says "Nexus can't send the request to the borrower yet".
* **Download tokens** are signed (`django.core.signing`, user + workspace + document +
  grant + expiry) and backed by a single-use `DocumentDownloadGrant` row. They travel in a
  POST body, never in a URL. The download view returns its refusals instead of raising them,
  so the audit and access-log rows of a refused download are committed.
* **Agents ("brokers") see only applications assigned to them** (`loan_officer`). The brief's
  "assigned broker" was read as the application's loan officer, and borrowers' contact
  visibility doesn't widen it.
* **Viewings are calendar events** (`kind="viewing"`, related to the property, the buyer as
  attendee contact), so they show in the calendar, on Home and in reminders without a second
  model. `CalendarEvent.kind` was added to the foundation model in `crm.0002`.
* **Shared fix: `Opportunity.pipeline/stage` from `PROTECT` to `RESTRICT`** (`crm.0003`,
  approved by main). With `PROTECT`, deleting a business workspace that had deals raised
  `ProtectedError`. `RESTRICT` still blocks deleting a used pipeline or stage on its own (the
  API answers 409 with a message), but lets the workspace cascade. Tested. The demo reset's
  blocker check handles both.
* **Shared fix: `POSTGRES_CONN_MAX_AGE`** (default 60, `dev/nexus/env.sh` 0, approved by
  main). Several slots' dev servers with persistent connections exhausted the shared
  `nexus-pg` (100 connections).
* **Automation actions run as the rule's owner** (whoever last saved it), who must still be
  an active member with `automation.manage`. Otherwise the run fails visibly ("save the rule
  again to take it over"). There is no service account that could exceed a person's rights.
* **Example rules** (the brief's four) are seeded, switched on, only in the demo workspace.
  Other workspaces start empty.
* **Notifications are in-app only.** There is no email or push channel in this phase, and
  the preferences page says so.
* **Meeting rooms are created by the browser** (`createGroup`, encrypted) and only the room
  ID is stored. Recent calls in Calls & Meetings come from the chat client's call events in
  the browser and are never sent to the server. "Link to record" sends only what the person
  confirms, plus the room and event IDs.
* **Home's connected-service slot** discovers `health.py` modules
  (`nexus_modules("health")`) rather than importing the integrations app, so Home works with
  or without it. Home shows B2's rows as they are, with the mock label.
* **Real-estate listings are never invented.** Properties come from manual entry or a
  labelled import or integration (`source`, `source_label`). There is no MLS or listing feed,
  and the demo's properties say "(fictional)".

Known gaps:

* **Installer wiring for secure documents** isn't in the repository: on a deployed server
  uploads and downloads answer `503 not_configured` until an operator sets up the key and
  directory by hand (steps in CONFIG.md). The proposed patch is pending the owner's decision.
* No virus scanning of uploaded documents. No re-encryption command for key rotation.
* No editor in the app for checklist templates (API only) and no bulk actions.
* Recording and transcription don't exist, so meeting notes are typed by people. External
  meeting invitations wait for the Gmail integration.
* Reports are computed per request. That's fine at test-build sizes; there are no
  snapshots or exports.
* `dev/nexus/setup.sh` on slot 1 reported failed Matrix shared-secret registrations
  (`matrix-users.mjs`, HMAC) for the demo people. The accounts already existed and signing in
  worked; it wasn't investigated further (shared homeserver, not B1's to change).
