# Nexus Office AI: architecture and contracts

Nexus Office AI is a **test-branded** evolution of Lumen Secure into an AI-assisted business
workspace: end-to-end encrypted chat and calls at the centre, plus contacts, pipelines, tasks,
a timeline, and later email, integrations, AI and vertical workflows. This document is the
contract the integrations, AI/MCP and verticals/automation teams build on. Start points:
[IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md) (where this came from) and
[DEVELOPMENT.md](DEVELOPMENT.md) (run everything locally).

## 1. Shape of the system

| Piece | Where | What changed for Nexus |
|---|---|---|
| Portal (Django 6.1, allauth 65) | `services/portal` | is the backend: new apps `api` (shared API plumbing), `crm` (business records), and empty `integrations`, `assistant`, `mcp`, `automation`; OAuth client `nexus-web`; roles; business settings |
| Chat SPA (React 19, matrix-js-sdk) | `services/chat` | is the workspace shell: navigation rail, registry of areas, Home, Contacts, CRM, Pipelines, Tasks, Settings, CRM panel next to a conversation |
| Homeserver (Synapse), calls (LiveKit) | unchanged | unchanged: chat and calls work exactly as before |
| Deploy renderer | `deploy/lib/render.py` | chat `config.json` gets `workspace` and `environment`; `NEXUS_ENVIRONMENT` in the app env |

A deployment without a `workspace` block in the chat `config.json` is the unchanged chat app.

## 2. Tenancy and roles

* **Organisation = `workspaces.Workspace`, membership = `workspaces.Membership`.** No other
  tenancy model exists. Every business row has a NOT NULL, indexed `workspace` foreign key.
* **Roles** (`workspaces.models.Role`, migration `workspaces.0002_nexus_roles` only widens
  the choices; existing rows keep their values):

| Value | Label | Records | Configuration (pipelines, stages, fields, tag admin) | Workspace settings, integrations ownership |
|---|---|---|---|---|
| `owner` | Owner | all: view, change, delete | yes | yes (+ billing, transfer, delete workspace) |
| `admin` | Admin | all | yes | yes |
| `manager` | Manager | all | yes | **no** |
| `agent` | Agent / Broker | view own + assigned + collaborating + shared with the team; change own/assigned/collaborating; delete own | no (may create tags) | no |
| `member` | Team member | view shared with the team; create and work on **their own** tasks; own calendar events | no | no |
| `readonly` | Read-only | view shared with the team | no | no |

"Shared with the team" = `visibility="team"` (the default); `visibility="private"` limits a
contact, deal, task or event to its owner, assignees/collaborators/attendees and managers+.
Workspace administration in the portal (members, invitations, settings, billing) keeps its
rules: owner/admin manage; owners give any role but owner; admins give manager, agent, team
member and read-only.

## 3. Authorization: one module, `apps/crm/access.py`

Nothing reads tenant data with a bare `Model.objects`. Use:

```python
from apps.crm import access
from apps.crm.access import Cap, VIEW, CHANGE, DELETE

actor = access.actor_for(user, workspace_id)          # Http404 unless a member
qs = access.for_actor(actor, Contact)                  # tenant- and role-filtered rows
obj = access.get_for_actor(actor, Contact, pk, CHANGE) # 404 if invisible, 403 if read-only for them
access.require(actor, Cap.CRM_CONFIGURE)               # role capability, 403 otherwise
contacts = access.resolve(actor, Contact, ids, field_name="contact_ids")   # IDs from a body
user = access.resolve_member(actor, public_id, field_name="owner_id")      # users by public_id
obj = access.resolve_ref(actor, "crm.contact", id)     # generic reference
access.audit_write(request, actor, "update", obj, fields=["stage"])        # every write
access.audit_read(request, actor, obj, reason="contact_detail")            # sensitive reads
```

Rules every endpoint follows:

* **404, never 403, for objects the actor can't see** (other workspace, private, malformed
  or unknown ID): IDs can't be probed. 403 `permission_denied` only for objects the actor
  *can* see but not change, and for role capabilities.
* **IDs in request bodies** that are unknown, in another workspace or invisible give the
  same `400 validation_error` with `"Unknown or inaccessible ID."` on that field.
* **Filters and search** only ever narrow `for_actor()` querysets.
* **Hiding a control is not authorization.** The API enforces everything; the SPA only
  mirrors `capabilities` for UX.
* **Every write is audited** (`crm.<model>.<verb>`, hash-chained `core.AuditEvent`) with
  field *names* only; never record contents, never tokens. Contact detail reads are audited
  (`crm.contact.read`, setting `NEXUS_AUDIT_SENSITIVE_READS`).
