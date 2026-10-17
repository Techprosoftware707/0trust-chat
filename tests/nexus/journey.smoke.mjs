/**
 * End-to-end journey of the product brief's key flow, in the browser, on synthetic data, against a
 * LOCAL test environment slot in MOCK MODE (docs/nexus/DEVELOPMENT.md): portal and chat dev servers
 * of the slot, NEXUS_INTEGRATIONS_MOCK=1 (every provider is a local fake, "Mock provider
 * (development)"; nothing reaches Google or HighLevel), the development AI provider (no model).
 *
 *   . dev/nexus/env.sh && node tests/nexus/journey.smoke.mjs [--no-shots] [--keep-data]
 *
 * 1. Morgan (manager) routes new leads to Riley: the seeded "New lead" automation.
 * 2. Avery (owner) connects HighLevel (mock) and adds the lead Pat Mockperson from the inbox.
 *    The automation makes Riley the owner and gives Riley a follow-up task (and a notification).
 * 3. Riley (agent) links an end-to-end encrypted conversation to Pat (only the room ID is stored).
 * 4. Riley schedules a meeting with Pat and creates its encrypted meeting room.
 * 5. Riley writes meeting notes and a next step, then confirms the next step into a task.
 * 6. The assistant (development provider) answers "What follow-ups are overdue?" with sources.
 * 7. Riley connects Gmail (mock), links an email to Pat, and has the assistant prepare a reply:
 *    confirmed as a Gmail DRAFT; nothing is sent (checked in the UI and in the database).
 * 8. Pat's timeline shows all of it; Home shows Pat's next action and when it is due.
 *
 * Without --keep-data it deletes the slot's DEMO workspace and seeds it again first (refused
 * unless NEXUS_ENVIRONMENT is development or test). Fails on console errors, horizontal overflow
 * or a missing environment banner. Screenshots (each under 300 KB): docs/nexus/screenshots/final/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SHOTS = path.join(REPO, "docs/nexus/screenshots/final");
const PORTAL = process.env.NEXUS_PORTAL_URL || `http://127.0.0.1:${process.env.NEXUS_PORTAL_PORT || 8710}`;
const APP = process.env.NEXUS_APP_URL || `http://127.0.0.1:${process.env.NEXUS_CHAT_PORT || 5710}`;
const HS = process.env.NEXUS_HS_URL || "http://127.0.0.1:28108";
const PASSWORD = process.env.NEXUS_DEMO_PASSWORD;
const DEV = "Development mode: no AI model connected";
const MAX_SHOT_BYTES = 300_000;
const shots = !process.argv.includes("--no-shots");
if (!PASSWORD) throw new Error("source dev/nexus/env.sh first (NEXUS_DEMO_PASSWORD)");
if (process.env.NEXUS_INTEGRATIONS_MOCK !== "1") throw new Error("this journey runs in mock mode only: NEXUS_INTEGRATIONS_MOCK=1");
fs.mkdirSync(SHOTS, { recursive: true });

const py = path.join(process.env.NEXUS_VENV || "/home/user/nexus-venv", "bin/python");
const manage = (...args) => execFileSync(py, ["manage.py", ...args], { cwd: path.join(REPO, "services/portal"), stdio: ["ignore", "pipe", "inherit"] }).toString();
const shell = (lines) => manage("shell", "-c", lines.join("\n")).trim().split("\n").pop();
if (!process.argv.includes("--keep-data")) {
  shell([
    "from django.conf import settings",
    "assert settings.NEXUS_ENVIRONMENT in ('development', 'test')",
    "from apps.workspaces.models import Workspace",
    "from apps.crm.demo import DEMO_SLUG",
    "Workspace.objects.filter(slug=DEMO_SLUG, crm_settings__is_demo=True).delete()",
    "print('demo workspace removed')",
  ]);
  manage("nexus_demo_seed");
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

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const IGNORED = [/sync \/sync error %s ConnectionError: fetch failed/, /Download the React DevTools/, /\[vite\]/, /favicon/,
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/];

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

const problems = (ctx) => ctx.problems.splice(0);

/** A screenshot of the page, or of one element (a locator) of it. */
async function shot(target, name) {
  if (!shots) return;
  const page = target.page ? target.page() : target;
  const close = page.locator(".toast-close");
  for (let n = await close.count(); n > 0; n--) await close.first().click().catch(() => undefined);
  await page.waitForTimeout(200);
  const file = path.join(SHOTS, `${name}.png`);
  await target.screenshot({ path: file });
  // Under 300 KB: strip metadata losslessly, then fall back to a 256-colour palette (ImageMagick).
  for (const args of [[file, "-strip", `PNG24:${file}`], [file, "-strip", "-colors", "256", `PNG8:${file}`]]) {
    if (fs.statSync(file).size < MAX_SHOT_BYTES) break;
    try {
      execFileSync("convert", args, { stdio: "ignore" });
    } catch {
      break;
    }
  }
  assert.ok(fs.statSync(file).size < MAX_SHOT_BYTES, `${name}.png is ${fs.statSync(file).size} bytes`);
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
}

