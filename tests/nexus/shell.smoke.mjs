/**
 * Browser smoke test of the Nexus workspace shell against the LOCAL test environment
 * (docs/nexus/DEVELOPMENT.md): portal dev server on 127.0.0.1:8710, chat SPA dev server on
 * 127.0.0.1:5710, homeserver lumen-chatdev-nexus on 127.0.0.1:28108, demo data seeded.
 *
 *   . dev/nexus/env.sh && node tests/nexus/shell.smoke.mjs [--no-shots]
 *
 * Signs in to the portal and to chat as demo people, lets the SPA obtain its API token
 * through the silent OAuth code + PKCE flow, and walks Home, Contacts (create, note),
 * CRM, Pipelines (keyboard move), Tasks (complete), the coming-soon areas, the CRM panel
 * next to a conversation, role-based navigation, light/dark and phone widths. Checks for
 * console errors, horizontal overflow and the environment banner on every page.
 * Screenshots: docs/nexus/screenshots/foundation/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SHOTS = path.join(REPO, "docs/nexus/screenshots/foundation");
const PORTAL = process.env.NEXUS_PORTAL_URL || "http://127.0.0.1:8710";
const APP = process.env.NEXUS_APP_URL || "http://127.0.0.1:5710";
const HS = process.env.NEXUS_HS_URL || "http://127.0.0.1:28108";
const PASSWORD = process.env.NEXUS_DEMO_PASSWORD;
const shots = !process.argv.includes("--no-shots");
if (!PASSWORD) throw new Error("source dev/nexus/env.sh first (NEXUS_DEMO_PASSWORD)");
fs.mkdirSync(SHOTS, { recursive: true });

// Start from the seeded demo state (reset deletes only demo rows; seed refills them).
if (!process.argv.includes("--keep-data")) {
  const py = path.join(process.env.NEXUS_VENV || "/home/user/nexus-venv", "bin/python");
  for (const cmd of ["nexus_demo_reset", "nexus_demo_seed"]) {
    execFileSync(py, ["manage.py", cmd], { cwd: path.join(REPO, "services/portal"), stdio: ["ignore", "ignore", "inherit"] });
  }
}

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const browser = await chromium.launch();

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 8).join("\n     ")}`);
  }
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function newContext({ viewport = DESKTOP, scheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
  ctx.problems = [];
  // The first-run "set up secure backup" prompt would cover the pages under test.
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem("lumen-security-prompt-dismissed", "1");
    } catch {
      /* ignore */
    }
  });
  ctx.on("page", (p) => watch(p, ctx.problems));
  return ctx;
}

// A reload aborts the Matrix /sync long-poll; the SDK logs that as an error.
const IGNORED = [/sync \/sync error %s ConnectionError: fetch failed/, /Download the React DevTools/, /\[vite\]/, /Failed to load resource: the server responded with a status of 404 \(Not Found\)/, /favicon/];
function watch(page, problems) {
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORED.some((re) => re.test(m.text()))) problems.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
}

function takeProblems(ctx) {
  return ctx.problems.splice(0);
}

async function shot(page, name) {
  if (!shots) return;
  // Earlier steps' confirmations would cover the page being documented.
  const close = page.locator(".toast-close");
  for (let n = await close.count(); n > 0; n--) await close.first().click().catch(() => undefined);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
}

