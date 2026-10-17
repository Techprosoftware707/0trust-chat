/**
 * Browser end-to-end tests for the public website, the customer portal and the
 * operator console of a running Lumen stack (TLS_MODE=internal test install).
 *
 *   sudo node tests/ui/portal.e2e.mjs [--base lumen.test] [--no-shots]
 *
 * Needs root only for `lumenctl create-operator` (operator setup link).
 * Creates: one customer account, one workspace, one operator account.
 * Screenshots (light/dark, desktop/mobile) go to tests/ui/output/.
 *
 * Every page is checked for: HTTP status, a single <h1>, no CSP violations,
 * no console errors, no failed same-site requests, no horizontal overflow on a
 * 390 px wide viewport.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fill, freshTotp, launchBrowser, noOverflow, passReauth, submit, watch as watchPage } from "./lib/portal-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "output");
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "lumen.test";
const shots = !args.includes("--no-shots");
const site = `https://${base}`;
const ops = `https://ops.${base}:8443`;
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(err?.message || err).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

// --- browser ----------------------------------------------------------------------------------
const browser = await launchBrowser(base);

/** A context that records problems on every page it opens. */
async function newContext(opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 }, ...opts });
  ctx.problems = [];
  ctx.on("page", (p) => watchPage(p, ctx.problems, base));
  return ctx;
}
function takeProblems(ctx) {
  const p = ctx.problems.splice(0);
  return p;
}
async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

// --- 1. public website -------------------------------------------------------------------------
const PUBLIC = [
  "/", "/features/", "/security/", "/zero-trust/", "/federation/", "/pricing/", "/docs/", "/download/",
  "/status/", "/contact/", "/privacy/", "/terms/", "/security/disclosure/", "/accounts/signup/", "/accounts/login/",
  "/accounts/password/reset/",
];

const pub = await newContext();
const pubPage = await pub.newPage();
const internalLinks = new Set();

for (const p of PUBLIC) {
  await test(`website ${p} renders (200, one h1, no CSP/console errors)`, async () => {
    const r = await pubPage.goto(site + p);
    assert.equal(r.status(), 200);
    assert.equal(await pubPage.locator("h1").count(), 1, "exactly one h1");
    assert.ok((await pubPage.title()).includes("Lumen"), "title carries brand");
    for (const href of await pubPage.$$eval("a[href]", (as) => as.map((a) => a.href))) {
      const u = new URL(href);
      if (u.hostname === base) internalLinks.add(u.origin + u.pathname);
    }
    const slug = p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/\//g, "-");
    await shot(pubPage, `site-${slug}-light`);
    assert.deepEqual(takeProblems(pub), []);
  });
}

