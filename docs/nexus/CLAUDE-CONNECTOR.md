# Nexus Office AI: the Claude connector (MCP) and the in-app AI assistant

Nexus has two separate AI surfaces. They share one tool registry and one permission model,
but they are configured, billed and trusted differently:

| | Claude connector (MCP) | In-app AI assistant |
|---|---|---|
| Where the model runs | In the person's own Claude (claude.ai, Claude Desktop, Claude Code), under their own Claude plan | In Nexus: the portal calls a model provider (`AI_PROVIDER`) with the installation's API key |
| What Nexus provides | An MCP server at `https://<primary domain>/mcp` with OAuth sign-in | The **AI Assistant** area, **Ask AI** on contacts and next to conversations |
| Who confirms changes | The person, in Claude, when Claude calls `confirm_action` (annotated destructive, so Claude asks first) | The person, with the **Confirm** button in Nexus. The in-app model can't confirm anything |
| Configuration | `NEXUS_MCP_ENABLED=true`, then each workspace allows it | `AI_PROVIDER`, `AI_MODEL`, secret `ai_api_key` |

**Connecting Claude does not give the in-app assistant a model.** MCP lets Claude use Nexus;
it does not let Nexus use Claude. Without `AI_PROVIDER=anthropic` (plus a model ID and a key),
the in-app assistant runs in development mode (labelled *"Development mode: no AI model
connected"*) or, in production, is unavailable.

Both surfaces work only on server-side business records the person may see. **Neither can read
end-to-end encrypted chat messages**, open lending documents, send email, post to Slack or
change anything in an external system.

## 1. The connector URL

```
https://<LUMEN_PRIMARY_DOMAIN>/mcp
```

It is `NEXUS_MCP_RESOURCE`, by default `PUBLIC_BASE_URL + "/mcp"`, and it must match the URL
people paste into Claude exactly, path included. The portal serves the discovery documents:

| URL | What |
|---|---|
| `POST /mcp` | Streamable HTTP, JSON responses, stateless (no session ID). `GET` and `DELETE` answer 405 |
| `/.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 Protected Resource Metadata: `resource`, `authorization_servers` (the portal), `scopes_supported` |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata (allauth's, extended): S256, `iss` support, `none` auth, the MCP scopes, `registration_endpoint`, `client_id_metadata_document_supported` |
| `/identity/o/authorize`, `/identity/o/api/token`, `/identity/o/api/register`, `/identity/o/api/revoke` | Authorization, token (form-encoded), Dynamic Client Registration, revocation |

**Reachability.** Claude connects to custom connectors from Anthropic's egress range
**160.79.104.0/21** over public HTTPS. The primary domain therefore needs a public, valid
certificate, and nothing in front of it (firewall, office-only allow-list, VPN) may block that
range. Claude Code connects from the person's own computer instead.

## 2. Enabling it

Operator (`lumen.conf`, then `sudo ./lumenctl apply`):

```ini
NEXUS_MCP_ENABLED=true
#NEXUS_MCP_EXTRA_REDIRECT_URIS=https://client.example.com/oauth/callback   # optional allow-list
```

While it is off, Caddy answers 404 for `/mcp` and `/.well-known/oauth-protected-resource*` at the
edge, and the portal does too.

Workspace owner or admin: in Nexus, open **Settings → AI and connectors** and turn on
**"Members may connect Claude (MCP connector)"**. It is off by default for every workspace.
**Settings → Connected apps** shows the connector URL and the steps, and lists connections.
Each person sees their own connections there. Owners and admins can also show and revoke
everyone's.

All variables are listed in [CONFIG.md](CONFIG.md#ai-assistant-and-claude-connector-team-b3).

## 3. OAuth: what happens when someone connects

The operator registers nothing: Claude registers itself.

1. Claude calls `/mcp` without a token. The answer is **401** with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"`.
   A missing header never counts against the per-IP failure budget, because many people
   share Claude's egress addresses.
2. Claude reads the RFC 9728 and RFC 8414 metadata, then registers:
   * **CIMD.** The client ID is an HTTPS URL of a client metadata document, for example
     Claude Code's `https://claude.ai/oauth/claude-code-client-metadata`. Nexus fetches it
     itself, with SSRF protection: public addresses only, the connection pinned to the
     vetted IP, no redirects, size and time limits, caching. It refuses documents whose
     `client_id` doesn't match or that aren't public clients.
   * **DCR** (RFC 7591) otherwise: public clients (`none`) or `client_secret_post`. Only
     MCP scopes are allowed. It is rate-limited per IP, unused registrations are capped and
     deleted after `NEXUS_MCP_DCR_UNUSED_DAYS`, and every registration is audited.
   * **Redirect policy** (both paths): Claude's callbacks `https://claude.ai/api/mcp/auth_callback`
     and `https://claude.com/api/mcp/auth_callback`; loopback `http://127.0.0.1:<any port>/…`
     and `http://localhost:<any port>/…` (Claude Code; set
     `NEXUS_MCP_ALLOW_LOOPBACK_REDIRECTS=false` to refuse them); and exact matches from
     `NEXUS_MCP_EXTRA_REDIRECT_URIS`. Anything else is refused at registration.
3. **Authorization.** The request needs PKCE **S256** (plain is refused) and exactly one
   `resource`, the connector URL (RFC 8707). `prompt=none` never skips consent for MCP
   clients. The person signs in to Nexus and sees the **consent screen**:
   * the app's name and the host it returns to;
   * a warning when that is only a program on this computer (loopback);
   * the permissions, which they can narrow (`mcp:read` *Read your records* and
     `mcp:write` *Prepare changes for your confirmation*);
   * the workspace the connection may use, chosen when they belong to several.

   The answer carries `iss` (RFC 9207).
4. **Tokens.** Access tokens last 5 minutes and are bound to the connector URL. **Tokens for
   `/mcp` are refused at `/api/v1` and the SPA's `nexus-web` tokens are refused at `/mcp`.**
   Refresh tokens rotate on every use and last `NEXUS_MCP_REFRESH_TOKEN_SECONDS` (14 days).
   Reusing an old refresh token revokes the whole connection (`invalid_grant`, audited as a
   security event). Revocation (RFC 7009) and **Disconnect** in Connected apps end it at once.
5. Each request to `/mcp` checks the token, its audience, its scope, the account, the
   workspace membership and that the workspace still allows the connector. It applies a
   per-person rate limit (`NEXUS_MCP_REQUESTS_PER_MINUTE`, default 120) and validates
   `Origin` and `MCP-Protocol-Version`. A missing scope gives **403** with
   `error="insufficient_scope"`.

Protocol versions: **2026-07-28** (stateless, `_meta` on each request, `server/discover`,
`tools/list` with `ttlMs`) and, through `initialize`, **2025-11-25, 2025-06-18 and 2025-03-26**.
Only tools are offered: no resources, prompts, sampling or elicitation.

## 4. Adding it in Claude

**claude.ai or Claude Desktop:** open the Connectors settings and choose **Add custom
connector**. Paste `https://<your primary domain>/mcp` and leave the OAuth client ID and secret
empty. Choose **Connect**, sign in to Nexus and approve. Each person signs in to Nexus
themselves; a connection only ever has that person's rights.

**Claude Code:**

```sh
claude mcp add --transport http nexus https://<your primary domain>/mcp
# then, inside Claude Code: /mcp  → nexus → Authenticate (opens the browser; returns to a localhost port)
```

The same steps are shown in Nexus under **Settings → Connected apps**.

## 5. Tools

Every tool runs **as the person who connected**, through `apps.crm.access`. A tool sees exactly
the records that person sees in Nexus, in the one workspace the connection is bound to.
Inputs are validated against the published JSON Schema before anything runs, and outputs are
checked against the output schema. Results carry links to the records
(`APP_BASE_URL/#/…`). Tools of a feature the workspace hasn't enabled are not listed.

`mcp:read` lists the read tools. `mcp:write` adds the `prepare_*` tools, `suggest_next_step`,
`confirm_action` and `cancel_action` (write implies read).

| Tool | Scope | Needs | What it does |
|---|---|---|---|
| `get_workspace_context` | read | CRM | Who you act as, role, features, current time |
| `search_contacts`, `get_contact_summary` | read | CRM | Contacts, and one contact's details, tasks, next meeting, timeline and deals. Sensitive custom fields are hidden unless allowed (§6) |
| `get_opportunity`, `pipeline_overview` | read | CRM | A deal and its stage history; deals per stage and stuck deals |
| `list_my_tasks`, `team_outstanding_tasks` | read | CRM | Your tasks; the team's open tasks you may see |
| `upcoming_appointments`, `overdue_followups`, `leads_not_contacted_since` | read | CRM | Calendar, late follow-ups, stale leads |
| `search_activities`, `daily_activity_summary`, `weekly_activity_summary` | read | CRM | Server-side timeline only. Chat messages are E2EE and the tool says so |
| `approaching_deadlines`, `meeting_action_items`, `team_week_report` | read | CRM (+ reports role for the week report) | Transaction deadlines; last meeting's notes and action items; team pipeline week |
| `lending_applications_missing_documents`, `deals_waiting_on_documents`, `get_lending_application`, `lending_pipeline_report` | read | Lending profile + lending role | Checklist item **names, statuses and due dates only**. Never document contents, never decisions. Amounts only with the sensitive opt-in |
| `search_properties`, `matching_properties`, `viewings`, `draft_viewing_confirmation` | read | Real-estate profile | Imported listings are labelled. The viewing confirmation is a **draft text only**: not stored, not sent |
| `search_email`, `get_email_thread`, `list_inbox` | read | Integrations; your own mailbox | Live Gmail search and thread reading (texts cut at 3,000 characters, last 8 messages, attachments never opened). **All untrusted** |
| `search_slack_messages`, `search_highlevel_contacts`, `list_highlevel_opportunities` | read | Integrations | Stored Slack messages of connected channels; HighLevel lookups. **Read only, untrusted** |
| `prepare_create_task`, `prepare_update_contact_fields`, `prepare_change_deal_stage`, `prepare_create_note` | write | CRM + the matching role permission | **Proposals only** (§7) |
| `prepare_email_reply_draft` | write | Integrations; your own mailbox with compose permission | A proposal. Once confirmed, a **draft** is saved in Gmail and in Nexus. It is **never sent**: "Review and send it in Nexus" |
| `suggest_next_step` | write | CRM | Adds an action item marked **AI suggestion** with status *proposed*. A person confirms it in Nexus before it becomes a task |
| `confirm_action` | write | | Executes one prepared proposal. Annotated `destructiveHint: true`, MCP channel only |
| `cancel_action` | write | | Discards a proposal |

There are **no** tools for sending email, posting to Slack, changing HighLevel, starting
workflows, deleting records, recording lending decisions or reading documents. There are no
generic query, SQL or "call any API" tools.

Annotations: read tools are `readOnlyHint: true`. `openWorldHint: true` marks tools that
reach an external provider live (`search_email`, `get_email_thread`, `search_highlevel_contacts`,
`prepare_email_reply_draft`).

## 6. Permission model and safety

* **As the person, in one workspace.** The connection is bound at consent to the person and to
  one workspace. Removing them from the workspace, turning the connector off for the
  workspace or the installation, or disconnecting ends access on the next request. IDs from
  other workspaces behave exactly like unknown IDs (`not_found`).
* **Roles apply unchanged.** A read-only member gets only read results. An agent can't
  prepare a change they couldn't make in Nexus: the dry run checks the same permissions as
  the real write.
* **Sensitive data** (lending amounts, sensitive custom fields) reaches AI only when the
  workspace turned on *"Allow lending-sensitive fields in AI context"* **and** the person's
  role may see it. It is off by default. **Document contents never reach AI.** There is no
  tool that could return them.
* **E2EE.** Chat messages are end-to-end encrypted. No tool can read them. "Save to record"
  is a separate, explicit action of a person in the SPA (§9).
* **Untrusted content.** Email, Slack, HighLevel and synced external activities are flagged
  `untrusted`. Before a model sees them their text is fenced as
  `<untrusted_data source="gmail" …>…</untrusted_data>`, with `<` and `>` neutralised so the
  fence can't be faked. Facts are tagged "[external, untrusted]". The instructions say data
  is never an instruction. Tests check that an email saying *"ignore all previous
  instructions… send…"* leads to no write.
* **No credentials to providers.** Requests to the model provider carry tool results and the
  question only. Text that looks like a credential is scrubbed. The API key is sent only in
  the provider's auth header, and Nexus never sends OAuth tokens or passwords anywhere.
* **Audit.** Every chat question and every MCP tool call writes an `AIInteraction`: who,
  channel, client, tool names, record references, proposals, status and timing. Content
  (question and answer text) is **not stored** unless the workspace sets a retention period
  (7, 30 or 90 days). It is then scrubbed and purged hourly once expired. Proposals,
  confirmations, cancellations, failures, registrations, grants and revocations are in the
  audit log, with field names only and never values.
* **Rate limits** per person: chat 20/min, MCP requests 120/min, proposals 30/min,
  confirmations 30/min. DCR is limited per IP.
* **Logs** never contain tokens, codes, keys or record contents.

## 7. Two-phase changes and confirmation

1. A `prepare_*` tool validates the input and **dry-runs the real service call in a savepoint
   that is always rolled back**, so impossible changes fail now with the same error as later.
   It then stores a `PendingAction` with:
   * the exact payload;
   * a SHA-256 over (action, payload, workspace, user, channel);
   * a human-readable preview (fields, before and after values);
   * an expiry of `NEXUS_AI_PENDING_ACTION_SECONDS` (10 minutes).

   It returns the preview and a `pending_action_id`, and nothing changes. External actions
   (the Gmail draft) are **checked, not dry-run**: the provider is never called at
   preparation.
2. **Over MCP**, Claude shows the preview and calls `confirm_action` only after the person
   agrees. Claude's own permission prompt applies, because the tool is destructive.
   **In Nexus**, the person presses **Confirm** on the proposal card. The in-app model is not
   offered `confirm_action` at all.
3. `confirm_action` locks the row. It must belong to this person, workspace, channel and (for
   MCP) the same client, otherwise it doesn't exist for them. It must still be pending (a
   second confirm is a conflict) and unexpired, and the payload hash must match. The write
   then runs through the CRM services as the person, who is authorised again at that moment.
   For external actions the row is claimed and committed first, and the provider call runs
   outside any transaction. Either way it can never run twice. Failures mark the row
   `failed` with an error code, and nothing is retried automatically.

