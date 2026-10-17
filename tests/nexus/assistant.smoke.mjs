/**
 * Browser smoke test of the AI assistant, "Ask AI", "Save to record", the AI settings and the
 * Claude connector's consent screen, against the LOCAL test environment of one slot
 * (docs/nexus/DEVELOPMENT.md; the portal must run with NEXUS_MCP_ENABLED=1 and the demo
 * workspace must allow the connector, see docs/nexus/CLAUDE-CONNECTOR.md).
 *
 *   NEXUS_SLOT=3 . dev/nexus/env.sh && NEXUS_PORTAL_URL=http://127.0.0.1:$NEXUS_PORTAL_PORT \
 *     NEXUS_APP_URL=http://127.0.0.1:$NEXUS_CHAT_PORT node tests/nexus/assistant.smoke.mjs [--no-shots]
 *
 * The assistant runs with the development provider (no AI model): every answer must carry the
 * "Development mode: no AI model connected" label and show only verified facts. Proposed
 * changes are canceled again, so the demo data stays as it was (except one encrypted test
 * conversation). Screenshots (each under 300 KB): docs/nexus/screenshots/b3/.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SHOTS = path.join(REPO, "docs/nexus/screenshots/b3");
const PORTAL = process.env.NEXUS_PORTAL_URL || "http://127.0.0.1:8710";
const APP = process.env.NEXUS_APP_URL || "http://127.0.0.1:5710";
const HS = process.env.NEXUS_HS_URL || "http://127.0.0.1:28108";
const PASSWORD = process.env.NEXUS_DEMO_PASSWORD;
const DEV = "Development mode: no AI model connected";
const shots = !process.argv.includes("--no-shots");
if (!PASSWORD) throw new Error("source dev/nexus/env.sh first (NEXUS_DEMO_PASSWORD)");
fs.mkdirSync(SHOTS, { recursive: true });

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
const DESKTOP = { width: 1280, height: 800 };
const IGNORED = [/sync \/sync error %s ConnectionError: fetch failed/, /Download the React DevTools/, /\[vite\]/, /Failed to load resource: the server responded with a status of 404 \(Not Found\)/, /favicon/];

async function newContext({ viewport = DESKTOP, scheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
  ctx.problems = [];
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem("lumen-security-prompt-dismissed", "1");
    } catch {
      /* ignore */
    }
  });
  ctx.on("page", (p) => {
    p.on("console", (m) => {
      if (m.type() === "error" && !IGNORED.some((re) => re.test(m.text()))) ctx.problems.push(`console: ${m.text().slice(0, 300)}`);
    });
    p.on("pageerror", (e) => ctx.problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  });
  return ctx;
}

async function shot(target, name) {
  if (!shots) return;
  const page = target.page ? target.page() : target;
  const close = page.locator(".toast-close");
  for (let n = await close.count(); n > 0; n--) await close.first().click().catch(() => undefined);
  const file = path.join(SHOTS, `${name}.png`);
  await target.screenshot({ path: file });
  const kb = fs.statSync(file).size / 1024;
  assert.ok(kb < 300, `${name}.png is ${kb.toFixed(0)} KB (limit 300 KB)`);
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
}

