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
  this branch must not touch, so it is left failing and reported.
* **Chat UI suite (`npm run test:ui`)**: one run had "sign out wipes local data" time out
  waiting for the signed-out notice; the immediate re-run passed 23/23. The workspace
  sign-out hook is a no-op without a `workspace` block in the chat config (as in that suite),
  so this looks like timing in the suite rather than this branch; worth watching.
* **ruff** has no configuration in this repository and CI does not run it; the Nexus Python
  code is clean under `E,F,W,I` (command in DEVELOPMENT.md). Ruff's wider default set reports
  `RUF012` (mutable Django `Meta`/class attributes) here as it does in the existing apps.
