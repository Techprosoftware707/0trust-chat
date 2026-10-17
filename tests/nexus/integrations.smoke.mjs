/**
 * Browser smoke test of Integrations and the unified Inbox against a LOCAL test environment
 * in MOCK MODE (docs/nexus/INTEGRATIONS.md): NEXUS_INTEGRATIONS_MOCK=1 (dev/nexus/env.sh),
 * the portal and chat dev servers of the slot, the shared dev homeserver. Mock-based: every
 * provider is a local fake ("Mock provider (development)"); nothing reaches Google, Slack or
 * HighLevel.
 *
 *   NEXUS_SLOT=2 . dev/nexus/env.sh && node tests/nexus/integrations.smoke.mjs [--no-shots]
 *
 * Connects Gmail, Slack and HighLevel through the mock consent page (OAuth state, PKCE and
 * session binding run for real), syncs, then walks the inbox: native chats merged with synced
 * items and their source badges, an email body opened on demand, a reply draft reviewed and
 * sent through the confirmation dialog, a Slack reply that needs confirmation, linking to a
 * contact and opening its side panel, an agent's view (no access to the owner's mailbox),
 * phone width and dark mode. Fails on console errors, horizontal overflow or a missing
 * environment banner. Screenshots: docs/nexus/screenshots/b2/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SHOTS = path.join(REPO, "docs/nexus/screenshots/b2");
const PORTAL = process.env.NEXUS_PORTAL_URL || `http://127.0.0.1:${process.env.NEXUS_PORTAL_PORT || 8710}`;
const APP = process.env.NEXUS_APP_URL || `http://127.0.0.1:${process.env.NEXUS_CHAT_PORT || 5710}`;
const PASSWORD = process.env.NEXUS_DEMO_PASSWORD;
const shots = !process.argv.includes("--no-shots");
if (!PASSWORD) throw new Error("source dev/nexus/env.sh first (NEXUS_DEMO_PASSWORD)");
if (process.env.NEXUS_INTEGRATIONS_MOCK !== "1") throw new Error("this smoke runs in mock mode only: NEXUS_INTEGRATIONS_MOCK=1");
fs.mkdirSync(SHOTS, { recursive: true });

// Start clean: remove this slot's mock connections (and what they synced) in the demo workspace.
const py = path.join(process.env.NEXUS_VENV || "/home/user/nexus-venv", "bin/python");
execFileSync(py, ["manage.py", "shell", "-c", [
  "from apps.integrations.models import IntegrationConnection",
  "from apps.integrations.sync import purge_connection_data",
  "from apps.crm.models import OrgSettings",
  "ws = [o.workspace_id for o in OrgSettings.objects.filter(is_demo=True)]",
  "conns = list(IntegrationConnection.objects.filter(workspace_id__in=ws, is_mock=True))",
  "[purge_connection_data(c) for c in conns]",
  "print('removed', IntegrationConnection.objects.filter(pk__in=[c.pk for c in conns]).delete()[0], 'mock connection rows')",
].join("\n")], { cwd: path.join(REPO, "services/portal"), stdio: ["ignore", "inherit", "inherit"] });

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

const takeProblems = (ctx) => ctx.problems.splice(0);

async function shot(page, name) {
  if (!shots) return;
  const close = page.locator(".toast-close");
  for (let n = await close.count(); n > 0; n--) await close.first().click().catch(() => undefined);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
}

async function signIn(ctx, username) {
  const page = await ctx.newPage();
  await page.goto(`${PORTAL}/accounts/login/`);
  if (new URL(page.url()).pathname.startsWith("/accounts/login")) {
    await page.fill("input[name=login]", username);
    await page.fill("input[name=password]", PASSWORD);
    await Promise.all([page.waitForURL(/\/portal\//), page.locator("form button[type=submit]").first().click()]);
  }
  await page.goto(`${APP}/`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
}

function card(page, label) {
  return page.locator(".ig-card", { has: page.getByRole("heading", { name: label, exact: true }) });
}

/** Clicks Connect, allows on the mock consent page, and waits until the app is back. */
async function connectThroughMockConsent(page, label, buttonName, { consentShot } = {}) {
  await go(page, "#/integrations");
  const c = card(page, label);
  await c.waitFor();
  await Promise.all([page.waitForURL(/\/integrations\/mock\/[a-z-]+\/authorize/, { timeout: 30_000 }), c.getByRole("button", { name: buttonName }).click()]);
  assert.match(await page.locator("body").innerText(), /Mock provider \(development\)/);
  if (consentShot) await shot(page, consentShot);
  await Promise.all([page.waitForURL(new RegExp(`^${APP.replace(/[.:/]/g, "\\$&")}/#/integrations`), { timeout: 60_000 }), page.getByRole("button", { name: "Allow (mock)" }).click()]);
  await page.waitForSelector(".ws-rail", { timeout: 60_000 });
  await card(page, label).locator(".ig-conn").first().waitFor({ timeout: 30_000 });
}