async function portalLogin(page, username) {
  await page.goto(`${PORTAL}/accounts/login/`);
  if (!new URL(page.url()).pathname.startsWith("/accounts/login")) return;
  await page.fill("input[name=login]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/portal\//), page.locator("form button[type=submit]").first().click()]);
}

async function signIn(ctx, username) {
  const page = await ctx.newPage();
  await portalLogin(page, username);
  await page.goto(`${APP}/`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector(".ws-rail, .ws-bottom", { timeout: 60_000 });
  return page;
}

async function go(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

// --- 1. the assistant area ----------------------------------------------------------------------------
const owner = await newContext();
let app;
await test("AI Assistant: development mode answers with verified facts only", async () => {
  app = await signIn(owner, "demo-avery");
  await go(app, "#/assistant");
  await app.getByRole("heading", { name: "AI Assistant" }).waitFor();
  await app.getByText("What would you like to know?").waitFor();
  assert.ok(await app.locator(".ws-rail-item", { hasText: "AI Assistant" }).isVisible());
  await app.getByRole("button", { name: "What are my tasks?" }).click();
  const card = app.locator(".ai-answer").last();
  await card.locator(".ai-facts").waitFor({ timeout: 30_000 });
  assert.match(await card.locator(".ai-mode").innerText(), new RegExp(DEV));
  assert.match(await card.innerText(), /Verified facts from records/i);
  assert.doesNotMatch(await card.innerText(), /AI suggestion/i);
  await app.getByLabel("Your question").fill("Pipeline overview");
  await app.getByRole("button", { name: "Send question" }).click();
  await app.locator(".ai-answer").nth(1).locator(".ai-facts").waitFor({ timeout: 30_000 });
  assert.ok((await card.locator(".ai-sources a[href^='#/']").count()) >= 1, "answers link to their records");
  await noOverflow(app);
  await shot(app, "assistant--desktop-light");
  assert.deepEqual(owner.problems.splice(0), []);
});

await test("AI Assistant: a proposed task waits for Confirm; Cancel changes nothing", async () => {
  await app.getByLabel("Your question").fill("Remind me to call Harper Sample tomorrow");
  await app.getByRole("button", { name: "Send question" }).click();
  const action = app.locator(".ai-action").last();
  await action.waitFor({ timeout: 30_000 });
  assert.match(await action.innerText(), /Proposed change/i);
  assert.match(await action.innerText(), /Nothing changes until you confirm/);
  await action.scrollIntoViewIfNeeded();
  await shot(app, "assistant-proposal--desktop-light");
  await action.getByRole("button", { name: "Cancel" }).click();
  await action.getByText("Canceled").waitFor();
  assert.deepEqual(owner.problems.splice(0), []);
});

// --- 2. Ask AI on a contact ------------------------------------------------------------------------------
await test("Ask AI on a contact: summary from the records, with the dev label", async () => {
  await go(app, "#/contacts");
  await app.getByLabel("Search contacts").fill("Harper");
  await app.waitForFunction(() => document.querySelectorAll(".ws-record").length === 1);
  await app.locator(".ws-record", { hasText: "Harper Sample" }).click();
  await app.getByRole("heading", { name: "Harper Sample" }).waitFor();
  await app.getByRole("button", { name: "Ask AI" }).click();
  const panel = app.locator(".ai-ask").first();
  await panel.getByRole("button", { name: "Summarise this contact" }).click();
  await panel.locator(".ai-facts").waitFor({ timeout: 30_000 });
  assert.match(await panel.innerText(), new RegExp(DEV));
  assert.match(await panel.innerText(), /Harper Sample/);
  await panel.scrollIntoViewIfNeeded();
  await shot(app, "ask-ai-contact--desktop-light");
  assert.deepEqual(owner.problems.splice(0), []);
});

// --- 3. settings -------------------------------------------------------------------------------------------
await test("Settings: AI and connectors, Connected apps", async () => {
  await go(app, "#/settings");
  const ai = app.locator("section[aria-labelledby=set-ai]");
  await ai.waitFor();
  await ai.getByText("Members may connect Claude (MCP connector)").waitFor();
  assert.equal(await ai.getByLabel(/Allow lending-sensitive fields/).isChecked(), false);
  assert.equal(await ai.getByLabel(/Allow “Save to record” from chat/).isChecked(), false);
  await ai.scrollIntoViewIfNeeded();
  await shot(ai, "settings-ai--desktop-light");
  const apps = app.locator("section[aria-labelledby=set-apps]");
  await apps.getByText("Add custom connector", { exact: false }).waitFor();
  assert.match(await apps.locator(".ai-url").innerText(), /\/mcp$/);
  await apps.scrollIntoViewIfNeeded();
  await shot(apps, "settings-connected-apps--desktop-light");
  // Turn "Save to record" on for the next test (turned off again at the end).
  await ai.getByLabel(/Allow “Save to record” from chat/).click(); // controlled: it changes once the API saved it
  await app.locator(".toast", { hasText: "“Save to record” is on" }).waitFor();
  assert.deepEqual(owner.problems.splice(0), []);
});

// --- 4. next to a conversation ------------------------------------------------------------------------------
await test("Room CRM panel: Ask AI and Save to record (copy is no longer E2EE)", async () => {
  const login = await (await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: "demo-avery" }, password: PASSWORD }),
  })).json();
  const room = await (await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.access_token}` },
    body: JSON.stringify({ name: "Harper - viewing (AI smoke)", preset: "private_chat", initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] }),
  })).json();
  assert.ok(room.room_id, JSON.stringify(room));
  await fetch(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${login.access_token}` } });
  await go(app, `#/room/${encodeURIComponent(room.room_id)}`);
  await app.locator(".room-header").waitFor({ timeout: 30_000 });
  await app.locator("#composer").fill("Harper asked to move the viewing to Tuesday at 10.");
  await app.getByRole("button", { name: "Send message" }).click();
  await app.getByText("Harper asked to move the viewing to Tuesday at 10.").first().waitFor();
  await app.getByRole("button", { name: "CRM", exact: true }).click();
  await app.getByLabel("Find a contact or deal to link").fill("Harper");
  await app.locator(".ws-picker button", { hasText: "Harper Sample" }).click();
  const card = app.locator(".ws-room-card");
  await card.locator(".ai-ask").getByRole("button", { name: "Summarise this contact" }).click();
  await card.locator(".ai-ask .ai-facts").waitFor({ timeout: 30_000 });
  assert.match(await card.innerText(), new RegExp(DEV));
  await app.getByRole("button", { name: "Save messages to the record" }).click();
  const picker = app.locator(".ai-save");
  await picker.waitFor();
  assert.match(await picker.innerText(), /no longer end-to-end encrypted/i);
  await picker.getByText("Harper asked to move the viewing to Tuesday at 10.").click();
  await picker.scrollIntoViewIfNeeded();
  await shot(app, "room-ai-and-save-to-record--desktop-light");
  await picker.getByRole("button", { name: "Cancel" }).click();
  await app.getByRole("button", { name: "Unlink this contact" }).click();
  await app.getByText("Not linked to a record").waitFor();
  assert.deepEqual(owner.problems.splice(0), []);
});