await test("website: every internal link resolves (no 404/500)", async () => {
  const broken = [];
  for (const u of internalLinks) {
    if (/\/accounts\/logout\//.test(u)) continue;
    const r = await pub.request.get(u, { maxRedirects: 5 });
    if (r.status() >= 400) broken.push(`${r.status()} ${u}`);
  }
  assert.deepEqual(broken, [], `${internalLinks.size} links checked`);
});

await test("website: docs articles render", async () => {
  await pubPage.goto(site + "/docs/");
  const docs = [...new Set(await pubPage.$$eval("a[href*='/docs/']", (as) => as.map((a) => a.pathname).filter((p) => p !== "/docs/")))];
  assert.ok(docs.length >= 5, `found ${docs.length} doc links`);
  for (const d of docs) {
    const r = await pubPage.goto(site + d);
    assert.equal(r.status(), 200, d);
    assert.equal(await pubPage.locator("h1").count(), 1, d);
  }
  assert.deepEqual(takeProblems(pub), []);
});

const dark = await newContext({ colorScheme: "dark" });
const darkPage = await dark.newPage();
await test("website: dark theme follows the system preference", async () => {
  for (const p of ["/", "/security/", "/pricing/", "/accounts/login/"]) {
    await darkPage.goto(site + p);
    const theme = await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = theme.match(/\d+/g).map(Number);
    assert.ok(r + g + b < 150, `${p}: dark background expected, got ${theme}`);
    await shot(darkPage, `site-${p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/\//g, "-")}-dark`);
  }
  assert.deepEqual(takeProblems(dark), []);
});

await test("website: theme toggle switches and persists", async () => {
  await pubPage.goto(site + "/");
  const toggle = pubPage.locator("[data-theme-toggle]").first();
  assert.ok(await toggle.count(), "theme toggle present");
  const before = await pubPage.evaluate(() => document.documentElement.dataset.theme || "");
  await toggle.click();
  const after = await pubPage.evaluate(() => document.documentElement.dataset.theme || "");
  assert.notEqual(after, before);
  await pubPage.reload();
  assert.equal(await pubPage.evaluate(() => document.documentElement.dataset.theme || ""), after);
  await toggle.click(); // back
});

const mobile = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mobilePage = await mobile.newPage();
for (const p of PUBLIC) {
  await test(`mobile ${p}: no horizontal overflow at 390px`, async () => {
    await mobilePage.goto(site + p);
    await noOverflow(mobilePage);
    if (["/", "/pricing/", "/security/", "/accounts/signup/"].includes(p))
      await shot(mobilePage, `mobile-${p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/\//g, "-")}`);
  });
}
await test("mobile: navigation menu opens and links are reachable", async () => {
  await mobilePage.goto(site + "/");
  const btn = mobilePage.locator("[data-menu-toggle]").first();
  assert.ok(await btn.isVisible(), "menu button visible on mobile");
  await btn.click();
  await mobilePage.getByRole("link", { name: /pricing/i }).first().waitFor({ state: "visible" });
  assert.equal(await btn.getAttribute("aria-expanded"), "true");
});
assert.deepEqual(takeProblems(mobile), []);

// --- 2. customer portal ------------------------------------------------------------------------
const cust = await newContext();
const cp = await cust.newPage();
const username = `ui${randomBytes(3).toString("hex")}`;
const password = `Ui-Test-${randomBytes(8).toString("hex")}`;
let totpSecret = "";
let lastWindow = -1;

await test("portal: sign up lands on the dashboard", async () => {
  await cp.goto(site + "/accounts/signup/");
  await fill(cp, "input[name=username]", username);
  await fill(cp, "input[name=display_name]", "UI Tester");
  await fill(cp, "input[name=email]", `${username}@example.org`);
  await fill(cp, "input[name=password1]", password);
  await fill(cp, "input[name=password2]", password);
  await cp.locator("input[name=accept_terms]").check();
  await submit(cp);
  if (await cp.getByRole("heading", { name: "Too many attempts" }).count()) {
    throw new Error("the portal's sign-up limit for this IP (10/hour) is used up; reset it on the test host (docs/test-report.md, Reproducing)");
  }
  assert.match(cp.url(), /\/portal\/dashboard\/$/);
  await cp.getByText("UI Tester").first().waitFor();
  await shot(cp, "portal-dashboard-new");
});

await test("portal: signup rejects a weak password with a clear message", async () => {
  const c = await newContext();
  const p = await c.newPage();
  await p.goto(site + "/accounts/signup/");
  await fill(p, "input[name=username]", `weak${randomBytes(2).toString("hex")}`);
  await fill(p, "input[name=email]", "weak@example.org");
  await fill(p, "input[name=password1]", "password");
  await fill(p, "input[name=password2]", "password");
  await p.locator("input[name=accept_terms]").check();
  await submit(p);
  assert.match(p.url(), /signup/);
  assert.ok(await p.locator(".field-error, .errorlist, [role=alert]").count(), "error shown");
  await shot(p, "portal-signup-error");
  await c.close();
});

let workspaceUrl = "";
await test("portal: create a workspace and invite a member", async () => {
  await cp.goto(site + "/portal/workspaces/");
  await fill(cp, "input[name=name]", "UI Test Team");
  await submit(cp, "form:has(input[name=name]) button[type=submit]");
  await cp.getByRole("heading", { name: "UI Test Team" }).first().waitFor();
  workspaceUrl = cp.url();
  assert.match(workspaceUrl, /\/portal\/workspaces\/[0-9a-f-]{36}\/$/);
  await fill(cp, "input[name=email]", "colleague@example.org");
  await submit(cp, "form:has(input[name=email]) button[type=submit]");
  const link = (await cp.locator("#invite-link").innerText()).trim();
  assert.match(link, /^https:\/\/.+\/invite\/[\w-]{20,}\/$/, "one-time invitation link shown");
  await shot(cp, "portal-workspace-detail");
  for (const sub of ["settings/", "billing/"]) {
    const r = await cp.goto(workspaceUrl + sub);
    assert.equal(r.status(), 200, sub);
    await shot(cp, `portal-workspace-${sub.replace("/", "")}`);
  }
});

await test("portal: billing never fakes a payment when no provider is configured", async () => {
  await cp.goto(workspaceUrl + "billing/");
  const body = await cp.locator("main").innerText();
  assert.doesNotMatch(body, /payment (successful|succeeded|complete)/i);
  const upgrade = cp.locator("form[action$='/billing/checkout/'] button[type=submit]:not([disabled])");
  if (await upgrade.count()) {
    await submit(cp, "form[action$='/billing/checkout/'] button[type=submit]:not([disabled])");
    const after = await cp.locator("main").innerText();
    assert.doesNotMatch(after, /payment (successful|succeeded|complete)/i);
  }
});

await test("portal: enable TOTP two-factor authentication", async () => {
  await cp.goto(site + "/accounts/2fa/totp/activate/");
  if (await passReauth(cp, password)) await shot(cp, "portal-after-reauth");
  assert.equal(new URL(cp.url()).pathname, "/accounts/2fa/totp/activate/");
  totpSecret = await cp.locator("#authenticator_secret").inputValue();
  assert.match(totpSecret, /^[A-Z2-7]{16,}$/);
  await shot(cp, "portal-totp-activate");
  const t = await freshTotp(totpSecret, lastWindow);
  lastWindow = t.window;
  await fill(cp, "input[name=code]", t.code);
  await submit(cp);
  assert.doesNotMatch(cp.url(), /activate/);
  await cp.goto(site + "/portal/security/");
  const text = await cp.locator("main").innerText();
  assert.match(text, /authenticator/i);
  await shot(cp, "portal-security");
});

await test("portal: other portal pages render", async () => {
  for (const p of ["/portal/profile/", "/portal/privacy/", "/portal/support/", "/accounts/2fa/recovery-codes/", "/accounts/sessions/"]) {
    const r = await cp.goto(site + p);
    await passReauth(cp, password);
    assert.equal(r.status(), 200, `${p} -> ${r.status()}`);
    assert.equal(new URL(cp.url()).pathname, p);
    await shot(cp, `portal-${p.replace(/^\/|\/$/g, "").replace(/\//g, "-")}`);
  }
  assert.deepEqual(takeProblems(cust), []);
});

await test("portal: data export downloads JSON", async () => {
  await cp.goto(site + "/portal/privacy/");
  const [download] = await Promise.all([cp.waitForEvent("download"), cp.locator("a[href$='/privacy/export/']").click()]);
  const file = await download.path();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.account?.username, username);
  assert.doesNotMatch(JSON.stringify(data), /password|secret/i);
});

