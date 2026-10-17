# Nexus Office AI: configuration reference

Settings are environment variables of the portal, read in `services/portal/lumen/settings.py`.
On a deployed server the operator sets the documented `lumen.conf` keys, `deploy/lib/render.py`
validates them and writes them to `app.env`, and secrets are Docker secret files (`<NAME>_FILE`)
set with `sudo ./lumenctl set-secret <name>`. A secret is never a plain environment variable
outside tests and local development (`LUMEN_ALLOW_ENV_SECRETS`). Each team documents its own
section here.

## AI assistant and Claude connector (team B3)

How it fits together is in [CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md).

### Set in `lumen.conf` (rendered to `app.env`)

| Key | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | empty: `none` in production, `dev` otherwise | The in-app assistant's model provider: `anthropic` (Messages API), `dev` (deterministic, no model, labelled "Development mode: no AI model connected"; refused in production by `render.py`) or `none` (assistant unavailable) |
| `AI_MODEL` | empty | **Required for `anthropic`.** A current Claude model ID from Anthropic's documentation. Nexus deliberately has no default model |
| `NEXUS_MCP_ENABLED` | `false` | The Claude connector at `https://<LUMEN_PRIMARY_DOMAIN>/mcp`. When off, Caddy and the portal answer 404 for `/mcp` and the protected-resource metadata, and registration is closed. Each workspace must also allow it (Settings → AI and connectors) |
| `NEXUS_MCP_EXTRA_REDIRECT_URIS` | empty | Extra OAuth redirect URIs that MCP clients may register, comma-separated, exact `https` URLs without query or fragment. Claude's own callbacks and loopback addresses are always allowed |

### Secret

| Secret file | Set with | Used for |
|---|---|---|
| `ai_api_key` (`AI_API_KEY_FILE`) | `sudo ./lumenctl set-secret ai_api_key` | The Anthropic API key, sent only as `x-api-key` to `AI_API_BASE_URL`. The installer creates it empty; empty means "no model" |

### Advanced (portal environment; defaults suit most installations)