async function banner(page) {
  assert.match(await page.locator(".env-banner").first().innerText(), /Test environment\s*·\s*synthetic demo data/);
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

async function toast(page, text) {
  await page.locator(".toast", { hasText: text }).first().waitFor({ timeout: 30_000 });
}

const card = (page, label) => page.locator(".ig-card", { has: page.getByRole("heading", { name: label, exact: true }) });

/** Connect a provider through the mock consent page (OAuth state, PKCE and session binding run for real), then sync. */
async function connectMock(page, label, buttonName) {
  await go(page, "#/integrations");
  const c = card(page, label);
  await c.waitFor();
  await Promise.all([page.waitForURL(/\/integrations\/mock\/[a-z-]+\/authorize/, { timeout: 30_000 }), c.getByRole("button", { name: buttonName }).click()]);
  assert.match(await page.locator("body").innerText(), /Mock provider \(development\)/);
  await Promise.all([page.waitForURL(new RegExp(`^${APP.replace(/[.:/]/g, "\\$&")}/#/integrations`), { timeout: 60_000 }), page.getByRole("button", { name: "Allow (mock)" }).click()]);
  await page.waitForSelector(".ws-rail", { timeout: 60_000 });
  await card(page, label).locator(".ig-conn").first().waitFor({ timeout: 30_000 });
  await card(page, label).getByRole("button", { name: /Sync now|Retry now/ }).first().click();
  await page.locator(".toast", { hasText: "Synced" }).waitFor({ timeout: 30_000 });
}

const LEAD = "Pat Mockperson";
const FOLLOW_UP = `Follow up with new lead ${LEAD}`;
const MEETING = `Intro call with ${LEAD}`;
const NEXT_STEP = "Send Pat the pre-approval checklist";
const REPLY = "Hi Pat, thanks for getting in touch. I'll send the pre-approval checklist today. (synthetic test reply)";

// --- 1. Morgan routes new leads to Riley -------------------------------------------------------------------
await test("1. a manager routes new leads to an agent (seeded automation, edited in the app)", async () => {
  const ctx = await newContext();
  const page = await signIn(ctx, "demo-morgan");
  await go(page, "#/automations");
  await page.getByRole("link", { name: "New lead: assign an owner and a follow-up task" }).click();
  await page.getByLabel("New owner").waitFor();
  await page.getByLabel("New owner").selectOption({ label: "Riley Placeholder" });
  await page.getByLabel("Only when it has no owner yet").uncheck();
  await page.getByRole("button", { name: "Save rule" }).click();
  await toast(page, "Rule saved");
  await page.getByText("New lead: assign an owner and a follow-up task").waitFor();
  await banner(page);
  assert.deepEqual(problems(ctx), []);
  await ctx.close();
});

// --- 2. a new lead arrives from HighLevel ----------------------------------------------------------------------
await test("2. a new lead arrives from HighLevel (mock) and is added from the inbox; the automation assigns it", async () => {
  const ctx = await newContext();
  const page = await signIn(ctx, "demo-avery");
  await connectMock(page, "GoHighLevel", /Connect GoHighLevel/);
  await go(page, "#/inbox");
  await page.locator(".ib-tabs").getByRole("button", { name: "HighLevel", exact: true }).click();
  // Pat's HighLevel conversation (the missed call from Pat is a separate row with the same button).
  await page.locator(".ib-row", { hasText: LEAD }).filter({ hasNotText: "Missed call" }).first().click();
  await page.getByRole("heading", { name: LEAD, exact: true }).waitFor();
  const links = page.locator("section[aria-label='Linked records']");
  const add = links.getByRole("button", { name: `Add ${LEAD} to Nexus` });
  await add.waitFor();
  assert.match(await links.innerText(), /Nothing changes in HighLevel/);
  await shot(page, "1-highlevel-lead-in-inbox--desktop-light");
  await add.click();
  await toast(page, "Added to Nexus");
  await links.getByRole("button", { name: LEAD, exact: true }).waitFor();
  assert.equal(await add.count(), 0, "the button goes once the lead is in Nexus");
  await banner(page);
  await noOverflow(page);
  assert.deepEqual(problems(ctx), []);
  await ctx.close();
});

// --- Riley from here on --------------------------------------------------------------------------------------------
const riley = await newContext();
let app;
let roomId = null;

await test("2b. the new owner is told and sees the lead with its follow-up task", async () => {
  app = await signIn(riley, "demo-riley");
  await go(app, "#/notifications");
  // The rule's notifications to Riley (the lead, then its task) are grouped into one row.
  await app.locator(".vx-notif", { hasText: LEAD }).first().waitFor({ timeout: 30_000 });
  await go(app, "#/contacts");
  await app.getByLabel("Search contacts").fill("Mockperson");
  await app.locator(".ws-record", { hasText: LEAD }).click();
  await app.getByRole("heading", { name: LEAD }).waitFor();
  const side = app.locator("aside[aria-label='Contact details']");
  assert.match(await side.innerText(), /Owner\s*Riley Placeholder/i);
  assert.match(await side.innerText(), /Source\s*GoHighLevel/i);
  await app.locator(".ws-task-row", { hasText: FOLLOW_UP }).waitFor();
  assert.deepEqual(problems(riley), []);
});

// --- 3. a conversation linked to the contact -------------------------------------------------------------------
await test("3. a team member links an encrypted conversation to the contact (only the room ID is stored)", async () => {
  const login = await (await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: "demo-riley" }, password: PASSWORD }),
  })).json();
  const room = await (await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.access_token}` },
    body: JSON.stringify({ name: `${LEAD} - intro (journey)`, preset: "private_chat",
                           initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] }),
  })).json();
  assert.ok(room.room_id, JSON.stringify(room));
  roomId = room.room_id;
  await fetch(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${login.access_token}` } });
  await go(app, `#/room/${encodeURIComponent(roomId)}`);
  await app.locator(".room-header").waitFor({ timeout: 30_000 });
  await app.locator("#composer").fill("Synthetic journey message: Pat prefers calls after 4pm.");
  await app.getByRole("button", { name: "Send message" }).click();
  await app.getByText("Synthetic journey message: Pat prefers calls after 4pm.").first().waitFor();
  await app.getByRole("button", { name: "CRM", exact: true }).click();
  await app.getByLabel("Find a contact or deal to link").fill("Mockperson");
  await app.locator(".ws-picker button", { hasText: LEAD }).click();
  const panel = app.locator(".ws-room-card");
  await panel.getByText("Open tasks").waitFor();
  await panel.getByText(FOLLOW_UP, { exact: true }).waitFor();
  await app.getByText("Only this conversation's room ID is saved").waitFor();
  await shot(app, "2-conversation-linked--desktop-light");
  assert.deepEqual(problems(riley), []);
});