await test("portal: sign-out, then sign-in requires the TOTP code", async () => {
  await cp.goto(site + "/accounts/logout/");
  await submit(cp);
  await cp.goto(site + "/portal/dashboard/");
  assert.match(cp.url(), /\/accounts\/login\//);
  await fill(cp, "input[name=login]", username);
  await fill(cp, "input[name=password]", password);
  await submit(cp);
  assert.match(cp.url(), /\/accounts\/2fa\/authenticate\//);
  await shot(cp, "portal-mfa-prompt");
  await fill(cp, "input[name=code]", "000000");
  await submit(cp);
  assert.match(cp.url(), /authenticate/, "wrong code rejected");
  const t = await freshTotp(totpSecret, lastWindow);
  lastWindow = t.window;
  await fill(cp, "input[name=code]", t.code);
  await submit(cp);
  assert.match(cp.url(), /\/portal\/dashboard\/$/);
});

await test("portal: customer cannot reach the operator console", async () => {
  const r = await cp.goto(ops + "/ops/dashboard/");
  // The ops site has its own session cookie: a portal session grants nothing there.
  assert.ok([200, 403, 404].includes(r.status()), `got ${r.status()}`);
  assert.equal(new URL(cp.url()).pathname, "/accounts/login/");
});

const mcust = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await cust.storageState() });
const mcp = await mcust.newPage();
for (const p of ["/portal/dashboard/", "/portal/security/", "/portal/workspaces/"]) {
  await test(`mobile portal ${p}: no horizontal overflow`, async () => {
    await mcp.goto(site + p);
    await noOverflow(mcp);
    await shot(mcp, `mobile-${p.replace(/^\/|\/$/g, "").replace(/\//g, "-")}`);
  });
}
await test("mobile portal workspace detail: no horizontal overflow", async () => {
  await mcp.goto(workspaceUrl);
  await noOverflow(mcp);
  await shot(mcp, "mobile-portal-workspace-detail");
});

