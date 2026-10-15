/**
 * SSO smoke check against a running Lumen stack (read-only use of the stack:
 * it registers one portal account and signs in once, then signs out).
 *
 * Serves the built chat app locally (production CSP) with a config.json that
 * points at the stack's homeserver, then in Chromium:
 *   portal sign-up -> "Continue with your Lumen account" -> homeserver SSO ->
 *   portal OIDC -> back to the app with ?loginToken -> token exchange.
 * Asserts the exact SSO redirect URL the app uses, that the login token is
 * removed from the address bar, and that the app ends up signed in.
 *
 *   node tests/chat/sso.smoke.mjs [--base lumen.test]
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "./lib/deps.mjs";
import { startServer } from "./lib/serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "lumen.test";
const matrix = `matrix.${base}`;
const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

const config = {
  brand: { name: "Lumen Secure", short_name: "Lumen" },
  homeserver: { base_url: `https://${matrix}`, server_name: base },
  sso: { idp_id: "oidc-lumen", label: "Continue with your Lumen account" },
  portal_url: `https://${base}`,
  allow_custom_homeserver: true,
  voip_enabled: false,
  privacy_url: `https://${base}/privacy/`,
  help_url: `https://${base}/docs/`,
};

const { server, origin } = await startServer({ port: 0, config });
// The local stack uses Caddy's internal CA; this smoke test only talks to it and to localhost.
// Local stack hostnames resolve to this machine: never send them through an outbound proxy
// (Chromium honours no_proxy from its environment).
const noProxy = [process.env.no_proxy || process.env.NO_PROXY, base, `.${base}`, "127.0.0.1", "localhost"].filter(Boolean).join(",");
const browser = await chromium.launch({ env: { ...process.env, no_proxy: noProxy, NO_PROXY: noProxy } });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const ssoRequests = [];
page.on("request", (r) => {
  if (r.url().includes("/_matrix/client/v3/login/sso/redirect")) ssoRequests.push(r.url());
});
const csp = [];
page.on("console", (m) => /Content Security Policy/.test(m.text()) && csp.push(m.text()));


/** Clicks the app's SSO button and follows the IdP until we are back in the app. */
async function ssoSignIn(p, creds) {
  await p.goto(origin + "/");
  await p.getByRole("button", { name: "Continue with your Lumen account" }).click();
  for (let i = 0; i < 8 && !p.url().startsWith(origin); i++) {
    await p.waitForLoadState("domcontentloaded");
    if (p.url().startsWith(origin)) break;
    if (creds && (await p.locator("input[name=login]").count())) {
      await p.fill("input[name=login]", creds.username);
      await p.fill("input[name=password]", creds.password);
      await Promise.all([p.waitForNavigation({ timeout: 15_000 }).catch(() => undefined), p.locator("form button[type=submit]").last().click()]);
      continue;
    }
    const next = p.locator("a:has-text('Continue'), button:has-text('Continue'), button:has-text('Allow'), button:has-text('Authorize'), input[type=submit]");
    if (await next.count()) {
      await Promise.all([p.waitForNavigation({ timeout: 15_000 }).catch(() => undefined), next.first().click()]);
    } else {
      await p.waitForTimeout(1000);
    }
  }
}

try {
  const username = `chatsmoke${randomBytes(3).toString("hex")}`;
  const password = `Smoke-Test-${randomBytes(9).toString("hex")}`;
  await page.goto(`https://${base}/accounts/signup/`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=display_name]", "Chat Smoke");
  await page.fill("input[name=email]", `${username}@example.org`);
  await page.fill("input[name=password1]", password);
  await page.fill("input[name=password2]", password);
  await page.check("input[name=accept_terms]");
  await Promise.all([page.waitForNavigation(), page.locator("form button[type=submit]").last().click()]);
  console.log("portal account created:", username);

  await ssoSignIn(page);
  assert.ok(page.url().startsWith(origin), `expected to be back at the app, got ${page.url()}`);

  const expected = `https://${matrix}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=${encodeURIComponent(origin + "/")}`;
  assert.equal(ssoRequests[0], expected, "SSO redirect URL format");
  await page.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: 60_000 });
  assert.ok(!page.url().includes("loginToken"), `loginToken must be removed from the address bar (${page.url()})`);
  const who = await page.locator(".user-chip-id").textContent();
  assert.equal(who, `@${username}:${base}`);
  await page.screenshot({ path: path.join(HERE, "screenshots", "sso-signed-in.png") });
  assert.deepEqual(csp, [], "no CSP violations");
  console.log("SSO OK: signed in as", who, "via", expected);

  await page.getByRole("button", { name: "Later" }).click();

  // Second device (fresh browser profile, portal login), then sign it out from the first
  // device: deleting a device needs user-interactive auth, which for an SSO account is the
  // homeserver's SSO fallback page in a popup (COOP prevents watching it; the user confirms).
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  await ssoSignIn(page2, { username, password });
  await page2.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: 60_000 });
  await page2.getByRole("button", { name: "Later" }).click();
  console.log("second device signed in");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Sessions" }).click();
  await page.locator(".device").nth(1).waitFor({ timeout: 30_000 });
  await page.locator(".device:not(.current) input[type=checkbox]").first().check();
  await page.getByRole("button", { name: /Sign out 1 selected/ }).click();
  await page.getByRole("heading", { name: "Confirm it's you" }).waitFor({ timeout: 30_000 });
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("button", { name: "Open sign-in window" }).click()]);
  await popup.waitForLoadState("domcontentloaded");
  for (let i = 0; i < 8; i++) {
    const body = (await popup.locator("body").innerText().catch(() => "")) || "";
    if (/thank you|successfully|you may now close|authenticated/i.test(body)) break;
    const go = popup.locator("a:has-text('Continue'), button:has-text('Continue'), button:has-text('Allow'), input[type=submit], a.primary-button, button");
    if (await go.count()) await Promise.all([popup.waitForNavigation({ timeout: 15_000 }).catch(() => undefined), go.first().click()]);
    else await popup.waitForTimeout(1000);
  }
  const popupText = await popup.locator("body").innerText();
  await popup.screenshot({ path: path.join(HERE, "screenshots", "sso-uia-popup.png") });
  await popup.close();
  console.log("UIA popup finished:", popupText.replace(/\s+/g, " ").slice(0, 120));
  await page.getByRole("button", { name: "I've confirmed" }).click();
  await page.locator(".device").nth(1).waitFor({ state: "detached", timeout: 30_000 });
  console.log("other device signed out via SSO UIA");
  await page2.getByText("this session was ended on the server").waitFor({ timeout: 60_000 });
  console.log("second device noticed it was signed out");
  await ctx2.close();
  await page.getByRole("button", { name: "Close" }).first().click();

  // Clean up: sign out (removes the device on the homeserver and wipes local data).
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await page.getByText("You've signed out.").waitFor({ timeout: 30_000 });
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  assert.deepEqual(dbs.filter((n) => /lumen|matrix-js-sdk/.test(n ?? "")), [], "local databases wiped after sign-out");
  console.log("signed out; local data wiped");
} finally {
  await browser.close();
  server.close();
}