// --- 4. a meeting scheduled and linked -------------------------------------------------------------------------
function localInput(d) {
  return d.toISOString().slice(0, 16); // the browser context runs in UTC
}

await test("4. a meeting with the contact is scheduled, with its encrypted meeting room", async () => {
  await go(app, "#/calendar");
  await app.getByRole("heading", { name: "Calendar" }).waitFor();
  await app.getByRole("button", { name: "New event" }).click();
  const dlg = app.getByRole("dialog", { name: "New event" });
  await dlg.getByLabel("Title").fill(MEETING);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(10, 0, 0, 0);
  await dlg.getByLabel("Starts").fill(localInput(start));
  await dlg.getByLabel("Ends").fill(localInput(new Date(start.getTime() + 30 * 60_000)));
  await dlg.getByLabel("Contact (optional)").fill("Mockperson");
  await dlg.locator(".ws-picker button", { hasText: LEAD }).click();
  await dlg.getByRole("button", { name: "Add to calendar" }).click();
  await toast(app, "Event added");
  await app.getByRole("heading", { name: MEETING }).waitFor();
  await app.getByRole("button", { name: "Create meeting room" }).click();
  await toast(app, "Meeting room created");
  await app.getByRole("link", { name: /Open meeting room|Go to the room invite/ }).waitFor();
  assert.deepEqual(problems(riley), []);
});