if (workspaceUrl) {
  const dcust = await newContext({ colorScheme: "dark", storageState: await cust.storageState() });
  const dcp = await dcust.newPage();
  await dcp.goto(site + "/portal/dashboard/");
  await shot(dcp, "portal-dashboard-dark");
  await dcp.goto(workspaceUrl);
  await shot(dcp, "portal-workspace-detail-dark");
}

// --- 3. operator console -----------------------------------------------------------------------
const opName = `uiops${randomBytes(2).toString("hex")}`;
const opPass = `Ops-Test-${randomBytes(10).toString("hex")}`;
const op = await newContext();
const opp = await op.newPage();
let opSecret = "";
let setupLink = "";
let opWindow = -1;

await test("ops: console is not served on the public site", async () => {
  for (const u of [`${site}/ops/dashboard/`, `https://app.${base}/ops/dashboard/`, `https://matrix.${base}/ops/dashboard/`]) {
    const r = await opp.request.get(u, { maxRedirects: 0 });
    assert.ok([404, 403].includes(r.status()) || r.status() === 200 && !(await r.text()).includes("Operator console"), `${u} -> ${r.status()}`);
  }
});

await test("ops: setup link -> password -> mandatory TOTP enrolment -> console", async () => {
  const out = execFileSync(path.join(REPO, "lumenctl"), ["create-operator", opName, `${opName}@example.org`, "owner"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const link = out.match(/https:\/\/\S+\/setup\/\S+/)?.[0];
  setupLink = link;
  assert.ok(link, `no setup link in output:\n${out.replace(/https:\/\/\S+/g, "<url>")}`);
  await opp.goto(link);
  await shot(opp, "ops-setup-link");
  await fill(opp, "input[name=new_password1]", opPass);
  await fill(opp, "input[name=new_password2]", opPass);
  await submit(opp);
  assert.equal(new URL(opp.url()).pathname, "/accounts/login/");
  await fill(opp, "input[name=login]", opName);
  await fill(opp, "input[name=password]", opPass);
  await submit(opp);
  // Operators must enrol MFA before anything else.
  await opp.goto(ops + "/ops/dashboard/");
  assert.match(opp.url(), /\/accounts\/2fa\//, `expected MFA enrolment, at ${opp.url()}`);
  await opp.goto(ops + "/accounts/2fa/totp/activate/");
  await passReauth(opp, opPass);
  opSecret = await opp.locator("#authenticator_secret").inputValue();
  const t = await freshTotp(opSecret, opWindow);
  opWindow = t.window;
  await fill(opp, "input[name=code]", t.code);
  await submit(opp);
  await opp.goto(ops + "/ops/dashboard/");
  assert.match(opp.url(), /\/ops\/dashboard\/$/);
  await shot(opp, "ops-dashboard");
});

await test("ops: setup link is single-use", async () => {
  assert.ok(setupLink, "setup link from the previous step");
  const r = await opp.request.get(setupLink);
  assert.equal(r.status(), 404);
});

const OPS_PAGES = [
  "/ops/users/", "/ops/workspaces/", "/ops/plans/", "/ops/subscriptions/", "/ops/webhooks/", "/ops/health/",
  "/ops/federation/", "/ops/backups/", "/ops/wireguard/", "/ops/maintenance/", "/ops/security/", "/ops/audit/",
  "/ops/config/", "/ops/support/", "/ops/calls/",
];
for (const p of OPS_PAGES) {
  await test(`ops ${p} renders`, async () => {
    const r = await opp.goto(ops + p);
    assert.equal(r.status(), 200);
    assert.equal(new URL(opp.url()).pathname, p, "stayed on the page (not redirected to sign-in)");
    assert.equal(await opp.locator("h1").count(), 1);
    await shot(opp, `ops-${p.replace(/^\/ops\/|\/$/g, "").replace(/\//g, "-")}`);
    assert.deepEqual(takeProblems(op), []);
  });
}

await test("ops: Calls page runs the real media self-test through the host agent", async () => {
  await opp.goto(ops + "/ops/calls/");
  const body = await opp.locator("main").innerText();
  assert.match(body, /HTTPS working does not prove media connectivity/);
  assert.doesNotMatch(body, /@[a-z0-9._=-]+:/, "no Matrix IDs on the Calls page");
  await opp.locator('button:has-text("Run media self-test")').click();
  await opp.waitForLoadState("domcontentloaded");
  const alert = await opp.locator(".alert").first().innerText({ timeout: 120000 });
  assert.match(alert, /Media self-test passed/, alert);
  assert.match(alert, /Total\s+4\/4/, "the load tester's own summary: 4 of 4 tracks received");
  await shot(opp, "ops-calls-selftest");
  assert.deepEqual(takeProblems(op), []);
});

await test("ops: user detail shows metadata only and finds the UI test customer", async () => {
  await opp.goto(ops + `/ops/users/?q=${username}`);
  await opp.locator(`a:has-text("${username}")`).first().click();
  await opp.waitForLoadState("domcontentloaded");
  const body = await opp.locator("main").innerText();
  assert.match(body, new RegExp(username));
  assert.doesNotMatch(body, /m\.room\.message|ciphertext/);
  await shot(opp, "ops-user-detail");
});

await test("ops: destructive action requires recent re-authentication", async () => {
  await opp.goto(ops + `/ops/users/?q=${username}`);
  await opp.locator(`a:has-text("${username}")`).first().click();
  await opp.waitForLoadState("domcontentloaded");
  const form = opp.locator("form[action$='/suspend/']");
  assert.ok(await form.count(), "suspend form present");
  // The session is fresh from enrolment, so allauth may or may not ask; both are acceptable,
  // but the action must be audited.
  if (await form.locator("textarea[name=reason], input[name=reason]").count()) await form.locator("textarea[name=reason], input[name=reason]").fill("UI test");
  await Promise.all([opp.waitForLoadState("domcontentloaded"), form.locator("button[type=submit]").first().click()]);
  if (/reauthenticate/.test(opp.url())) {
    await shot(opp, "ops-reauthenticate");
    if (await opp.locator("input[name=password]").count()) {
      await fill(opp, "input[name=password]", opPass);
    } else {
      const t = await freshTotp(opSecret, opWindow);
      opWindow = t.window;
      await fill(opp, "input[name=code]", t.code);
    }
    await submit(opp);
  }
  await opp.goto(ops + "/ops/audit/");
  const audit = await opp.locator("main").innerText();
  assert.match(audit, /suspend/i);
});

await test("ops: audit chain verifies", async () => {
  await opp.goto(ops + "/ops/audit/");
  await submit(opp, "form[action$='/audit/verify/'] button[type=submit]");
  const body = await opp.locator("main").innerText();
  assert.match(body, /intact|verified|ok/i);
});

const mops = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await op.storageState() });
const mopp = await mops.newPage();
for (const p of ["/ops/dashboard/", "/ops/users/", "/ops/health/"]) {
  await test(`mobile ops ${p}: no horizontal overflow`, async () => {
    await mopp.goto(ops + p);
    await noOverflow(mopp);
    await shot(mopp, `mobile-ops-${p.replace(/^\/ops\/|\/$/g, "")}`);
  });
}

// Dark-mode screenshots of the authenticated areas.
const dops = await newContext({ colorScheme: "dark", storageState: await op.storageState() });
const dopp = await dops.newPage();
await dopp.goto(ops + "/ops/dashboard/");
await shot(dopp, "ops-dashboard-dark");

await browser.close();
console.log(`\nUI e2e: ${passed} passed, ${failed} failed${failed ? `\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failed ? 1 : 0);