* **Sensitive custom fields** (`FieldDefinition.sensitive`) are not sent to team members and
  read-only people.

### Adding a model (all teams)

1. Subclass `apps.crm.models.TenantModel` (UUID pk, `workspace`, `created_by`, timestamps,
   `is_demo`). Put indexes on the columns you filter by, starting with `workspace`.
2. Write a `Policy` (see `ContactPolicy` for the owner/assignee pattern, `ConfigPolicy` for
   configuration) and `access.register(MyModel, MyPolicy())` in your app's `apps.py`
   `ready()`. Registered models can be targets of generic references.
3. Copy the isolation tests: `tests/test_nexus_isolation.py` proves, for every model and
   endpoint, that IDs, filters, search and nested IDs of another workspace leak nothing. Add
   your model to `test_access_layer_never_returns_other_workspace_rows` (it iterates the
   registry) and your endpoints to the parametrised lists.

## 4. Data model (`apps.crm`, migration `crm.0001_initial`)

| Model | Key fields | Indexes |
|---|---|---|
| `OrgSettings` (one per workspace) | `business_profiles` (general, real_estate, lending), `default_currency`, `save_to_record_enabled` (default **off**), `is_demo` | pk = workspace |
| `Contact` | `kind` (lead, prospect, client, past_client, partner), `roles` (buyer, seller, landlord, tenant, investor, borrower, co_borrower, referral_partner, vendor, other), names, company, job title, email, phone, `owner`, `assignees`, `visibility`, `source`, `campaign`, `follow_up_at`, `priority`, `tags`, `custom_fields` (validated), `last_activity_at`, `archived_at` | (ws, owner), (ws, follow_up_at), (ws, -updated_at), (ws, kind), (ws, email) |
| `Tag` | name (unique per workspace, case-insensitive), colour | unique (lower(name), ws) |
| `FieldDefinition` | entity (contact/opportunity), key, label, type (text, long_text, number, decimal, currency, boolean, date, select, multiselect, email, phone, url), options, required, sensitive, profile | unique (ws, entity, key) |
| `Pipeline` / `Stage` | kind (general, real_estate, lending), position, is_default, currency / name, position, is_won, is_lost (not both), probability | stage: ordering by pipeline, position |
| `Opportunity` (deal) | contacts (through `OpportunityContact` with a role), pipeline, stage, value, currency, owner, collaborators, visibility, priority, status (derived from the stage), expected close, closed_at, stage_entered_at, position (kanban), custom_fields | (ws, stage), (ws, owner), (ws, -updated_at), (ws, expected_close_date), (pipeline, stage, position) |
| `StageHistory` | opportunity, from/to stage (+ names at the time), who, when | (opportunity, -created_at) |
| `Task` | title, description, assignee, due_at, priority, status (open, in_progress, done, canceled), completed_at/by, contact, opportunity, generic `related_type`/`related_id`, `source` (manual, ai_suggestion_confirmed, automation, integration), visibility | (ws, assignee, status, due_at), (ws, due_at), (ws, -updated_at) |
| `Activity` (timeline) | kind (note, call, meeting, email, message_link, stage_change, task_event, integration_event), source (native, gmail, gohighlevel, slack, system), actor, occurred_at, summary, body, external_ref, `room_id`/`event_id` (IDs only), **`untrusted`**, metadata, contact/opportunity/task, generic related | (ws, -occurred_at), (contact, -occurred_at), (opportunity, -occurred_at), (ws, -updated_at) |
| `CalendarEvent` | title, start/end (end ≥ start), all_day, location, organizer, attendee users and contacts, `matrix_room_id` (call link), contact/opportunity, generic related, status, visibility | (ws, start_at), (ws, organizer, start_at), (ws, -updated_at) |
| `ConversationLink` | `room_id` (+ optional `event_id`) linked to a contact **or** an opportunity | (ws, room_id); unique per target |
| `ExternalRecordMapping` | provider, external_id, object_type, object_id, external_url, last_synced_at, sync_state (never secrets) | unique (ws, provider, external_id); (ws, object_type, object_id) |
| `RecordLink` | typed edge between any two registered records (`from_type/id`, `to_type/id`, `relation`) | (ws, from), (ws, to) |

**Related records for the verticals team.** `Property`, `LendingApplication`, document
checklists and secure documents are yours. Make them `TenantModel`s, register them, and
link them with `Task/Activity/CalendarEvent.related_type` + `related_id` (validated through
`access.resolve_ref`), or with `RecordLink` (contact ↔ property, deal ↔ application). If you
need a hard foreign key, add a nullable FK to your own model, not to the CRM ones.