// --- 5. notes and a proposed next step confirmed into a task -----------------------------------------------------
await test("5. meeting notes and a proposed next step, confirmed by a person into a task", async () => {
  await app.getByLabel("Notes", { exact: true }).fill("Synthetic journey notes: Pat asked for the pre-approval checklist before booking viewings.");
  await app.getByRole("button", { name: "Save notes" }).click();
  await toast(app, "Notes saved");
  await app.getByLabel("Suggest a next step").fill(NEXT_STEP);
  await app.getByRole("button", { name: "Suggest" }).click();
  const row = app.locator(".vx-action", { hasText: NEXT_STEP });
  await row.waitFor();
  assert.match(await row.innerText(), new RegExp(LEAD));
  await shot(app, "3-meeting-notes-and-next-step--desktop-light");
  await row.getByRole("button", { name: `Create a task: ${NEXT_STEP}` }).click();
  await toast(app, "Task created");
  await app.locator(".vx-action", { hasText: NEXT_STEP }).getByText("Task").waitFor();
  assert.deepEqual(problems(riley), []);
});

// --- 6. the assistant answers with sources ------------------------------------------------------------------------
await test('6. the assistant (development provider) answers "What follow-ups are overdue?" with sources', async () => {
  await go(app, "#/assistant");
  await app.getByRole("heading", { name: "AI Assistant" }).waitFor();
  await app.getByLabel("Your question").fill("What follow-ups are overdue?");
  await app.getByRole("button", { name: "Send question" }).click();
  const answer = app.locator(".ai-answer").last();
  await answer.locator(".ai-facts").waitFor({ timeout: 30_000 });
  assert.match(await answer.locator(".ai-mode").innerText(), new RegExp(DEV));
  assert.match(await answer.locator(".ai-facts").innerText(), /overdue follow-up/i);
  const sources = answer.locator(".ai-sources a[href^='#/contacts/']");
  assert.ok((await sources.count()) >= 1, "the answer links to the contacts it is about");
  assert.doesNotMatch(await answer.innerText(), /AI suggestion/i, "no model, so no model text");
  await shot(app, "4-assistant-overdue-follow-ups--desktop-light");
  assert.deepEqual(problems(riley), []);
});

// --- 7. an email reply prepared and confirmed as a DRAFT ---------------------------------------------------------
let threadUrl = null;
await test("7. an email reply is prepared by the assistant and confirmed as a Gmail draft (mock); nothing is sent", async () => {
  await connectMock(app, "Gmail", /Connect your Gmail/);
  await go(app, "#/inbox");
  await app.locator(".ib-tabs").getByRole("button", { name: "Email", exact: true }).click();
  // The mock mailbox has no thread from Pat's address; its "new inquiry" thread stands in for Pat's
  // email and is linked by hand, as a person would for a second address.
  await app.locator(".ib-row", { hasText: "new inquiry (mock data)" }).click();
  await app.getByRole("heading", { name: /new inquiry/ }).waitFor();
  threadUrl = app.url();
  const links = app.locator("section[aria-label='Linked records']");
  await links.getByRole("button", { name: "Link to a contact or deal" }).click();
  await links.getByRole("searchbox", { name: "Link to a contact or deal" }).fill("Mockperson");
  await links.locator(".ws-picker button", { hasText: LEAD }).click();
  await toast(app, "Linked");
  await links.getByRole("button", { name: LEAD, exact: true }).waitFor();
  await go(app, "#/assistant");
  await app.getByLabel("Your question").fill(`Draft a reply to the email about new inquiry: ${REPLY}`);
  await app.getByRole("button", { name: "Send question" }).click();
  const action = app.locator(".ai-action").last();
  await action.waitFor({ timeout: 30_000 });
  assert.match(await action.innerText(), /Proposed change/i);
  assert.match(await action.innerText(), /Nothing changes until you confirm/);
  await action.getByRole("button", { name: "Confirm" }).click();
  const done = action.locator(".ai-action-done");
  await done.waitFor({ timeout: 30_000 });
  assert.match(await done.innerText(), /saved as a draft in Gmail/);
  assert.match(await done.innerText(), /Nothing was sent/);
  await shot(action, "5-email-reply-saved-as-draft--desktop-light");
  // In the inbox: the reviewed draft waits for the person; nothing was sent.
  await app.goto(threadUrl);
  await app.waitForSelector(".ws-rail", { timeout: 60_000 });
  const draft = app.locator(".ib-draft");
  await draft.waitFor({ timeout: 30_000 });
  assert.match(await draft.innerText(), /saved in your Gmail drafts, not sent/);
  assert.match(await draft.getByRole("textbox").first().inputValue(), /pre-approval checklist today/);
  assert.equal(await app.locator(".ib-result", { hasText: "Gmail confirmed" }).count(), 0);
  const state = JSON.parse(shell([
    "import json",
    "from apps.integrations.models import EmailDraft, PendingAction",
    "d = EmailDraft.objects.filter(subject__icontains='new inquiry', connection__owner__username='demo-riley').order_by('-created_at')",
    "sends = PendingAction.objects.filter(user__username='demo-riley', kind=PendingAction.Kind.GMAIL_SEND).count()",
    "print(json.dumps({'drafts': [[x.status, x.sent_at is not None, bool(x.sent_message_id)] for x in d], 'send_requests': sends}))",
  ]));
  // One Gmail draft, not sent, and no send was even requested (that needs its own confirmation in the inbox).
  assert.deepEqual(state, { drafts: [["draft", false, false]], send_requests: 0 }, JSON.stringify(state));
  assert.deepEqual(problems(riley), []);
});

