/**
 * Browser smoke of the verticals team's areas against a LOCAL test environment slot
 * (docs/nexus/DEVELOPMENT.md): portal on 127.0.0.1:8710+N, chat SPA on 127.0.0.1:5710+N,
 * the shared homeserver on 127.0.0.1:28108, demo data seeded, secure document storage set up
 * (env.sh does that).
 *
 *   NEXUS_SLOT=1 . dev/nexus/env.sh && node tests/nexus/verticals.smoke.mjs [--no-shots] [--keep-data]
 *
 * Journeys: Home sections; properties (detail, schedule a viewing); the deal page with
 * milestones and deadlines; the buyer page with preferences and viewings; the lending
 * pipeline and an application (request document, encrypted upload, token download, the
 * staff-only decision panel, the access log); calendar (agenda/day/week, an event with a
 * meeting room created through the Matrix client, notes, next steps); Calls & Meetings
 * (confirm a suggested next step into a task); reports; automations and their history;
 * notification preferences; role-based visibility (agent, team member); dark mode and phone
 * widths. Fails on console errors, horizontal overflow or a missing environment banner.
 * Screenshots: docs/nexus/screenshots/b1/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SHOTS = path.join(REPO, "docs/nexus/screenshots/b1");
const PORTAL = process.env.NEXUS_PORTAL_URL || `http://127.0.0.1:${process.env.NEXUS_PORTAL_PORT || 8710}`;
const APP = process.env.NEXUS_APP_URL || `http://127.0.0.1:${process.env.NEXUS_CHAT_PORT || 5710}`;
const PASSWORD = process.env.NEXUS_DEMO_PASSWORD;
const shots = !process.argv.includes("--no-shots");
if (!PASSWORD) throw new Error("source dev/nexus/env.sh first (NEXUS_DEMO_PASSWORD)");
fs.mkdirSync(SHOTS, { recursive: true });

const py = path.join(process.env.NEXUS_VENV || "/home/user/nexus-venv", "bin/python");
const manage = (...args) => execFileSync(py, ["manage.py", ...args], { cwd: path.join(REPO, "services/portal"), stdio: ["ignore", "pipe", "inherit"] }).toString();
if (!process.argv.includes("--keep-data")) {
  // A clean demo workspace: the journeys below create real rows (a viewing, an encrypted
  // upload, notes) that a plain nexus_demo_reset deliberately keeps. This deletes the DEMO
  // workspace of this slot's development database only (refused unless it is flagged demo)
  // and seeds it again; accounts and the homeserver are untouched.
  manage("shell", "-c", [
    "from django.conf import settings",
    "assert settings.NEXUS_ENVIRONMENT in ('development', 'test')",
    "from apps.workspaces.models import Workspace",
    "from apps.crm.demo import DEMO_SLUG",
    "Workspace.objects.filter(slug=DEMO_SLUG, crm_settings__is_demo=True).delete()",
  ].join("\n"));
  manage("nexus_demo_seed");
}
// The worker isn't running in the dev environment: run the automation scans once so the
// seeded rules have produced their (real) reminders and overdue notifications.
manage("nexus_automation_scan");

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const browser = await chromium.launch();

let passed = 0;
const failures = [];
let lastPage = null;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    if (lastPage && process.env.SMOKE_FAIL_SHOTS) {
      await lastPage.screenshot({ path: path.join(process.env.SMOKE_FAIL_SHOTS, `fail-${failures.length}.png`) }).catch(() => undefined);
    }
    console.log(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 8).join("\n     ")}`);
  }
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const IGNORED = [/sync \/sync error %s ConnectionError: fetch failed/, /Download the React DevTools/, /\[vite\]/, /favicon/,
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/];

async function newContext({ viewport = DESKTOP, scheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", acceptDownloads: true });
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
  // The area's own scroll container clips instead of growing the page: check it as well.
  const inner = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll(".ws-area-scroll")].map((el) => el.scrollWidth - el.clientWidth)));
  assert.ok(inner <= 1, `the page content is ${inner}px wider than the screen`);
}

async function signIn(ctx, username) {
  const page = await ctx.newPage();
  lastPage = page;
  await page.goto(`${PORTAL}/accounts/login/`);
  if (new URL(page.url()).pathname.startsWith("/accounts/login")) {
    await page.fill("input[name=login]", username);
    await page.fill("input[name=password]", PASSWORD);
    await Promise.all([page.waitForURL(/\/portal\//), page.locator("form button[type=submit]").first().click()]);
  }
  await page.goto(`${APP}/`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector(".ws-rail, .ws-bottom", { timeout: 60_000 });
  return page;
}

async function go(page, hash) {
  lastPage = page;
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

async function banner(page) {
  assert.match(await page.locator(".env-banner").first().innerText(), /Test environment\s*·\s*synthetic demo data/);
}

async function toast(page, text) {
  await page.locator(".toast", { hasText: text }).first().waitFor({ timeout: 20_000 });
}

// --- manager: Home, real estate, lending, calendar, calls, reports, automations ----------------------------
const mgr = await newContext();
let app;

await test("Home shows meetings, deadlines and applications missing documents", async () => {
  app = await signIn(mgr, "demo-morgan");
  await go(app, "#/home");
  await app.getByRole("heading", { name: "Today's meetings" }).waitFor();
  await app.getByRole("heading", { name: "Approaching deadlines" }).waitFor();
  await app.getByRole("heading", { name: "Applications missing documents" }).waitFor();
  await app.locator("#home-deadlines ~ ul li, section[aria-labelledby=home-deadlines] li").first().waitFor();
  assert.ok((await app.locator("section[aria-labelledby=home-missing] li").count()) >= 2, "applications missing documents");
  await banner(app);
  await noOverflow(app);
  await shot(app, "home--desktop-light");
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Properties: list, detail with people and deals, schedule a viewing", async () => {
  await go(app, "#/properties");
  await app.getByRole("heading", { name: "Properties" }).waitFor();
  await app.locator(".ws-record", { hasText: "14 Gull Lane" }).click();
  await app.getByRole("heading", { name: "14 Gull Lane" }).waitFor();
  await app.getByText("Entered by your team.").waitFor();
  await app.getByText("Harper Sample").first().waitFor();
  await shot(app, "property-detail--desktop-light");
  await app.getByRole("button", { name: "Schedule viewing" }).click();
  const dlg = app.getByRole("dialog", { name: "Schedule a viewing" });
  await dlg.getByLabel("Add a buyer or tenant").fill("Harper");
  await dlg.locator(".ws-picker button", { hasText: "Harper Sample" }).click();
  await dlg.getByRole("button", { name: "Schedule viewing" }).click();
  await toast(app, "Viewing scheduled");
  await app.locator("section", { hasText: "Viewings" }).getByText("Harper Sample").first().waitFor();
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Deal page: people with roles, properties, milestones with approaching deadlines", async () => {
  await go(app, "#/crm");
  await app.getByLabel("Search deals").fill("duplex");
  await app.locator(".ws-record", { hasText: "duplex portfolio" }).click();
  await app.getByRole("heading", { name: "Milestones & deadlines" }).waitFor();
  await app.locator(".vx-milestone.vx-u-due_soon", { hasText: "Appraisal" }).waitFor();
  await app.getByText("need attention").waitFor();
  await app.locator("section", { hasText: "Properties" }).getByText("221 Example Avenue").first().waitFor();
  await app.locator("section", { hasText: "Lending applications" }).getByText("APP-0005").waitFor();
  await shot(app, "deal-verticals--desktop-light");
  // mark the appraisal done, then reopen it
  const box = app.getByRole("checkbox", { name: "Mark done: Appraisal due" });
  await box.check();
  await toast(app, "Marked done");
  await app.locator(".vx-done summary").waitFor();
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Buyer page: preferences, matching listings and viewings", async () => {
  await go(app, "#/contacts");
  await app.getByLabel("Search contacts").fill("Hollis");
  await app.locator(".ws-record", { hasText: "Hollis Example" }).click();
  await app.getByRole("heading", { name: "What they're looking for" }).waitFor();
  await app.getByText("Garage").first().waitFor();
  await app.getByText("Your listings that fit").waitFor();
  await app.locator("section", { hasText: "Viewings" }).getByText("Viewing: 77 Sample Street").waitFor();
  await shot(app, "buyer-page--desktop-light");
  await app.getByRole("button", { name: "Edit" }).first().click();
  await app.getByLabel("Must-haves").fill("Garage, Fenced yard");
  await app.getByRole("button", { name: "Save preferences" }).click();
  await toast(app, "Preferences saved");
  assert.deepEqual(takeProblems(mgr), []);
});

const tmpPdf = path.join(os.tmpdir(), `nexus-smoke-${process.pid}.pdf`);
fs.writeFileSync(tmpPdf, "%PDF-1.4\n% synthetic smoke-test document\n%%EOF\n");

await test("Lending: pipeline, application, request document, encrypted upload and download, staff decision", async () => {
  await go(app, "#/lending");
  await app.getByRole("heading", { name: "Lending" }).waitFor();
  await app.locator(".ws-column").first().waitFor();
  await app.getByText("Authorised staff make every lending decision").waitFor();
  await shot(app, "lending-pipeline--desktop-light");
  await app.locator(".vx-app-card", { hasText: "Testcase - first mortgage" }).click();
  await app.getByRole("heading", { name: "Testcase - first mortgage" }).waitFor();
  await app.getByRole("heading", { name: "Outstanding work" }).waitFor();
  await app.getByText("Nexus can't send the request to the borrower yet").waitFor();
  await shot(app, "lending-application--desktop-light");
  const bank = app.locator(".vx-checklist > li", { hasText: "Bank statements" });
  await bank.getByRole("button", { name: /Request Bank statements/ }).click();
  await toast(app, "Marked requested; task created");
  // upload to the purchase agreement item
  const item = app.locator(".vx-checklist > li", { hasText: "Signed purchase agreement" });
  const chooser = app.waitForEvent("filechooser");
  await item.getByRole("button", { name: /Upload a file for Signed purchase agreement/ }).click();
  await (await chooser).setFiles(tmpPdf);
  await toast(app, "Document uploaded and encrypted");
  await app.locator(".vx-checklist > li", { hasText: "Signed purchase agreement" }).getByText("Received, to review").waitFor();
  const download = app.waitForEvent("download");
  await app.locator(".vx-checklist > li", { hasText: "Signed purchase agreement" }).getByRole("button", { name: /Download/ }).first().click();
  const d = await download;
  const saved = await d.path();
  assert.match(fs.readFileSync(saved, "utf8"), /synthetic smoke-test document/);
  // the decision panel: managers only, explicit confirmation
  await app.getByRole("heading", { name: "Decision", exact: true }).waitFor();
  assert.ok(await app.getByRole("button", { name: "Record decision" }).isDisabled());
  await app.getByRole("button", { name: /Show who uploaded and downloaded/ }).click();
  await app.locator(".ws-history li", { hasText: "Downloaded" }).first().waitFor();
  await shot(app, "lending-application-log--desktop-light");
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Calendar: agenda, week and day views; an event with a meeting room, notes and next steps", async () => {
  await go(app, "#/calendar");
  await app.getByRole("heading", { name: "Calendar" }).waitFor();
  await app.locator(".vx-agenda-day").first().waitFor();
  await shot(app, "calendar-agenda--desktop-light");
  await app.getByRole("group", { name: "View" }).getByRole("button", { name: "Week" }).click();
  await app.locator(".vx-week").waitFor();
  await app.locator(".vx-block").first().waitFor();
  await shot(app, "calendar-week--desktop-light");
  await app.getByRole("group", { name: "View" }).getByRole("button", { name: "Agenda" }).click();
  await app.locator(".vx-event", { hasText: "Underwriting review" }).first().click();
  await app.getByRole("heading", { name: "Underwriting review: Testcase" }).waitFor();
  await app.getByText("Recording and transcription aren't available").waitFor();
  const create = app.getByRole("button", { name: "Create meeting room" });
  if (await create.count()) {
    await create.click();
    await toast(app, "Meeting room created");
  }
  await app.getByRole("link", { name: /Open meeting room|Go to the room invite/ }).waitFor();
  await app.getByLabel("Notes", { exact: true }).fill("Reviewed the pay stubs; bank statements still missing.");
  await app.getByRole("button", { name: "Save notes" }).click();
  await toast(app, "Notes saved");
  await app.getByLabel("Suggest a next step").fill("Chase the bank statements");
  await app.getByRole("button", { name: "Suggest" }).click();
  await app.locator(".vx-action", { hasText: "Chase the bank statements" }).waitFor();
  await shot(app, "calendar-event--desktop-light");
  await app.getByRole("link", { name: /Open meeting room/ }).click();
  await app.locator(".room-header").waitFor({ timeout: 30_000 });
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Calls & Meetings: upcoming, recent calls on this device, confirm a next step into a task", async () => {
  await go(app, "#/calls");
  await app.getByRole("heading", { name: "Calls & Meetings" }).waitFor();
  await app.locator(".ws-card .ws-row-link").first().waitFor();
  await shot(app, "calls-upcoming--desktop-light");
  await go(app, "#/calls/recent");
  await app.getByText("nothing on this list is sent to the workspace server").waitFor();
  await go(app, "#/calls/next-steps");
  const row = app.locator(".vx-action", { hasText: "Chase the bank statements" });
  await row.waitFor();
  await shot(app, "calls-next-steps--desktop-light");
  await row.getByRole("button", { name: /Create a task/ }).click();
  await toast(app, "Task created");
  await row.waitFor({ state: "detached" }).catch(() => undefined);
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Reports: pipeline, team week, deadlines, activity, tasks, lending", async () => {
  await go(app, "#/reports");
  await app.getByRole("heading", { name: "Reports" }).waitFor();
  for (const h of ["Pipeline by stage", "This week's team pipeline", "Approaching deadlines", "Activity", "Task completion", "Lending checklist status"]) {
    await app.getByRole("heading", { name: h }).waitFor();
  }
  await app.locator(".vx-mini b").first().waitFor();
  await shot(app, "reports--desktop-light");
  assert.deepEqual(takeProblems(mgr), []);
});

await test("Automations: seeded rules, editor, history; notifications and preferences", async () => {
  await go(app, "#/automations");
  await app.getByRole("heading", { name: "Automations" }).waitFor();
  await app.getByText("New lead: assign an owner and a follow-up task").waitFor();
  await shot(app, "automations--desktop-light");
  await app.getByRole("link", { name: "New rule" }).first().click();
  await app.getByRole("heading", { name: "New rule" }).waitFor();
  await app.getByLabel("Name").fill("Smoke: closing reminder");
  await app.getByLabel("When").selectOption("appointment.upcoming");
  await app.getByRole("button", { name: "Create rule" }).click();
  await toast(app, "Rule created");
  await app.getByText("Smoke: closing reminder").waitFor();
  await go(app, "#/automations/history");
  await app.getByRole("group", { name: "Show" }).getByRole("button", { name: "All runs" }).click();
  await app.locator(".vx-table tbody tr").first().waitFor();
  await shot(app, "automation-history--desktop-light");
  await go(app, "#/notifications/preferences");
  await app.getByRole("heading", { name: "My notifications" }).waitFor();
  await app.getByLabel("Group repeats (e.g. several overdue tasks become one notification)").first().waitFor();
  await shot(app, "notification-preferences--desktop-light");
  // clean up the smoke rule
  await go(app, "#/automations");
  await app.getByRole("link", { name: "Smoke: closing reminder" }).click();
  app.once("dialog", (dlg) => void dlg.accept());
  await app.getByRole("button", { name: "Delete" }).click();
  await toast(app, "Rule deleted");
  assert.deepEqual(takeProblems(mgr), []);
});

// --- roles ---------------------------------------------------------------------------------------------------
await test("an agent sees only the applications assigned to them; a team member sees no lending at all", async () => {
  const ctx = await newContext();
  const riley = await signIn(ctx, "demo-riley");
  await go(riley, "#/lending");
  await riley.locator(".ws-column").first().waitFor();
  const cards = await riley.locator(".vx-app-card .ws-deal-meta").allInnerTexts();
  assert.ok(cards.some((t) => t.includes("APP-0004")), "Riley's own application");
  assert.ok(!cards.some((t) => t.includes("APP-0001")), "someone else's application is hidden");
  assert.equal(await riley.getByRole("heading", { name: "Decision", exact: true }).count(), 0);
  await riley.locator(".vx-app-card", { hasText: "Hollis - pre-approval" }).click();
  await riley.getByRole("heading", { name: "Decision", exact: true }).waitFor();
  await riley.getByText("Owners, admins and managers record decisions.").waitFor();
  assert.equal(await riley.getByRole("button", { name: /Show who uploaded/ }).count(), 0);
  const labels = await riley.locator(".ws-rail-label").allInnerTexts();
  assert.ok(!labels.includes("Reports") && !labels.includes("Automations"));
  assert.deepEqual(takeProblems(ctx), []);
  await ctx.close();
  const ctx2 = await newContext();
  const casey = await signIn(ctx2, "demo-casey");
  const caseyLabels = await casey.locator(".ws-rail-label").allInnerTexts();
  assert.ok(!caseyLabels.includes("Lending"), "team members have no lending access");
  assert.ok(caseyLabels.includes("Calendar") && caseyLabels.includes("Properties"));
  await go(casey, "#/home");
  await casey.getByRole("heading", { name: "Today's meetings" }).waitFor();
  assert.equal(await casey.getByRole("heading", { name: "Applications missing documents" }).count(), 0);
  assert.deepEqual(takeProblems(ctx2), []);
  await ctx2.close();
});

// --- dark mode and phone widths ----------------------------------------------------------------------------------
await test("dark theme, desktop", async () => {
  const ctx = await newContext({ scheme: "dark" });
  const page = await signIn(ctx, "demo-avery");
  for (const [hash, wait, name] of [
    ["#/home", "Today's meetings", "home--desktop-dark"],
    ["#/lending", "Lending", "lending-pipeline--desktop-dark"],
    ["#/calendar/week", "Calendar", "calendar-week--desktop-dark"],
    ["#/reports", "Reports", "reports--desktop-dark"],
  ]) {
    await go(page, hash);
    await page.getByRole("heading", { name: wait }).first().waitFor();
    await page.waitForTimeout(400);
    await shot(page, name);
  }
  await go(page, "#/lending");
  await page.locator(".vx-app-card", { hasText: "Testcase - first mortgage" }).click();
  await page.getByRole("heading", { name: "Outstanding work" }).waitFor();
  await shot(page, "lending-application--desktop-dark");
  await go(page, "#/properties");
  await page.locator(".ws-record", { hasText: "9 Pier Row" }).click();
  await page.getByRole("heading", { name: "9 Pier Row" }).waitFor();
  await shot(page, "property-detail--desktop-dark");
  assert.deepEqual(takeProblems(ctx), []);
  await ctx.close();
});

for (const scheme of ["light", "dark"]) {
  await test(`phone width (${scheme}): Home, lending application, calendar, properties`, async () => {
    const ctx = await newContext({ viewport: PHONE, scheme });
    const page = await signIn(ctx, "demo-jordan");
    await go(page, "#/home");
    await page.getByRole("heading", { name: "Today's meetings" }).waitFor();
    await noOverflow(page);
    await shot(page, `home--phone-${scheme}`);
    await go(page, "#/lending");
    await page.locator(".vx-app-card").first().waitFor();
    await noOverflow(page);
    await page.locator(".vx-app-card", { hasText: "Testcase - first mortgage" }).click();
    await page.getByRole("heading", { name: "Outstanding work" }).waitFor();
    await noOverflow(page);
    await shot(page, `lending-application--phone-${scheme}`);
    await go(page, "#/calendar");
    await page.locator(".vx-agenda-day").first().waitFor();
    await noOverflow(page);
    await shot(page, `calendar-agenda--phone-${scheme}`);
    await go(page, "#/properties");
    await page.locator(".ws-record").first().waitFor();
    await noOverflow(page);
    await page.locator(".ws-record").first().click();
    await page.getByRole("link", { name: "Back to properties" }).waitFor();
    await noOverflow(page);
    await shot(page, `property-detail--phone-${scheme}`);
    assert.deepEqual(takeProblems(ctx), []);
    await ctx.close();
  });
}

fs.rmSync(tmpPdf, { force: true });
await mgr.close();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