// --- 5. the connector's consent screen --------------------------------------------------------------------
await test("Claude connector consent: redirect host, loopback warning, scopes, workspace", async () => {
  const reg = await (await fetch(`${PORTAL}/identity/o/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code (smoke test)", redirect_uris: ["http://127.0.0.1:43123/callback"], grant_types: ["authorization_code", "refresh_token"],
                           response_types: ["code"], token_endpoint_auth_method: "none" }),
  })).json();
  assert.ok(reg.client_id, JSON.stringify(reg));
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:43123/callback", scope: "mcp:read mcp:write",
                                  state: "smoke", code_challenge: challenge, code_challenge_method: "S256", resource: `${PORTAL}/mcp` });
  const page = await owner.newPage();
  await portalLogin(page, "demo-avery");
  await page.goto(`${PORTAL}/identity/o/authorize?${q}`);
  await page.getByText("This app runs on your own computer.").waitFor();
  assert.match(await page.locator("main").innerText(), /127\.0\.0\.1/);
  assert.ok(await page.getByRole("button", { name: "Allow access" }).isVisible());
  await noOverflow(page);
  await shot(page, "connector-consent--desktop-light");
  await page.close(); // no decision: nothing is granted
  assert.deepEqual(owner.problems.splice(0), []);
});

await test("phone width, dark: the assistant", async () => {
  const ctx = await newContext({ viewport: PHONE, scheme: "dark" });
  const page = await signIn(ctx, "demo-riley");
  await go(page, "#/assistant");
  await page.getByRole("button", { name: "Overdue follow-ups" }).click();
  await page.locator(".ai-answer .ai-facts").waitFor({ timeout: 30_000 });
  await noOverflow(page);
  await shot(page, "assistant--phone-dark");
  assert.deepEqual(ctx.problems.splice(0), []);
  await ctx.close();
});

// --- clean up -----------------------------------------------------------------------------------------------
await test("clean up: Save to record off again", async () => {
  await go(app, "#/settings");
  const ai = app.locator("section[aria-labelledby=set-ai]");
  await ai.getByLabel(/Allow “Save to record” from chat/).click();
  await app.locator(".toast", { hasText: "“Save to record” is off" }).waitFor();
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