// --- 8. the contact's timeline and Home ------------------------------------------------------------------------------
await test("8. the contact's timeline shows all of it", async () => {
  await go(app, "#/contacts");
  await app.getByLabel("Search contacts").fill("Mockperson");
  await app.locator(".ws-record", { hasText: LEAD }).click();
  await app.getByRole("heading", { name: LEAD }).waitFor();
  const tl = app.locator("section", { has: app.getByRole("heading", { name: "Timeline" }) }).locator(".ws-timeline");
  await tl.locator("li").first().waitFor();
  const want = [
    "Imported from HighLevel as a new contact",
    `Task created by an automation: ${FOLLOW_UP}`,
    "Linked a conversation",
    `Meeting scheduled: ${MEETING}`,
    `Notes: ${MEETING}`,
    `Task created: ${NEXT_STEP}`,
    "new inquiry (mock data)",
  ];
  for (const w of want) await tl.locator("li", { hasText: w }).first().waitFor({ timeout: 15_000 });
  const text = await tl.innerText();
  assert.match(text, /Pat asked for the pre-approval checklist/); // the notes themselves
  assert.ok(await tl.locator("li", { hasText: "Linked a conversation" }).getByRole("link", { name: "Open conversation" }).count());
  assert.ok(await tl.locator("li", { hasText: `Meeting scheduled: ${MEETING}` }).getByRole("link", { name: "Open meeting" }).count());
  assert.ok(await tl.locator("li", { hasText: "Imported from HighLevel" }).locator(".badge-warning", { hasText: "External" }).count());
  assert.doesNotMatch(text, /Synthetic journey message/, "chat messages stay end-to-end encrypted: never on the server timeline");
  await app.locator(".ws-task-row", { hasText: FOLLOW_UP }).waitFor();
  await app.locator(".ws-task-row", { hasText: NEXT_STEP }).waitFor();
  await banner(app);
  await noOverflow(app);
  await shot(app, "6-contact--desktop-light");
  const timelineSection = app.locator("section.ws-section", { has: app.getByRole("heading", { name: "Timeline" }) }).last();
  await timelineSection.scrollIntoViewIfNeeded();
  await shot(timelineSection, "7-contact-timeline--desktop-light");
  assert.deepEqual(problems(riley), []);
});

await test("8b. Home shows the lead's next action and its due date", async () => {
  await go(app, "#/home");
  await app.getByRole("heading", { name: "Assigned leads" }).waitFor();
  const lead = app.locator("section[aria-labelledby=home-leads] li", { hasText: LEAD });
  await lead.waitFor();
  const meta = await lead.locator(".ws-row-meta").innerText();
  assert.match(meta, new RegExp(`Next: ${FOLLOW_UP} · due (Tomorrow|Today)`), meta);
  assert.doesNotMatch(meta, /No follow-up set/);
  await noOverflow(app);
  await shot(app, "8-home-next-action--desktop-light");
  assert.deepEqual(problems(riley), []);
});

await test("phone width, dark: Home and the contact page", async () => {
  const ctx = await newContext({ viewport: PHONE, scheme: "dark" });
  const page = await signIn(ctx, "demo-riley");
  await go(page, "#/home");
  const lead = page.locator("section[aria-labelledby=home-leads] li", { hasText: LEAD });
  await lead.waitFor();
  await noOverflow(page);
  await lead.scrollIntoViewIfNeeded();
  await shot(page, "9-home-next-action--phone-dark");
  await lead.locator("a").click();
  await page.getByRole("heading", { name: LEAD }).waitFor();
  await page.locator(".ws-timeline li", { hasText: `Meeting scheduled: ${MEETING}` }).waitFor();
  await noOverflow(page);
  assert.deepEqual(problems(ctx), []);
  await ctx.close();
});

await riley.close();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed (mock-based: local fake providers, development AI provider)`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