async function syncCard(page, label) {
  const c = card(page, label);
  await c.getByRole("button", { name: /Sync now|Retry now/ }).first().click();
  await page.locator(".toast", { hasText: "Synced" }).waitFor({ timeout: 30_000 });
}

const owner = await newContext();
let app;

await test("integrations area: mock mode is labelled, setup steps and scopes are shown", async () => {
  app = await signIn(owner, "demo-avery");
  await go(app, "#/integrations");
  await app.getByRole("heading", { name: "Integrations", exact: true }).waitFor();
  await checkBanner(app);
  assert.match(await app.locator(".ib-mock-banner").first().innerText(), /Mock provider \(development\)/);
  for (const label of ["Gmail", "GoHighLevel", "Slack"]) {
    const c = card(app, label);
    await c.waitFor();
    assert.match(await c.innerText(), /Mock provider \(development\)/);
    assert.match(await c.innerText(), /Setting up the real|How an administrator sets this up|Server setup/);
  }
  await card(app, "Gmail").locator("summary", { hasText: /Setting up the real Gmail|Server setup/ }).click();
  assert.match(await card(app, "Gmail").innerText(), /NEXUS_GOOGLE_CLIENT_ID/);
  assert.match(await card(app, "Gmail").innerText(), /\/integrations\/oauth\/google\/callback/);
  await noOverflow(app);
  await shot(app, "integrations--desktop-light");
  assert.deepEqual(takeProblems(owner), []);
});

await test("connect Gmail through the mock consent page (state + PKCE + session binding)", async () => {
  await connectThroughMockConsent(app, "Gmail", /Connect your Gmail/, { consentShot: "mock-consent--desktop-light" });
  await app.locator(".toast", { hasText: "Connected" }).waitFor();
  await syncCard(app, "Gmail");
  const text = await card(app, "Gmail").innerText();
  assert.match(text, /Connected/);
  assert.match(text, /avery\.example@example\.com/);
  assert.deepEqual(takeProblems(owner), []);
});