## 8. The in-app assistant's model (Anthropic API)

```ini
AI_PROVIDER=anthropic
AI_MODEL=<a current Claude model ID>     # required; Nexus has no default model on purpose
```

```sh
sudo ./lumenctl set-secret ai_api_key    # hidden input; stored as a Docker secret file
sudo ./lumenctl apply
```

The portal calls `POST {AI_API_BASE_URL}/v1/messages` (default `https://api.anthropic.com`).
It sends `x-api-key` and `anthropic-version: 2023-06-01`, the tools of §5 that the person may
use (without `confirm_action`/`cancel_action`), the system rules and the conversation. It runs
up to `AI_MAX_TOOL_ROUNDS` tool rounds.

It handles the `tool_use`, `end_turn`, `max_tokens` (tools from a cut-off turn are never run),
`refusal` and `pause_turn` stop reasons. It retries once on 429/5xx with `retry-after`.
Authentication, model and request errors are shown to people as plain messages, and request
and response bodies are never logged.

Answers keep **"Verified facts from records"** (written by the tools, with links) apart from
the model's text (**"AI suggestion · check before acting"**). Without a model, development mode
shows only the facts and says so.

## 9. "Save to record" from a conversation (SPA)

In the room CRM panel, people can select decrypted text messages and save a copy as a note on
the contact or deal the conversation is linked to. This needs:
* the feature `save_to_record` (`OrgSettings.save_to_record_enabled`, off by default, toggled
  by owners and admins in **Settings → AI and connectors**);