| Variable | Default | Meaning |
|---|---|---|
| `AI_API_BASE_URL` | `https://api.anthropic.com` | Messages API base URL |
| `AI_MAX_TOKENS` | `4096` | `max_tokens` per model call |
| `AI_TIMEOUT_SECONDS` | `60` | Timeout of one model call |
| `AI_MAX_TOOL_ROUNDS` | `6` | Tool rounds per question before the assistant stops |
| `NEXUS_AI_CHATS_PER_MINUTE` | `20` | Assistant questions per person per minute |
| `NEXUS_AI_PREPARES_PER_MINUTE` | `30` | Proposed changes per person per minute (assistant and MCP) |
| `NEXUS_AI_CONFIRMS_PER_MINUTE` | `30` | Confirmations per person per minute |
| `NEXUS_AI_PENDING_ACTION_SECONDS` | `600` | How long a proposal can be confirmed |
| `NEXUS_MCP_RESOURCE` | `PUBLIC_BASE_URL + "/mcp"` | The connector URL and token audience (RFC 8707). Must equal what people paste into Claude |
| `NEXUS_MCP_REQUESTS_PER_MINUTE` | `120` | MCP requests per person per minute |
| `NEXUS_MCP_ALLOWED_ORIGINS` | portal and app origins, `https://claude.ai`, `https://claude.com` | Browser `Origin` values accepted at `/mcp` (requests without `Origin` are accepted) |
| `NEXUS_MCP_ALLOW_LOOPBACK_REDIRECTS` | `true` | Allow `http://127.0.0.1:<port>` and `http://localhost:<port>` callbacks (Claude Code). The consent screen warns about them |
| `NEXUS_MCP_DCR_ENABLED` | `true` | RFC 7591 Dynamic Client Registration at `/identity/o/api/register` |
| `NEXUS_MCP_REGISTRATIONS_PER_MINUTE` | `10` | Registrations per client IP per minute |
| `NEXUS_MCP_DCR_MAX_UNUSED` | `500` | Registrations that never got a token, kept at most (new ones are refused beyond that) |
| `NEXUS_MCP_DCR_UNUSED_DAYS` | `7` | Unused or idle self-registered clients are deleted after this many days |
| `NEXUS_MCP_CIMD_ENABLED` | `true` | Client ID Metadata Documents (HTTPS client IDs, e.g. Claude Code's) |
| `NEXUS_MCP_CIMD_ALLOWED_HOSTS` | empty (any public HTTPS host) | Restrict CIMD hosts, comma-separated |
| `NEXUS_MCP_CIMD_TIMEOUT_SECONDS` | `4` | Fetch timeout for a metadata document |
| `NEXUS_MCP_CIMD_MAX_BYTES` | `16384` | Maximum metadata document size |
| `NEXUS_MCP_CIMD_CACHE_SECONDS` | `3600` | Cache time when the document sets no `max-age` |
| `NEXUS_MCP_REFRESH_TOKEN_SECONDS` | `1209600` (14 days) | Lifetime of a connector's refresh tokens (they rotate on every use) |

### Workspace settings (owners and admins, Settings → AI and connectors)

| Setting | Default | Meaning |
|---|---|---|
| AI assistant for members | on | The in-app assistant (feature `assistant`) |
| Members may connect Claude | **off** | The connector for this workspace (feature `mcp`, also needs `NEXUS_MCP_ENABLED`) |
| Allow lending-sensitive fields in AI context | **off** | Amounts and sensitive fields reach AI only when this is on **and** the person's role may see them. Documents never do |
| Keep the text of AI conversations | don't keep | 0, 7, 30 or 90 days. The audit entry (who, tools, records) is always kept |
| Allow "Save to record" from chat | **off** | `OrgSettings.save_to_record_enabled`: copying selected decrypted messages into a note (no longer E2EE) |

### Background jobs (`manage.py lumen_worker`)

`assistant.purge_ai_content` (hourly), `assistant.expire_pending_actions` (every 10 minutes),
`mcp.cleanup_registrations` (hourly), `mcp.purge_rotated_refresh_tokens` (hourly) and
`mcp.purge_idle_grants` (every 6 hours).

## Integrations and the unified inbox (team B2)

Code: `services/portal/lumen/settings.py` ("Nexus integrations"), `apps/integrations/conf.py`.
In development `dev/nexus/env.sh` sets these as environment variables (secrets too, allowed by
`LUMEN_ALLOW_ENV_SECRETS=1`); pytest uses fixed test values from `lumen/test_settings.py`. On
installs, secrets are files in `/etc/lumen/secrets/` (root:secrets, `0440`) mounted at
`/run/secrets/<name>`. A variable marked "env only" is not rendered by the installer yet, so
installs use its default.
Setup per provider: [INTEGRATIONS.md](INTEGRATIONS.md). The Integrations page shows owners and
admins which of these are set (names only, never values).

| Variable | Kind | Install | Development | Default | Purpose |
|---|---|---|---|---|---|
| `NEXUS_INTEGRATIONS_KEY` | secret | file `nexus_integrations_key`, generated by the installer (`openssl rand -hex 32`); mounted into portal, worker and the `migrate` tool | `env.sh` sets a throwaway key | none: without it nothing can be connected | AES-256-GCM key(s) for provider tokens: 64 hex characters each, several separated by commas or newlines; the first encrypts, all decrypt |
| `NEXUS_INTEGRATIONS_MOCK` | bool | `lumen.conf` (default `false`); `render.py` refuses `true` with `NEXUS_ENVIRONMENT=production` | `env.sh` sets `1` (override with `NEXUS_INTEGRATIONS_MOCK=0`) | `false` | local fake providers labelled "Mock provider (development)"; the app also ignores it unless `NEXUS_ENVIRONMENT` is `development` or `test`, and system check `integrations.W001` warns |
| `NEXUS_GOOGLE_CLIENT_ID` | plain | `lumen.conf` | env | empty | Google OAuth web client ID (Gmail) |
| `NEXUS_GOOGLE_CLIENT_SECRET` | secret | `sudo ./lumenctl set-secret nexus_google_client_secret` | env | empty | Google client secret (portal and worker) |
| `NEXUS_SLACK_CLIENT_ID` | plain | `lumen.conf` | env | empty | Slack app client ID |
| `NEXUS_SLACK_CLIENT_SECRET` | secret | `set-secret nexus_slack_client_secret` | env | empty | Slack client secret (portal and worker) |
| `NEXUS_SLACK_SIGNING_SECRET` | secret | `set-secret nexus_slack_signing_secret` | env | empty | verifies Events API requests (`v0` HMAC); public portal only |
| `NEXUS_GHL_CLIENT_ID` | plain | `lumen.conf` | env | empty | HighLevel Marketplace app client ID (OAuth flow only; private integration tokens need nothing here) |
| `NEXUS_GHL_CLIENT_SECRET` | secret | `set-secret nexus_ghl_client_secret` | env | empty | HighLevel client secret (portal and worker) |
| `NEXUS_GHL_APP_ID` | plain | `lumen.conf` | env | empty | optional: with the `oauth.write` scope, Disconnect calls HighLevel's documented uninstall API |
| `NEXUS_GHL_API_VERSION` | plain, env only | default | env | `v3` | the `Version` header on HighLevel API calls |
| `NEXUS_GHL_WEBHOOK_PUBLIC_KEY` | plain, env only | default | env | the Ed25519 key published in HighLevel's Webhook Integration Guide | verifies `X-GHL-Signature`; change only if HighLevel publishes a new key |
| `NEXUS_INTEGRATIONS_SYNC_SECONDS` | int, env only | default | env | `300` | how often the worker syncs each connection (backoff after errors, `Retry-After` on 429) |
| `NEXUS_GMAIL_RETENTION_DAYS` | int, env only | default | env | `90` | synced Gmail metadata older than this is deleted (timeline entries created by linking stay) |
| `NEXUS_SLACK_RETENTION_DAYS` | int, env only | default | env | `30` | synced Slack messages older than this are deleted (timeline entries stay) |
| `NEXUS_GHL_RETENTION_DAYS` | int, env only | default | env | `90` | synced HighLevel conversations, missed calls and record mirrors older than this are deleted (timeline entries stay) |

Settings the integrations rely on from the foundation: `LUMEN_PUBLIC_BASE_URL` (redirect and
webhook URLs are built from it: `/integrations/oauth/{google,slack,crm-connector}/callback`,
`/integrations/webhooks/{slack/events,gohighlevel}`), `LUMEN_APP_BASE_URL` (where people
return after connecting) and `NEXUS_ENVIRONMENT`. The chat SPA needs no setting: it learns
what is available from the API (`GET .../integrations/providers`).

A provider counts as configured when its client ID and secret(s) are set (Slack also needs
the signing secret). GoHighLevel can always be connected with a private integration token
once `NEXUS_INTEGRATIONS_KEY` exists.

### Rotating the integrations key

1. `NEW=$(openssl rand -hex 32)`; put it **first** in `/etc/lumen/secrets/nexus_integrations_key`
   and keep the old key after it on a new line (keep the file's owner and mode `0440`).
2. `sudo ./lumenctl restart portal worker` — new tokens are encrypted with the new key, old
   ones still decrypt.
3. `sudo ./lumenctl manage nexus_integrations_rekey` — re-encrypts every stored credential with
   the new key (row-locked, so running syncs are safe) and prints counts only.
4. When it reports `failed 0`, remove the old key from the file and restart again.

Losing the key makes the stored tokens unreadable: syncs stop with the error "The stored
credentials can't be decrypted with the configured key" and people reconnect (OAuth) or paste
a new private integration token; synced items are unaffected.