**External IDs** are never stored as internal IDs: integrations write
`ExternalRecordMapping` rows (server-side; the API exposes them read-only to managers+) and
timeline entries with `apps.crm.services.record_external_activity(...)`, which always sets
`untrusted=True` and no human actor.

**Retention.** Business records live as long as the workspace or until deleted (deleting a
workspace cascades). Hard deletes are audited; there is no soft-delete except
`Contact.archived_at`. OAuth tokens are purged by the worker's retention job when expired;
refresh tokens expire after `NEXUS_REFRESH_TOKEN_SECONDS` (12 h, rotated on use). Audit
events follow `RETENTION_AUDIT_DAYS`. Integrations must define a retention period for
synced external content (email bodies) before shipping; demo rows go with
`nexus_demo_reset`.

## 5. The JSON API

**Base:** `/api/v1/` on the public portal surface. Workspace-scoped routes:
`/api/v1/workspaces/<workspace_id>/<app>/...`.

**Authentication: bearer tokens only** (`Authorization: Bearer <access token>`), issued by
the portal's own OAuth server (allauth `idp.oidc`). The portal session cookie is ignored by
the API (so CSRF does not apply and views are CSRF-exempt); tokens in the URL or body are
refused. Scopes: `workspace:read` (GET/HEAD) and `workspace:write` (everything else).

**One entry point per view:**

```python
from apps.api.decorators import api_endpoint
from apps.api.http import created, json_body, no_content, ok, paginated
from apps.api.schema import F, validate

@api_endpoint(methods=["GET", "POST"], feature="crm")
def things(request, actor):      # actor: apps.crm.access.Actor (workspace resolved, 404 otherwise)
    if request.method == "POST":
        data = validate(json_body(request), {"name": F.string(max_length=80, required=True, blank=False)})
        ...
        return created(serialize(obj))
    return paginated(request, access.for_actor(actor, Thing).order_by("-updated_at"), serialize)
```

`@api_endpoint` checks the method, authenticates the token, requires the scope, applies the
per-user rate limit (`NEXUS_API_RATE_LIMITS`: 600 reads, 120 writes per minute), resolves the
workspace, checks the feature flag, runs writes in a transaction and maps exceptions to the
error format. `workspace=False` gives views a `TokenContext` instead (e.g. `/me`).

| Convention | Rule |
|---|---|
| Bodies | `Content-Type: application/json` (else 415), objects only, ≤ 1 MB (413); unknown fields are a validation error |
| Success | `{"data": {...}}`; lists `{"data": [...], "page": {"limit", "next_cursor", "total"}}`; delete `204` |
| Pagination | `?limit=1..200` (default 50) and `?cursor=<page.next_cursor>`; cursors are opaque |
| Errors | `{"error": {"code", "message", "fields"?, "request_id"}}` — codes: `validation_error` 400, `unauthenticated` 401 (+ `WWW-Authenticate: Bearer`), `insufficient_scope` / `permission_denied` / `feature_disabled` / `plan_limit` 403, `not_found` 404, `method_not_allowed` 405, `conflict` 409, `payload_too_large` 413, `unsupported_media_type` 415, `rate_limited` 429 (+ `Retry-After`), `server_error` 500 |
| IDs | UUID strings; people by their random `public_id`, never the database id |
| Time | ISO 8601 with a zone; responses in UTC (`...Z`) |
| Updates | `PATCH` with the fields to change; `null` clears a nullable field |
| Headers | every response: `X-Request-Id`, `X-Nexus-Environment`; API responses `Cache-Control: no-store` |
| CORS | only `NEXUS_CORS_ORIGINS` (the chat app's origin), no credentials |

Endpoints today (`apps/api/urls.py`, `apps/crm/api_urls.py`): `GET /me`;
`GET /workspaces/<id>` (role, plan, features, `view_level`, capabilities, settings);
`GET|PATCH /workspaces/<id>/settings` (owner/admin); `GET /workspaces/<id>/members`;
under `/workspaces/<id>/crm/`: `dashboard`, `search`, `contacts[/<id>[/summary]]`, `tags[/<id>]`,
`fields[/<id>]`, `pipelines[/<id>[/board|/stages|/stage-order]]`, `stages/<id>`,
`opportunities[/<id>[/move|/history]]`, `tasks[/<id>]`, `activities[/<id>]`, `events[/<id>]`,
`room-links[/<id>]`, `mappings`. Filters are documented in each view's docstring.

## 6. OAuth and token validation

* **Client `nexus-web`** (registered by `manage.py lumen_bootstrap`, `apps/api/oauth.py`):
  public, no secret, PKCE S256 required, exact redirect URI `<app origin>/oauth/callback`,
  grants `authorization_code` + `refresh_token`, scopes `workspace:read workspace:write`,
  consent skipped (first party, like the homeserver), CORS origin = the chat app.
  `IDP_OIDC_AUTH_METHODS` gained `none` for public clients; confidential clients (the
  homeserver) still must post their secret (tested).
* **SPA flow** (`services/chat/src/workspace/auth.ts`): once per tab, before the chat client
  starts, a silent request (`prompt=none`); with a portal session (the normal case: chat
  sign-in is SSO through the portal) the code comes straight back; without one the portal
  answers `login_required` and workspace pages offer "Connect workspace". **Storage:**
  access token (5 min) in memory only; the rotating refresh token in `sessionStorage` (this
  tab only, survives reload, gone when the tab closes, revoked at chat sign-out and by the
  portal at portal sign-out / password change); nothing in `localStorage`, cookies or URLs.
* **Validation for any resource server** (`apps/api/auth.py`):

```python
from apps.api.auth import TokenPolicy, authenticate_bearer

MCP_POLICY = TokenPolicy(name="mcp", resource=f"{settings.PUBLIC_BASE_URL}/mcp",
                         allowed_client_ids=None, realm="nexus-mcp")   # resource-bound tokens only
ctx = authenticate_bearer(request, policy=MCP_POLICY, scopes=["mcp:read"])
actor = access.actor_for(ctx.user, workspace_id, token=ctx)
```

  It checks the header (no URL tokens), a per-IP failure budget, hash/type/expiry in
  allauth's `Token` table, the audience (RFC 8707 resources stored on the token; tokens
  without resources only from `allowed_client_ids`), the account status, then scopes;
  failures are RFC 6750 responses. The MCP team adds its scopes to the client it registers
  and its policy next to its views; nothing else changes.