await test("connect Slack and HighLevel, pick Slack channels, sync", async () => {
  await connectThroughMockConsent(app, "Slack", /Connect Slack/);
  const slack = card(app, "Slack");
  await slack.locator(".ig-channels input").first().waitFor();
  await slack.getByLabel(/#sales-mock/).check();
  await slack.getByLabel(/#new-leads-mock/).check();
  assert.ok(await slack.getByLabel(/#random-mock/).isDisabled(), "a channel the app isn't in can't be picked");
  await slack.getByRole("button", { name: "Save channels" }).click();
  await app.locator(".toast", { hasText: "Channels saved" }).waitFor();
  await syncCard(app, "Slack");
  await connectThroughMockConsent(app, "GoHighLevel", /Connect GoHighLevel/);
  await syncCard(app, "GoHighLevel");
  await noOverflow(app);
  await shot(app, "integrations-connected--desktop-light");
  assert.deepEqual(takeProblems(owner), []);
});

await test("inbox merges native chats with synced items, each with its source badge", async () => {
  await go(app, "#/inbox");
  await app.getByRole("heading", { name: /^Inbox/ }).waitFor();
  await app.locator(".ib-row").first().waitFor();
  await app.locator(".ib-row", { hasText: "showing times (mock data)" }).waitFor({ timeout: 30_000 });
  const badges = await app.locator(".ib-row .ib-source").allInnerTexts();
  assert.ok(badges.some((b) => /Gmail/.test(b)), "Gmail badge");
  assert.ok(badges.some((b) => /Slack/.test(b)), "Slack badge");
  assert.ok(badges.some((b) => /HighLevel/.test(b)), "HighLevel badge");
  const nativeRows = await app.locator(".ib-row .ib-source-chat").count();
  assert.ok(nativeRows >= 1, "native chats are merged in");
  // A synced row never carries the native badge.
  for (const row of await app.locator(".ib-row", { has: app.locator(".ib-mock") }).all()) {
    assert.equal(await row.locator(".ib-source-chat").count(), 0);
  }
  await app.locator(".ib-tabs").getByRole("button", { name: "Email", exact: true }).click();
  await app.locator(".ib-row .ib-source-chat").first().waitFor({ state: "detached" });
  await app.locator(".ib-tabs").getByRole("button", { name: "All", exact: true }).click();
  await noOverflow(app);
  await shot(app, "inbox--desktop-light");
  assert.deepEqual(takeProblems(owner), []);
});

await test("email: body opens on demand, a reply is drafted, reviewed and sent only after confirming", async () => {
  await app.locator(".ib-row", { hasText: "portfolio update request" }).click();
  await app.getByRole("heading", { name: /portfolio update request/ }).waitFor();
  await app.getByRole("button", { name: "Show the full message" }).first().click();
  await app.locator(".ib-message-text", { hasText: "not a real message" }).waitFor();
  await app.getByRole("button", { name: "Formatted" }).click();
  await app.locator("iframe.ib-html-frame").waitFor();
  assert.equal(await app.locator("iframe.ib-html-frame").getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
  await app.locator(".ib-row", { hasText: "showing times (mock data)" }).click();
  await app.getByRole("heading", { name: /showing times/ }).waitFor();
  await app.getByRole("textbox", { name: "Reply", exact: true }).fill("Thanks — this is a synthetic smoke-test reply.");
  await app.getByRole("button", { name: "Save as draft" }).click();
  await app.locator(".ib-draft").waitFor();
  await app.getByRole("button", { name: /Review and send/ }).click();
  const dialog = app.getByRole("dialog", { name: "Send this email?" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /harper\.sample@example\.com/);
  assert.match(await dialog.innerText(), /synthetic smoke-test reply/);
  await shot(app, "send-confirmation--desktop-light");
  await dialog.getByRole("button", { name: "Send now" }).click();
  await dialog.locator(".ib-result", { hasText: "Gmail confirmed" }).waitFor();
  await dialog.locator(".ib-dialog-actions").getByRole("button", { name: "Close" }).click();
  await app.locator(".ib-draft").waitFor({ state: "detached" });
  assert.deepEqual(takeProblems(owner), []);
});

await test("link a thread to a contact, then open the contact in the side panel", async () => {
  const links = app.locator("section[aria-label='Linked records']");
  const suggestion = links.locator("li", { hasText: "Harper Sample" });
  await suggestion.waitFor();
  await suggestion.getByRole("button", { name: "Link" }).click();
  await links.getByRole("button", { name: "Harper Sample", exact: true }).waitFor();
  await links.getByRole("button", { name: "Harper Sample", exact: true }).click();
  const drawer = app.getByRole("dialog", { name: "Harper Sample" });
  await drawer.waitFor();
  await drawer.getByText("Open tasks").waitFor();
  await shot(app, "inbox-record-panel--desktop-light");
  await drawer.getByRole("button", { name: "Close" }).click();
  // Undo, so the demo contact's timeline stays as seeded.
  await links.getByRole("button", { name: "Unlink Harper Sample" }).click();
  await links.getByText("Not linked to a record yet.").waitFor();
  assert.deepEqual(takeProblems(owner), []);
});

await test("Slack: a reply needs confirmation; HighLevel is read-only with a link out", async () => {
  await app.locator(".ib-tabs").getByRole("button", { name: "Slack", exact: true }).click();
  await app.locator(".ib-row", { hasText: "#sales-mock" }).first().click();
  await app.getByRole("heading", { name: "#sales-mock" }).waitFor();
  await app.getByLabel("Reply text").fill("Synthetic smoke-test thread reply.");
  await app.getByRole("button", { name: /Review and post/ }).click();
  const dialog = app.getByRole("dialog", { name: "Post to Slack?" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /#sales-mock/);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await app.locator(".ib-tabs").getByRole("button", { name: "HighLevel", exact: true }).click();
  await app.locator(".ib-row", { hasText: "Harper Sample" }).first().click();
  await app.getByText("Latest messages (read-only)").waitFor();
  await app.getByText(/Replying to HighLevel conversations isn't supported here/).first().waitFor();
  assert.ok(await app.getByRole("link", { name: "Open in HighLevel" }).isVisible());
  await app.locator(".ib-tabs").getByRole("button", { name: "Notifications", exact: true }).click();
  await app.locator(".ib-row", { hasText: "Missed call from Pat Mockperson" }).waitFor();
  await app.locator(".ib-tabs").getByRole("button", { name: "All", exact: true }).click();
  assert.deepEqual(takeProblems(owner), []);
});

await test("an agent sees workspace items but never the owner's mailbox", async () => {
  const ctx = await newContext();
  const page = await signIn(ctx, "demo-riley");
  await go(page, "#/inbox");
  await page.locator(".ib-row", { hasText: "#sales-mock" }).first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".ib-row", { hasText: "(mock data)" }).filter({ has: page.locator(".ib-source-gmail") }).count(), 0);
  await go(page, "#/integrations");
  const gmail = card(page, "Gmail");
  await gmail.waitFor();
  assert.match(await gmail.innerText(), /Connect your Gmail/);
  assert.match(await card(page, "Slack").innerText(), /Only workspace owners and admins|Connected/);
  assert.deepEqual(takeProblems(ctx), []);
  await ctx.close();
});

for (const [scheme, viewport, suffix] of [["dark", DESKTOP, "desktop-dark"], ["light", PHONE, "phone-light"], ["dark", PHONE, "phone-dark"]]) {
  await test(`inbox and integrations at ${suffix}`, async () => {
    const ctx = await newContext({ viewport, scheme });
    const page = await signIn(ctx, "demo-avery");
    await go(page, "#/inbox");
    await page.locator(".ib-row").first().waitFor({ timeout: 30_000 });
    await noOverflow(page);
    await shot(page, `inbox--${suffix}`);
    if (viewport === PHONE) {
      await page.locator(".ib-row", { hasText: "showing times (mock data)" }).click();
      await page.getByRole("heading", { name: /showing times/ }).waitFor();
      await noOverflow(page);
      await shot(page, `inbox-detail--${suffix}`);
    }
    await go(page, "#/integrations");
    await card(page, "Gmail").waitFor();
    await noOverflow(page);
    if (scheme === "dark" && viewport === DESKTOP) await shot(page, `integrations--${suffix}`);
    assert.deepEqual(takeProblems(ctx), []);
    await ctx.close();
  });
}

await owner.close();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed (mock-based: local fake providers only)`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