* the right to add timeline entries;
* the target linked to that room.

The panel and the saved note both say that the copy is stored in the workspace and is **no
longer end-to-end encrypted**, while the conversation itself stays encrypted. Only selected
messages are copied, at most 18,000 characters. The audit records the count, never the text.

## 10. Test results (observed on 2026-10-17, branch `test/unified-business-workspace`)

**Mock-based** pytest (Django test client; providers are fakes, no network):

| Suite | Result | Covers |
|---|---|---|
| `tests/test_nexus_mcp.py` | 34 passed | Discovery, DCR policy and limits, CIMD with a fake fetcher and SSRF refusals, consent (redirect host, loopback warning, workspace choice), PKCE, `resource`, `prompt=none`, `iss`, refresh rotation and reuse detection, expiry and revocation, separated audiences, scopes, 401/403 headers, legacy and 2026-07-28 protocol, transport rules, tenant isolation, prompt injection |
| `tests/test_nexus_assistant.py` | 38 passed | Registry and schemas, tools as the actor, sensitive gate, invalid inputs, two-phase writes (single use, binding, expiry, tamper), dev provider, Anthropic provider wire format and errors (**mock HTTP session**), injection, AIInteraction, retention, nothing sensitive in logs, Save to record |
| `tests/test_nexus_assistant_verticals.py` | 9 passed | Lending without amounts or documents, sensitive opt-in, roles, deadlines, properties (imports labelled), viewings, draft-only confirmation, last meeting and AI-suggested next step, team report, dev chains |
| `tests/test_nexus_assistant_integrations.py` | 11 passed | Gmail/Slack/HighLevel tools on B2's **fake providers**: personal mail owner-only, other-workspace IDs, untrusted fencing, injected email triggers nothing (dev and mocked model), drafts two-phase and never sent, failure recorded, MCP read and confirm |
| `tests/test_nexus_isolation.py` (AI part) | passed | AI endpoints and objects of another workspace are 404, chat context and Save to record reject foreign IDs, tools never return other workspaces' rows |
| `tests/deploy/test_render_apps.py::TestNexusAi` | 3 passed | `app.env` settings, no key in it, edge 404 when off, invalid settings refused |
| Whole portal suite | 805 passed, 1 failed | The failure is `test_nexus_meetings_reports.py::test_home_sections_and_connected_services_slot` (the verticals team's test still expects no connected-services list, which the integrations team now provides). It's not in B3 code and was reported to main |
| SPA `npm test` (vitest, jsdom) | 142 passed | Includes `test/unit/assistant.test.tsx` (13): history building, facts vs AI text, dev label, source links, proposals and Confirm, Save to record payloads and message list, connector steps, the confirmation message with its draft link |
| SPA `typecheck`, `lint`, `build` | clean | |

**Browser smoke** (Playwright against the slot-3 dev servers, development provider):
`tests/nexus/assistant.smoke.mjs` **8/8 passed**. It covers the assistant, a proposal and
Cancel, Ask AI on a contact, the AI settings and Connected apps, Ask AI and Save to record in
a conversation's CRM panel, the connector's consent screen, and phone dark mode. Screenshots
are in [screenshots/b3/](screenshots/b3/), each under 300 KB. The foundation's
`tests/nexus/shell.smoke.mjs` passed 16/16 on the same servers after the assistant left the
coming-soon list.

**Live, local** protocol conformance with the **official MCP Python SDK** as the client, against
the slot-3 dev runserver (`http://127.0.0.1:8713`). The SDK did discovery, DCR, PKCE S256,
`resource` and `iss` validation itself; the script only signed in and pressed "Allow access":

| SDK | Result | Evidence |
|---|---|---|
| `mcp` 2.3.0, modern (2026-07-28) and legacy (2025-11-25) modes | 28/28 passed | [evidence/b3/mcp-sdk-2.3.0-conformance.json](evidence/b3/mcp-sdk-2.3.0-conformance.json), [log](evidence/b3/mcp-sdk-2.x-conformance.log), [pip freeze](evidence/b3/mcp-sdk-2.3.0.freeze.txt) |
| `mcp` 1.30.0 (2025-11-25), localhost redirect | 15/15 passed | [evidence/b3/mcp-sdk-1.30.0-conformance.json](evidence/b3/mcp-sdk-1.30.0-conformance.json), [log](evidence/b3/mcp-sdk-1.x-conformance.log), [pip freeze](evidence/b3/mcp-sdk-1.30.0.freeze.txt) |

Re-run: see the docstring of `tests/nexus/mcp_sdk_conformance.py`. Without the SDK it prints
`SKIPPED` and exits with 77; it never reports a pass it didn't check.

**Not tested: a real Claude connection.** Claude reaches connectors from Anthropic's egress
range 160.79.104.0/21 over public HTTPS, and this sandbox's local runserver isn't reachable
from there. The Anthropic Messages API was also not called live (no API key here). Its tests
use a mock HTTP session.

## 11. What remains

* Connect a real Claude (claude.ai and Claude Code) to a deployed test server with a public
  certificate, and record the result.
* Run the in-app assistant against the Anthropic API with a real key and a current model ID.
* The SPA links `#/inbox/<id>`, `#/properties/<id>` and `#/lending/<id>` assume the routes
  of the inbox and verticals areas. They are documented for those teams.
* Token refresh through the SDK (it refreshes only after expiry) and the 403 step-up flow are
  covered by pytest, not by the SDK script.
* MCP `resources`, `prompts` and server-to-client requests are not offered.
