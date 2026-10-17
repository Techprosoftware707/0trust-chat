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
| AI tools | `apps/<app>/ai_tools.py`: `TOOLS = [Tool(...)]` (see `apps/assistant/registry.py`) | the in-app assistant and the Claude connector ([CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md)) |
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

## 12. Verticals, automation, calendar, meetings and reports (team B1)

Code: `apps/crm/models_verticals.py`, `models_meetings.py`, `policies_verticals.py`, the
service modules below, `api_verticals.py` (views), `serializers_verticals.py`; the
`apps.automation` app; SPA areas `properties`, `lending`, `calendar`, `calls`, `reports`,
`notifications`, `automations` and the shared pieces in `services/chat/src/workspace/verticals/`.
Migrations: `crm.0002_verticals_meetings_event_kind`, `crm.0003_pipeline_stage_restrict`,
`automation.0001_initial`.

### Data model (all `TenantModel`s, all registered with a policy)

| Model | Key fields | Notes |
|---|---|---|
| `Property` | address, city/region/postcode/country, `listing_type`, `property_type`, `status` (prospect, coming_soon, active, under_contract, sold, leased, withdrawn, off_market), price, beds/baths/area, `owner`, `visibility`, `source` (manual default, `import`, `integration`) + `source_label` | Never invented, never "MLS": `source` says where a row came from; demo rows say "(fictional)" |
| `PropertyContact` | property ↔ contact with a role (seller, buyer, landlord, tenant, interested, other) | |
| `OpportunityProperty` | deal ↔ property with a role (listing, purchase, considering, other) | |
| `ClientPreference` | one per contact: listing type, budget range, areas, property types, minimum beds/baths/area, must-haves, nice-to-haves, timeline, move-by date, notes | Used by `matching_properties` (only the workspace's own properties) |
| `CalendarEvent.kind` | meeting (default), viewing, call, closing, appointment, other | A viewing is a `CalendarEvent(kind="viewing", related=crm.property)` |
| `Milestone` | `category` (milestone, deadline), `milestone_type` (offer_submitted, counter_offer, offer_accepted, negotiation, inspection, appraisal, financing, title, closing, disclosures, conditions, rate_lock, documents, …), `due_date`, `status` (pending, done, waived, missed), amount, responsible; on a deal **or** an application (DB constraint) | Urgency `overdue` / `due_soon` (`NEXUS_DEADLINE_SOON_DAYS`) / `upcoming` computed server-side |
| `LendingApplication` | `reference` (unique per workspace), own pipeline (kind `lending`) and stage, `loan_officer` (the assigned broker), `product_type`, `amount_requested`, `status`, optional deal/property, target close, `decision` (`""`, approved, conditional, declined) + note/by/at | Pipeline and stage `RESTRICT`; decisions are recorded by staff only |
| `ApplicationBorrower`, `LendingStageHistory` | borrowers (contact + role borrower, co_borrower, guarantor), stage moves | |
| `ApplicationNote` | `visibility` staff (everyone working on the application), managers, private (author + managers) | Internal; never sent to borrowers or AI |
| `ChecklistTemplate` | product type, ordered `items` (name, category, required) | Defaults per product created on demand |
| `DocumentChecklistItem` | name, category, required, `status` (pending, requested, received, accepted, rejected, waived), requested/received/reviewed by and at, linked task | Outstanding = pending, requested, rejected (required items) |
| `SecureDocument` | name, content type, size, `sha256`, `storage_name`, `key_id`, `wrapped_key` | Metadata only; ciphertext on disk (below) |
| `DocumentDownloadGrant`, `DocumentAccessLog` | single-use grant (user, document, expiry, used_at); log (upload, grant, download, denied, delete + reason) | Log readable by managers+ only |
| `MeetingNote` | event/contact/deal/room ID, title, body, `visibility` (team, attendees, private) | `room_id` is an identifier only |
| `ActionItem` | note/event/contact/deal, title, suggested assignee/due, `status` (proposed, confirmed, dismissed), `source` (manual, ai_suggestion), decided by/at, `task` | Becomes a `Task` only when a person confirms it |

`Opportunity.pipeline/stage` became `RESTRICT` (was `PROTECT`) so deleting a workspace
cascades again; deleting a pipeline or stage that still has deals or applications is a
`409 conflict` from the API.

### Capabilities and who sees what

| Capability | Roles | Grants |
|---|---|---|
| `lending.access` | owner, admin, manager, agent | the Lending area; agents see and work on **only applications assigned to them** (`loan_officer`) |
| `lending.sensitive` | owner, admin, manager | every application, the document access log |
| `lending.decide` | owner, admin, manager | record a decision (`POST .../decision` with `"confirm": true`) |
| `automation.manage` | owner, admin, manager | rules, execution history, manual retry |
| `reports.view` | owner, admin, manager | the Reports area (team-wide aggregates) |

Team members and read-only people have no lending access at all (404 on every lending ID).
Properties, milestones, preferences, meeting notes and action items follow the record rules
of section 2 (owner/assignee/visibility; children follow their parent). Reports aggregate
`for_actor()` querysets only, so nobody gets a number built from rows they can't see.

### Secure lending documents

* Upload: raw request body (the file's own `Content-Type`, name in `X-Nexus-Filename`),
  read into memory up to `NEXUS_DOCUMENT_MAX_MB`; allow-list PDF, JPEG, PNG, TIFF, DOCX,
  XLSX, checked against the leading bytes; never a temporary file.
* Encryption (`apps/crm/documents.py`): a fresh AES-256-GCM data key per document, AAD =
  workspace + document ID; the data key is stored wrapped by the master key from the secret
  file `NEXUS_DOCUMENT_KEY_FILE` (several keys = rotation, first encrypts). Ciphertext files
  in `NEXUS_SECURE_DOCUMENTS_DIR` (0700/0600, random names); the portal refuses a directory
  inside or containing a static, template, media or branding path. Deleting a row deletes
  its file after commit; where the directory isn't mounted the leftover file is unreadable
  because its only wrapped key went with the row.
* Download: `POST .../documents/<id>/download-token` (lending access + view on the
  application) returns a signed token bound to user, workspace, document and expiry
  (`NEXUS_DOCUMENT_TOKEN_SECONDS`, 60 s) backed by a single-use grant row; `POST
  .../documents/download` with the token **in the body** re-checks membership and access at
  redemption and streams `Content-Disposition: attachment`, `nosniff`, `no-store`.
  Expired, reused, tampered or other-user tokens get `403 permission_denied`; access revoked
  since the grant, or a token of another workspace, gets 404. Every refusal is audited
  (`crm.securedocument.download_refused` with a reason) and, when the document is known,
  logged as `denied`.
* Every upload, grant, download, refusal and delete is in the access log and the audit
  chain (field names and IDs only). Contents never reach logs, search, notifications,
  automation payloads, reports or AI tools. **No virus scanning** in this build.
* Not configured → `503 not_configured` ("Secure document storage isn't set up").

### Automation

* `engine.emit(workspace_id, event_type, subject=, dedup_key=, payload=, actor=)` runs on
  `transaction.on_commit`; one `AutomationEvent` per (workspace, type, dedup key) and one
  `AutomationExecution` per (workspace, dedup key = event + rule): the same fact never runs
  a rule twice.
* Triggers: `contact.created`, `lead.created`, `task.overdue`, `appointment.upcoming`,
  `opportunity.stage_changed`, `action_item.proposed`. Conditions: `field` +
  `equals | not_equals | in | contains` on the trigger's listed fields (all must match).
* Actions (internal only): `assign_owner`, `create_task`, `notify_user` (in-app),
  `update_related_tasks`. They run as the rule's owner (who last saved it) through
  `apps.crm.access`, are audited and need that person to still hold `automation.manage`.
* Loop protection: depth (`NEXUS_AUTOMATION_MAX_DEPTH`), a rule never runs on events its
  own actions caused, per-rule `max_runs_per_hour`, per-workspace
  `NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR` (statuses `loop_blocked`, `rate_limited`).
* Failures: `retrying` with backoff 1, 5, 30 minutes (worker job `automation.retries`), then
  `failed`; manual retry from the history; errors are stored without record contents.
* Worker jobs (`apps/automation/jobs.py`): `overdue_tasks` and `appointment_reminders`
  (every 5 min; reminders `NEXUS_AUTOMATION_REMINDER_MINUTES` ahead), `retries` (1 min),
  `retention` (hourly, `NEXUS_AUTOMATION_RETENTION_DAYS`). `manage.py nexus_automation_scan`
  runs the scans once (tests, demos).
* Notifications are in-app only (`Notification`, grouped by `group_key`), with per-user and
  per-workspace `NotificationPreference` (mute, mute until, grouping, per-event switches).

### Calendar, calls and meetings

* Agenda, day and week views on `GET crm/events` (filters `from`, `to`, `kind`,
  `attending=me`). A meeting's room is a Matrix room the **browser** creates
  (`createGroup`, encrypted) and stores as `matrix_room_id`; joining uses the room's
  existing MatrixRTC call. Internal invitations only (workspace members); invitations to
  external people wait for the Gmail integration.
* Calls & Meetings: upcoming meetings from the server; **recent calls are read in the
  browser** from the chat client's call events and never sent to the server. "Link to
  record" posts an `Activity(kind="call")` with the room and event IDs and what the person
  typed.
* No recording or transcription exists, and nothing records silently; the UI says so.
* **On the record's timeline** (final integration): a team-visible event linked to a contact or
  deal adds one system entry there ("Meeting scheduled: …", "Viewing scheduled: …", `kind=meeting`,
  `related=crm.calendarevent`), and team-visible meeting notes add one with their title and text
  (`kind=note`, `related=crm.meetingnote`). `services.sync_event_timeline` / `sync_note_timeline`
  keep each entry in step with its event or note (title, status, contact/deal), attribute it to
  the event's creator or the notes' author, and remove it when the event turns private, the notes
  become attendee-only or private (or their meeting turns private), or either is deleted
  (`signals.py`). The SPA links these entries to the meeting ("Open meeting").

### Reports and Home

Server-side, under `reports.view`: `reports/pipeline` (by stage, value and owner),
`reports/team-week`, `reports/activity`, `reports/tasks`, `reports/lending` (checklist
status; `available: false` without the lending feature), `reports/deadlines`. Home's `dashboard` gains
`meetings_today`, `approaching_deadlines`, `applications_missing_documents` (`null` without
lending access), `suggested_next_steps` and `connected_services`. Each of its `assigned_leads`
carries `next_task` (final integration): the earliest open task on that lead the viewer may see
(`id`, `title`, `due_at`, `is_overdue`, `assignee`), shown on Home as "Next: … · due …", so a
follow-up task created by an automation is visible there and not "No follow-up set".

**Connected-service health slot.** `home.connected_services(actor)` calls every installed
app's `health.py` → `service_health(actor)` (found with `nexus_modules("health")`) and
returns their rows, or `null` when no app provides one. Rows follow the integrations
contract: `service`, `label`, `status` (connected, needs_reauth, error, not_connected,
not_configured), `status_label`, `detail`, `checked_at`, `link`, `mock`, `mock_label`. The
hook must not make network calls; a provider that raises is skipped. Home shows the mock
label whenever `mock` is true.

### API routes (under `/api/v1/workspaces/<id>/`)

`crm/`: `properties[/<id>[/contacts|/viewings]]`, `property-contacts/<id>`,
`opportunities/<id>/(vertical|properties|contact-roles|deadline-template)`,
`opportunity-properties/<id>`, `contacts/<id>/(preferences|vertical)` (preferences: GET,
PUT, PATCH), `milestones[/<id>]`, `lending/applications[/<id>[/move|/decision|/history|
/notes|/checklist[/apply-template]|/deadline-template|/documents|/access-log]]`,
`lending/board`, `lending/notes/<id>`, `lending/checklist/<id>[/request]`,
`lending/documents/<id>[/download-token]`, `lending/documents/download`,
`lending/templates[/<id>]`, `meetings/upcoming`, `meetings/notes[/<id>]`,
`action-items[/<id>[/confirm|/dismiss]]`, `reports/(pipeline|team-week|activity|tasks|
lending|deadlines)`. `automation/`: `catalog`, `rules[/<id>]`, `executions[/summary]`,
`executions/<id>/retry`, `notifications[/<id>]`, `notifications/unread-count`,
`notifications/read-all`, `preferences[/workspace]`. Every route uses `@api_endpoint` and
the error and pagination formats of section 5; CORS gained the `X-Nexus-Filename` header.

### Services other teams may call

All take an `Actor` and enforce access themselves; writes take the `request` for the audit
entry and must run inside the caller's transaction (`@api_endpoint` provides one).

| Module | Functions |
|---|---|
| `apps.crm.realestate` | `create_property`, `update_property`, `search_properties`, `link_property_contact`, `link_opportunity_property`, `set_opportunity_contact_role`, `get_preferences`, `save_preferences`, `matching_properties`, `schedule_viewing`, `viewings`, `create_milestone`, `update_milestone`, `apply_deadline_template` (`DEADLINE_TEMPLATES`: purchase, listing, lending), `milestones_for`, `milestone_urgency`, `approaching_deadlines` |
| `apps.crm.lending` | `create_application`, `update_application`, `move_application`, `record_decision` (staff, `confirm: true`), `search_applications`, `visible_application`, `checklist_progress`, `outstanding_work`, `applications_missing_documents`, `create_note`, `update_note`, `add_checklist_item`, `update_checklist_item`, `apply_checklist_template`, `request_document` (creates the task; nothing is sent to the borrower), `create_template`, `update_template`, `template_for`, `ensure_default_templates`, `upload_document`, `delete_document`, `issue_download`, `redeem_download`, `access_log` |
| `apps.crm.documents` | `is_configured`, `check_upload`, `seal`, `open_sealed` (download view only), `remove_sealed` |
| `apps.crm.meetings` | `create_meeting_note`, `update_meeting_note`, `propose_action_item` (`source="ai_suggestion"` for AI), `confirm_action_item` (creates the task), `dismiss_action_item`, `update_action_item`, `upcoming_meetings` |
| `apps.crm.reports` | `pipeline_report`, `team_week`, `activity_report`, `task_report`, `lending_report`, `deadlines_report` |
| `apps.crm.home` | `home_extras`, `connected_services` |
| `apps.automation.engine` | `emit` (with the `*_facts` helpers for payloads), `run_due_retries` |
| `apps.automation.notifications` | `notify(workspace, recipient, event_type=, title=, body=, link=, related=, group_key=)` (in-app, honours preferences), `notifications_for`, `unread_count`, `mark_read`, `mark_all_read`, `effective_preferences`, `update_preferences` |
| `apps.automation.services` | `catalog`, `create_rule`, `update_rule`, `retry_execution`, `execution_summary`, `seed_example_rules` |

The AI tools on these services are in `apps/crm/ai_tools_verticals.py` (team B3).

## 13. Integrations and the unified inbox (team B2)

`apps.integrations` (migration `integrations.0001_initial`) and the SPA areas **Inbox**
(`areas/inbox.tsx`) and **Integrations** (`areas/integrations.tsx`). Provider setup, scopes,
storage, retention and what is tested are in [INTEGRATIONS.md](INTEGRATIONS.md); variables are
in [CONFIG.md](CONFIG.md#integrations-and-the-unified-inbox-team-b2). Feature flag:
`integrations` (on wherever `crm` is on).

### Models (all `TenantModel` unless noted, all behind `access` policies)

| Model | What it is | Who sees it |
|---|---|---|
| `IntegrationConnection` | one connected Gmail mailbox, Slack workspace or HighLevel sub-account: status (`connected`, `needs_reauth`, `error`, `disconnected`), granted scopes, sync and error state, `is_mock` | Gmail: its owner (owners/admins see status only); Slack/HighLevel: every member |
| `IntegrationCredential` (not tenant, no API) | AES-256-GCM access/refresh tokens bound to their row and field, key ID, version | only `tokens.py` |
| `OAuthState` (not tenant) | one authorization in progress: hashed nonce, session-binding hash, encrypted PKCE verifier, 10-minute expiry, single use | nobody |
| `WebhookEvent` (not tenant) | dedup record `(provider, event_id)` and outcome, no payload | nobody |
| `InboxItem` | one synced external item: email thread, Slack message, HighLevel conversation, missed call; priority, assignee, labels, done; `visibility` personal (Gmail) or workspace | personal items: only the owner, not even admins; workspace items: record readers |
| `InboxReadState`, `InboxMute`, `PendingAction` | per-person read marks, muted groups (`matrix:<room>`, `nexus:notification:<type>`, provider groups), confirmations for external writes | the person only |
| `InboxLink` | item ↔ record (contact, opportunity, task, …), optional timeline `Activity` | like the item |
| `EmailMessage`, `EmailDraft` | Gmail message metadata (never bodies); reply drafts (text cleared after send) | the mailbox owner |
| `ExternalRecord` | mirrors of HighLevel opportunities, pipelines, tags, custom fields, opened contacts | record readers |

Dedup and linking to CRM records use `crm.ExternalRecordMapping`
(`{account}:thread:{id}`, `{channel}:{ts}`, HighLevel IDs); a HighLevel contact matches a Nexus
contact **only** by its HighLevel ID mapping; email/phone matches are suggestions a person
confirms.

### Routes

Public (`apps/integrations/urls.py`, under `/integrations/`): `oauth/begin` (needs the portal
session of the person who started), `oauth/{google,slack,crm-connector}/callback`,
`webhooks/slack/events`, `webhooks/gohighlevel` (CSRF-exempt, signature-checked, rate
limited), `mock/<slug>/authorize` (mock mode only). After a flow the browser returns to
`#/integrations/connected/<provider>` or `#/integrations/error/<code>[/<provider>]`.

API (`api_urls.py`, under `/api/v1/workspaces/<id>/integrations/`):

* Connections: `providers` (catalog with setup facts, never values), `connections`,
  `connections/oauth-start` (returns the portal `begin` URL), `connections/private-token`,
  `connections/<id>` (GET/PATCH settings), `…/sync`, `…/disconnect`, `…/slack-channels`.
* Inbox: `inbox` (filters `source`, `kind`, `unread`, `assignee=me|none|<public_id>`, `label`,
  `priority`, `status=open|done|all`, `q`, `linked=<type>:<id>`, `connection`, `muted=exclude|include|only`,
  `mentions=me`), `inbox/counts`, `inbox/mark`, `inbox/mutes[/<id>]`, `inbox/<id>` (GET/PATCH),
  `…/suggestions`, `…/links[/<link_id>]`, `…/permalink`, `…/conversation` (HighLevel
  messages, read-only), `…/drafts`, `…/messages/<mid>/body` (sanitized, on demand),
  `…/messages/<mid>/attachments/<aid>` (proxied download).
* Gmail: `gmail/search?q=` (live Gmail search), `drafts/<id>` (PATCH/DELETE),
  `drafts/<id>/send-request`.
* External writes: `slack/post-request`, `ghl/actions` (create/update contact, start a
  workflow), `actions/<id>` (GET/DELETE = cancel), `actions/<id>/confirm`.
* HighLevel: `ghl/contacts[?q=]`, `ghl/contacts/<ext>` (with tasks and appointments),
  `…/link`, `…/import`, `ghl/opportunities`, `ghl/opportunities/<ext>/link`, `ghl/pipelines`,
  `ghl/tags`, `ghl/custom-fields`, `ghl/workflows`.

Every item response carries `external: true`, `untrusted: true`, `origin`
(`synced_email`, `external_message`, `imported_record`, `external_notification`; never
`native`), `is_mock`/`mock_label`, `capabilities` (`reply`, with a reason when unsupported) and
`external_url`/`open_label` for linking out.

### Conventions added

* **Provider errors** map to: `reauth_required` 409 (the connection moved to
  `needs_reauth`), `not_configured` 409, `scope_missing` 403, `rate_limited` 429 with
  `Retry-After`, `not_found` 404, `provider_unavailable` 502, `provider_rejected` 400, and
  provider-specific 400/403 codes (e.g. `slack_not_in_channel`) — `errors.py`.
* **`@api_endpoint(atomic=False)`** on views that call a provider: a rotated refresh token
  must never be rolled back with the request; such views manage their own short transactions.
* **Two-step confirmation for every external write** (`actions.py`): a `*-request` call stores
  a `PendingAction` with a preview and returns a single-use `confirmation_token` once (hash
  stored, 10 minutes, bound to the person and the exact payload; a changed draft invalidates
  it). `actions/<id>/confirm {confirmation_token}` spends the token atomically *before*
  calling the provider; a wrong, used, expired or foreign token is `403 confirmation_invalid`.
  The result is "sent" only when the provider answered with the created ID; a timeout says
  "check your Sent folder" instead. The AI assistant never receives these tokens.
* **Mock mode** (`NEXUS_INTEGRATIONS_MOCK`, development/test only): in-process fake providers
  behind the same HTTP transport seam (`http.get_transport()`); everything they create is
  `is_mock` and labelled "Mock provider (development)".

### Services other teams may call

Plain functions; each one authorizes through `access` with the `actor` it is given (404 for
other people's or other workspaces' rows), audits, and never returns tokens. Synced content
is external and untrusted: pass it on as data, never as instructions.

| Function | Returns / does |
|---|---|
| `health.service_health(actor)` | one row per provider: `{service, label, status (connected/needs_reauth/error/not_connected/not_configured), status_label, detail, checked_at, link, mock, mock_label}` (Home's connected-services card) |
| `services.list_inbox(actor, limit=50, **filters)` / `services.inbox_queryset(actor, …)` | serialized items / the authorized queryset (filters as in the `inbox` endpoint) |
| `services.get_inbox_item(actor, item_id)` | one item with messages and drafts |
| `services.counts(actor)` | `{unread, unread_by_source}` |
| `services.get_thread(actor, item_id, include_bodies=False)` | a Gmail thread's metadata |
| `services.message_body(request, actor, item_id, message_id)` | the sanitized body (fetched from Gmail, not stored; audited read) |
| `services.search_email(actor, query, connection_id=None, limit=20)` | live Gmail search (`q` syntax) through the person's own mailbox |
| `services.create_reply_draft(request, actor, item_id, body)` / `update_draft` / `discard_draft` | a reply draft in Gmail (never sends) |
| `services.list_slack_messages(actor, channel_id=None, q=None, limit=50)`, `slack_channels`, `slack_permalink` | synced Slack messages, channels, a permalink |
| `services.ghl_search_contacts(actor, query, …)`, `ghl_get_contact`, `ghl_list_records(actor, kind, …)`, `ghl_list_opportunities`, `ghl_conversation`, `ghl_workflows` | HighLevel reads (live or mirrored) |
| `services.add_link` / `remove_link` / `item_suggestions` / `contact_suggestions` | links between items and records, and suggested contacts (by email/phone, suggestions only) |
| `services.update_item`, `mark_read`, `add_mute`, `remove_mute` | inbox state |
| `actions.prepare_send_draft`, `prepare_slack_post`, `prepare_ghl` → `(PendingAction, token)`; `actions.confirm`, `actions.cancel` | the confirmation flow above; only a UI that shows the preview to the person may call `confirm` |

`apps/integrations/ai_tools.py` (team B3) uses these read and draft services.

### SPA

* `#/inbox`, `#/inbox/<item uuid>` (and `#/inbox/item|room|notification|meeting/<id>`) open
  the unified inbox; `#/integrations[/connected/<p>|/error/<code>]` the setup page.
* `workspace/integrations/merge.ts` (pure, unit-tested) merges, in the browser, native rooms
  from the Matrix client (decrypted previews never leave the device; only room IDs are sent,
  for links and mutes), synced items, workspace notifications and meeting follow-ups.
* `workspace/integrations/ui.tsx` exports reusable pieces: `SourceBadge`, `MockBadge`,
  `ExternalNote`, `SafeHtmlFrame` (sandboxed iframe, `default-src 'none'`),
  `ConfirmActionDialog` (shows the preview, spends the token), `RecordPicker`, `StatusBadge`.
* The inbox detail embeds B3's `AskAiPanel` with `context.inbox_item_id`.
* **Add a HighLevel lead to Nexus** (final integration): a HighLevel conversation or missed call
  whose contact isn't linked to a Nexus contact offers "Add <name> to Nexus" to people who may
  create contacts (`highLevelContactToAdd` in `merge.ts`). It calls `ghl/contacts/<id>/import`, then
  links the item to the new contact. The import creates the contact like any other (so
  `contact.created` and `lead.created` automations run, and the importer is the owner unless a
  rule reassigns it), adds an untrusted `integration_event` entry "Imported from HighLevel as a
  new contact" (no human actor; `last_activity_at` untouched), and flags contacts from the mock
  provider `is_demo`. Nothing is written to HighLevel.

## Foundation status

See the final report in the hand-off and the commit history of
`test/unified-business-workspace`; test commands are in [DEVELOPMENT.md](DEVELOPMENT.md).
Known gaps at hand-off:

* No optimistic-concurrency check on updates (last write wins); no bulk endpoints.
* Calendar, Calls & Meetings, Inbox, AI Assistant, Reports, Integrations are coming-soon
  pages (the calendar *API* exists). Since then Calendar, Calls & Meetings and Reports have
  shipped (section 12), and Inbox and Integrations (section 13).
* The SPA's API calls are cross-origin (app domain → portal domain); a same-origin `/api`
  proxy on the app domain would remove CORS but is not set up.
* Members see the list of workspace members (needed for assignment pickers).
* Audit of contact detail reads writes one event per view (serialised through the audit
  chain's lock); fine for a test build, to be sampled or batched at scale.