## 7. End-to-end encryption boundary (the product's core promise)

* Native chat messages and call media are end-to-end encrypted in the browser. **The
  server, the API, the AI assistant and the MCP connector cannot read them, and nothing in
  Nexus changes that.**
* CRM links to conversations store **identifiers only**: `ConversationLink.room_id/event_id`,
  `Activity.room_id/event_id` (kind `message_link`), `CalendarEvent.matrix_room_id`.
* The server-side AI and the MCP connector work on business records only (through
  `access`), never on Matrix content. External content (`untrusted=True`) is data, never
  instructions.
* **"Save to record"** (a later team, in the SPA only): a person selects already-decrypted
  text in a conversation and explicitly saves a copy as a note. That copy is no longer
  end-to-end encrypted; the UI must say so at the moment of saving. It is allowed only when
  `OrgSettings.save_to_record_enabled` (feature `save_to_record`) is on, which owners/admins
  set in the portal and which is **off by default**. No automatic or bulk export of chat.

## 8. Features, profiles and plans

* A workspace becomes a business workspace when an owner/admin picks business profiles
  (portal → Workspace → Settings → Business workspace, or `PATCH .../settings`). Enabling a
  profile creates its default pipeline.
* Plan entitlements (`config/plans.yml`, `billing.models.ENTITLEMENT_FIELDS`): `crm_enabled`,
  `crm_max_contacts`, `vertical_profiles` (real estate, lending). `lumen_bootstrap` adds new
  keys to stored plans without overwriting operator values. To add one: add it to
  `ENTITLEMENT_FIELDS`/`ENTITLEMENT_LABELS` and every plan in `plans.yml`.
* Feature flags returned to the SPA come from each app's `features.py`
  (`FEATURES = {key: fn(workspace, plan, org) -> bool}`); `@api_endpoint(feature=...)`
  enforces them.

## 9. Extension points (no shared files to edit)

| You add | File | Picked up by |
|---|---|---|
| Public routes (OAuth callbacks, webhooks) | `apps/<app>/urls.py` | mounted at `/<app>/` |
| API routes | `apps/<app>/api_urls.py` | mounted at `/api/v1/workspaces/<id>/<app>/` |
| Background jobs | `apps/<app>/jobs.py`: `JOBS = [(name, seconds, fn)]` | the worker (`lumen_worker`) |
| Feature flags | `apps/<app>/features.py` | `GET /workspaces/<id>` → `features` |
| Access policies | `access.register(...)` in your `AppConfig.ready()` | `for_actor`, references |
| A navigation area | `services/chat/src/workspace/areas/<id>.tsx` exporting `area = defineArea({...})` | auto-discovered (`import.meta.glob`) |
| A panel next to a conversation | the same kind of file exporting `roomPanel = defineRoomPanel({...})` | a button in the room header |