async function portalLogin(page, username) {
  await page.goto(`${PORTAL}/accounts/login/`);
  if (!new URL(page.url()).pathname.startsWith("/accounts/login")) return; // already signed in
  await page.fill("input[name=login]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/portal\//), page.locator("form button[type=submit]").first().click()]);
}

/** Portal session + Matrix password sign-in; the SPA then fetches its API token silently. */
async function signIn(ctx, username) {
  const page = await ctx.newPage();
  await portalLogin(page, username);
  await page.goto(`${APP}/`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // completeLogin -> silent authorize -> /oauth/callback -> resume the stored session
  await page.waitForSelector(".ws-rail, .ws-bottom", { timeout: 60_000 });
  return page;
}

async function go(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

async function checkBanner(page) {
  const banner = page.locator(".env-banner").first();
  await banner.waitFor();
  assert.match(await banner.innerText(), /Test environment\s*·\s*synthetic demo data/);
  assert.match(await page.title(), /^\[Test\] /);
}

// --- 1. portal: branding, banner, header -------------------------------------------------------
const owner = await newContext();
await test("portal is branded and shows the test environment", async () => {
  const page = await owner.newPage();
  const r = await page.goto(`${PORTAL}/accounts/login/`);
  assert.equal(r.headers()["x-nexus-environment"], "test");
  await checkBanner(page);
  assert.match(await page.title(), /Nexus Office AI/);
  await shot(page, "portal-login--desktop-light");
  await portalLogin(page, "demo-avery");
  await checkBanner(page);
  assert.ok(await page.getByRole("link", { name: /Open workspace/ }).first().isVisible());
  await shot(page, "portal-dashboard--desktop-light");
  await page.close();
  assert.deepEqual(takeProblems(owner), []);
});

// --- 2. SPA: sign-in, silent OAuth, Home ----------------------------------------------------------
let app;
await test("chat sign-in, then the workspace connects silently (code + PKCE)", async () => {
  const login = await owner.newPage();
  await login.goto(`${APP}/`);
  await checkBanner(login);
  await login.getByRole("heading", { name: "Sign in" }).waitFor();
  await shot(login, "spa-login--desktop-light");
  await login.close();
  app = await signIn(owner, "demo-avery");
  assert.equal(new URL(app.url()).pathname, "/");
  assert.ok(!app.url().includes("code="), "authorization code left in the URL");
  const stored = await app.evaluate(() => ({ local: JSON.stringify(localStorage), session: Object.keys(sessionStorage) }));
  assert.ok(!/nexus-oauth/.test(stored.local), "OAuth state in localStorage");
  assert.ok(stored.session.includes("nexus-oauth-rt"), "no refresh token for this tab");
  await checkBanner(app);
});

await test("Home dashboard shows real data", async () => {
  await go(app, "#/home");
  await app.getByRole("heading", { name: "Today's tasks" }).waitFor();
  await app.locator(".ws-stat-value").first().waitFor();
  assert.ok((await app.locator(".ws-bars li").count()) >= 5, "pipeline summary bars");
  assert.ok((await app.locator(".ws-timeline li").count()) >= 1, "recent activity");
  assert.match(await app.locator(".ws-page-titles h1").innerText(), /Good (morning|afternoon|evening), Avery/);
  await noOverflow(app);
  await shot(app, "home--desktop-light");
});

await test("navigation lists every area; coming-soon areas say so", async () => {
  const labels = await app.locator(".ws-rail-label").allInnerTexts();
  for (const l of ["Home", "Inbox", "Chat", "Calls & Meetings", "Contacts", "CRM", "Pipelines", "Tasks", "Calendar", "AI Assistant", "Reports", "Integrations", "Settings"]) {
    assert.ok(labels.includes(l), `missing nav entry ${l}`);
  }
  for (const id of ["inbox", "calls", "calendar", "assistant", "reports", "integrations"]) {
    await go(app, `#/${id}`);
    await app.getByText("Coming in this test build").waitFor();
  }
  await shot(app, "coming-soon-assistant--desktop-light");
  await go(app, "#/");
  await app.locator(".sidebar").waitFor();
  assert.ok(await app.locator(".ws-rail-item.active", { hasText: "Chat" }).isVisible());
});

// --- 3. Contacts ------------------------------------------------------------------------------------
await test("Contacts: search, detail with timeline, create, add a note", async () => {
  await go(app, "#/contacts");
  await app.getByRole("heading", { name: "Contacts" }).waitFor();
  await app.locator(".ws-record").first().waitFor();
  await app.getByLabel("Search contacts").fill("Harper");
  await app.waitForFunction(() => document.querySelectorAll(".ws-record").length === 1);
  assert.match(await app.locator(".ws-record").innerText(), /Harper Sample/);
  await app.locator(".ws-record", { hasText: "Harper Sample" }).click();
  await app.getByRole("heading", { name: "Harper Sample" }).waitFor();
  await app.locator(".ws-timeline .ws-tl-item").first().waitFor();
  await shot(app, "contact-detail--desktop-light");
  // keyboard: arrow keys move through the list
  await app.getByLabel("Search contacts").fill("");
  await app.locator(".ws-record").nth(2).waitFor();
  await app.locator(".ws-record").first().focus();
  await app.keyboard.press("ArrowDown");
  assert.equal(await app.evaluate(() => document.activeElement?.classList.contains("ws-record")), true);
  // create
  await app.getByRole("link", { name: "New", exact: true }).click();
  await app.getByRole("heading", { name: "New contact" }).waitFor();
  await app.getByRole("button", { name: "Create contact" }).click();
  await app.getByText("Check the highlighted fields.").waitFor(); // validation from the API
  assert.equal(await app.evaluate(() => document.activeElement?.getAttribute("aria-invalid")), "true");
  await shot(app, "contact-form-error--desktop-light");
  // The browser logs the API's intended 400 for the empty form; nothing else may be there.
  assert.deepEqual(takeProblems(owner).filter((p) => !/status of 400/.test(p)), []);
  await app.getByLabel("First name").fill("Quentin");
  await app.getByLabel("Last name").fill("Smoketest");
  await app.getByLabel("Email").fill("quentin.smoketest@example.com");
  await app.getByLabel("Phone").fill("+1 (202) 555-0199");
  await app.getByLabel("Buyer", { exact: true }).check();
  await app.getByRole("button", { name: "Create contact" }).click();
  await app.getByRole("heading", { name: "Quentin Smoketest" }).waitFor();
  await app.locator(".toast", { hasText: "Contact created" }).waitFor();
  await app.getByLabel("Summary").fill("Smoke-test call");
  await app.getByRole("button", { name: "Add to timeline" }).click();
  await app.locator(".ws-tl-summary", { hasText: "Smoke-test call" }).waitFor();
  // clean up: delete it again (confirm dialog)
  app.once("dialog", (d) => void d.accept());
  await app.getByRole("button", { name: "Delete" }).click();
  await app.locator(".toast", { hasText: "Contact deleted" }).waitFor();
  await app.getByText("Select a contact").waitFor();
  assert.deepEqual(takeProblems(owner), []);
});

// --- 4. CRM and Pipelines -------------------------------------------------------------------------------
await test("CRM deals list and detail", async () => {
  await go(app, "#/crm");
  await app.getByRole("heading", { name: "Deals" }).waitFor();
  await app.locator(".ws-record").first().click();
  await app.locator("#deal-title").waitFor();
  await app.locator(".ws-history li").first().waitFor();
  await shot(app, "crm-deals--desktop-light");
});

await test("Pipelines: kanban, keyboard move between stages", async () => {
  await go(app, "#/pipelines");
  await app.locator(".ws-column").first().waitFor();
  const firstCol = app.locator(".ws-column").first();
  const card = firstCol.locator(".ws-deal-body").first();
  const name = await card.locator(".ws-deal-name").innerText();
  await shot(app, "pipelines--desktop-light");
  await card.focus();
  await app.keyboard.press("Alt+ArrowRight");
  await app.locator(".ws-column").nth(1).locator(".ws-deal-name", { hasText: name }).waitFor();
  await app.waitForTimeout(400);
  await app.reload();
  await app.locator(".ws-column").nth(1).locator(".ws-deal-name", { hasText: name }).waitFor({ timeout: 30_000 });
  // and back with the Move menu
  await app.locator(".ws-column").nth(1).locator(".ws-deal", { hasText: name }).getByRole("button", { name: `Move ${name}` }).click();
  const firstStage = await app.locator(".ws-column-header h2").first().innerText();
  await app.getByRole("menuitem", { name: `Move to ${firstStage}` }).click();
  await app.locator(".ws-column").first().locator(".ws-deal-name", { hasText: name }).waitFor();
  await app.getByRole("button", { name: "Stages" }).click();
  await app.getByRole("dialog").getByText(/Stages of/).waitFor();
  await shot(app, "pipeline-stages-dialog--desktop-light");
  await app.keyboard.press("Escape");
  assert.deepEqual(takeProblems(owner), []);
});

// --- 5. Tasks -------------------------------------------------------------------------------------------
await test("Tasks: add, complete, team list, delete", async () => {
  await go(app, "#/tasks");
  await app.getByRole("heading", { name: "Tasks" }).waitFor();
  const title = `Smoke-test follow-up ${Date.now()}`;
  await app.getByRole("textbox", { name: "New task" }).fill(title);
  await app.getByRole("button", { name: "Add task" }).click();
  await app.locator(".toast", { hasText: "Task added" }).waitFor();
  const row = app.locator(".ws-task-row", { hasText: title });
  await row.waitFor();
  await shot(app, "tasks--desktop-light");
  await row.getByRole("checkbox").check();
  await app.locator(".toast", { hasText: "Task completed" }).waitFor();
  await app.locator(".ws-task-row.done", { hasText: title }).waitFor();
  await go(app, "#/tasks/team");
  await app.locator(".ws-tabs a[aria-current=page]", { hasText: "Team tasks" }).waitFor();
  await app.locator(".ws-task-row").first().waitFor();
  await app.getByRole("button", { name: "Done", exact: true }).click();
  await app.locator(".ws-task-row", { hasText: title }).getByRole("button", { name: `Delete task ${title}` }).click();
  await app.locator(".toast", { hasText: "Task deleted" }).waitFor();
  assert.deepEqual(takeProblems(owner), []);
});

// --- 6. Room CRM panel ---------------------------------------------------------------------------------
await test("CRM panel next to a conversation: link a contact, see summary; only the room ID is stored", async () => {
  // A conversation of Avery's, created through the client-server API.
  const login = await (await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: "demo-avery" }, password: PASSWORD }),
  })).json();
  const room = await (await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.access_token}` },
    body: JSON.stringify({ name: "Harper - Gull Lane", preset: "private_chat", initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] }),
  })).json();
  assert.ok(room.room_id, JSON.stringify(room));
  await fetch(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${login.access_token}` } });
  await go(app, `#/room/${encodeURIComponent(room.room_id)}`);
  await app.locator(".room-header").waitFor({ timeout: 30_000 });
  await app.getByRole("button", { name: "CRM", exact: true }).click();
  await app.getByText("Not linked to a record").waitFor();
  await app.getByLabel("Find a contact or deal to link").fill("Harper");
  await app.locator(".ws-picker button", { hasText: "Harper Sample" }).click();
  await app.locator(".ws-room-card").getByText("Open tasks").waitFor();
  await app.getByText("Only this conversation's room ID is saved").waitFor();
  await shot(app, "room-crm-panel--desktop-light");
  await app.getByRole("button", { name: "Unlink this contact" }).click();
  await app.getByText("Not linked to a record").waitFor();
  assert.deepEqual(takeProblems(owner), []);
});

await test("Settings: workspace, features, token storage", async () => {
  await go(app, "#/settings");
  await app.getByRole("heading", { name: "Workspace" }).waitFor();
  await app.getByText("Harborview Realty & Lending (demo)").first().waitFor();
  await shot(app, "settings--desktop-light");
});

// --- 7. Dark mode, desktop -------------------------------------------------------------------------------
await test("dark theme, desktop", async () => {
  const ctx = await newContext({ scheme: "dark" });
  const page = await signIn(ctx, "demo-morgan");
  await go(page, "#/home");
  await page.getByRole("heading", { name: "Today's tasks" }).waitFor();
  await page.locator(".ws-stat-value").first().waitFor();
  await shot(page, "home--desktop-dark");
  await go(page, "#/pipelines");
  await page.locator(".ws-deal-body").first().waitFor();
  await shot(page, "pipelines--desktop-dark");
  await go(page, "#/contacts");
  await page.locator(".ws-record", { hasText: "Drew Testcase" }).click();
  await page.getByRole("heading", { name: "Drew Testcase" }).waitFor();
  await page.locator(".ws-timeline .ws-tl-item").first().waitFor();
  await shot(page, "contact-detail--desktop-dark");
  const portal = await ctx.newPage();
  await portal.goto(`${PORTAL}/portal/dashboard/`);
  await shot(portal, "portal-dashboard--desktop-dark");
  assert.deepEqual(takeProblems(ctx), []);
  await ctx.close();
});