`integrations`, `assistant`, `mcp` and `automation` are registered in `INSTALLED_APPS`
(`settings.NEXUS_APPS`) and already have empty `urls.py`, `api_urls.py`, `jobs.py`,
`features.py` and `migrations/`.

### SPA areas

```tsx
// services/chat/src/workspace/areas/inbox.tsx (replace the coming-soon file)
import { Inbox } from "lucide-react";
import { defineArea } from "../define";
export const area = defineArea({
  id: "inbox", label: "Inbox", icon: Inbox, order: 20, status: "ready", feature: "integrations",
  summary: "One inbox for email and messages.", component: InboxPage,
});
```

Routes are `#/<id>/<sub/path>` (the component gets `path`); `#/`, `#/room/…`, `#/dm/…` stay
chat. Inside an area use `useWorkspace()` (`api`, `crm` base path, `workspace`, `members`,
`can()`, `hasFeature()`), `useApiResource(load, deps)`, `<ConnectionGate>` and the pieces in
`workspace/ui.tsx` (`PageHeader`, `EmptyState`, `ErrorState`, `LoadingState`, badges,
formatters). Errors are `ApiError` (`code`, `fields`, `field(name)`); show `describeError(e)`.
Visibility: `feature` and `capability` hide an area; `status: "coming_soon"` entries stay
listed with a "Coming in this test build" page — never sample data. Styles use tokens only
(`src/styles/workspace.css`), so light/dark and branding follow.

## 10. Branding and environments

* **Temporary test brand** "Nexus Office AI" (deep navy, charcoal, white, restrained
  electric blue, Inter): `settings.BRAND` defaults and `deploy/lib/render.py` defaults on this
  branch, `branding/logo.svg`, `favicon.svg`, `theme.css` (tokens only; `design/tokens.css`
  untouched). Revert = configuration.
* **`NEXUS_ENVIRONMENT`** = `production | test | development` (settings default
  `production`; installs of this branch render `test`). Non-production: persistent banner
  "Test environment · synthetic demo data" in the portal and the SPA, `[Test]` title prefix,
  `[Nexus · Test]` email subjects; every response carries `X-Nexus-Environment`.
* **Contrast** (WCAG 2.2 AA), measured by `python3 tests/nexus/brand_contrast.py`: 81 pairs
  (light and dark: text on every surface, links, buttons, badges, tags, banner, rail,
  avatars, gradient labels at ≥ 4.5:1; focus ring, bar fills, input and button outlines at
  ≥ 3:1) all pass; it also fails if the two dark-token copies in `theme.css` drift.

## 11. Demo data

`manage.py nexus_demo_seed` (idempotent: upserts by natural key) creates "Harborview Realty &
Lending (demo)" with general, real-estate and lending profiles on a manually assigned
Business plan, six demo people (`demo-avery` owner, `demo-morgan` manager, `demo-riley` and
`demo-jordan` agents, `demo-casey` team member, `demo-sam` read-only), contacts, tags,
custom fields, three pipelines, deals, tasks, timeline entries (one synthetic external
email marked untrusted) and events. Fictional names (Example, Sample, Placeholder…),
`@example.com/.org/.net`, `555-01xx` phones, `is_demo=True`. `manage.py nexus_demo_reset`
deletes only `is_demo` rows of demo-flagged workspaces, keeps demo rows that real rows
depend on (and their demo children), never touches accounts. Both refuse unless
`NEXUS_ENVIRONMENT` is `development` or `test`.

## Foundation status

See the final report in the hand-off and the commit history of
`test/unified-business-workspace`; test commands are in [DEVELOPMENT.md](DEVELOPMENT.md).
Known gaps at hand-off:

* No optimistic-concurrency check on updates (last write wins); no bulk endpoints.
* Calendar, Calls & Meetings, Inbox, AI Assistant, Reports, Integrations are coming-soon
  pages (the calendar *API* exists).
* The SPA's API calls are cross-origin (app domain → portal domain); a same-origin `/api`
  proxy on the app domain would remove CORS but is not set up.
* Members see the list of workspace members (needed for assignment pickers).
* Audit of contact detail reads writes one event per view (serialised through the audit
  chain's lock); fine for a test build, to be sampled or batched at scale.