// --- 8. Roles: read-only and agent views ------------------------------------------------------------------
await test("read-only person: no create controls, Reports hidden", async () => {
  const ctx = await newContext();
  const page = await signIn(ctx, "demo-sam");
  await go(page, "#/contacts");
  await page.locator(".ws-record").first().waitFor();
  assert.equal(await page.getByRole("link", { name: "New", exact: true }).count(), 0);
  const labels = await page.locator(".ws-rail-label").allInnerTexts();
  assert.ok(!labels.includes("Reports"), "Reports is managers-only");
  await page.locator(".ws-record").first().click();
  await page.locator(".ws-detail-header h2").waitFor();
  assert.equal(await page.getByRole("link", { name: "Edit" }).count(), 0);
  await go(page, "#/pipelines");
  await page.locator(".ws-deal-body").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "New deal" }).count(), 0);
  assert.equal(await page.locator(".ws-deal[draggable=true]").count(), 0);
  await ctx.close();
});

// --- 9. Phone width, light and dark ------------------------------------------------------------------------
for (const scheme of ["light", "dark"]) {
  await test(`phone width (${scheme}): bottom bar, More sheet, list -> detail`, async () => {
    const ctx = await newContext({ viewport: PHONE, scheme });
    const page = await signIn(ctx, "demo-riley");
    assert.equal(await page.locator(".ws-rail").count(), 0);
    await go(page, "#/home");
    await page.getByRole("heading", { name: "Today's tasks" }).waitFor();
    await page.locator(".ws-stat-value").first().waitFor();
    await noOverflow(page);
    await shot(page, `home--phone-${scheme}`);
    await page.locator(".ws-bottom").getByRole("link", { name: "Contacts" }).click();
    await page.locator(".ws-record").first().waitFor();
    await noOverflow(page);
    await shot(page, `contacts--phone-${scheme}`);
    await page.locator(".ws-record").first().click();
    await page.getByRole("link", { name: "Back to contacts" }).waitFor();
    await page.locator(".ws-timeline, .ws-section").first().waitFor();
    await noOverflow(page);
    await shot(page, `contact-detail--phone-${scheme}`);
    await page.locator(".ws-bottom").getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "All areas" }).waitFor();
    await shot(page, `more-sheet--phone-${scheme}`);
    await page.getByRole("dialog", { name: "All areas" }).getByRole("link", { name: /Pipelines/ }).click();
    await page.locator(".ws-deal-body").first().waitFor();
    await noOverflow(page);
    await shot(page, `pipelines--phone-${scheme}`);
    await page.locator(".ws-bottom").getByRole("link", { name: "Chat" }).click();
    await page.locator(".sidebar").waitFor();
    await noOverflow(page);
    await shot(page, `chat--phone-${scheme}`);
    assert.deepEqual(takeProblems(ctx), []);
    await ctx.close();
  });
}

await test("workspace pages show a connect state when the API session ends", async () => {
  await app.evaluate(() => sessionStorage.removeItem("nexus-oauth-rt"));
  await app.reload();
  await app.locator(".ws-rail").waitFor({ timeout: 60_000 });
  // reload in the same tab: no refresh token, auto-attempt already used -> connect state
  await go(app, "#/contacts");
  await app.getByRole("button", { name: "Connect workspace" }).waitFor();
  await shot(app, "connect-state--desktop-light");
  await app.getByRole("button", { name: "Connect workspace" }).click();
  await app.locator(".ws-record").first().waitFor({ timeout: 60_000 }); // portal session -> straight back
  assert.deepEqual(takeProblems(owner), []);
});

await owner.close();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
