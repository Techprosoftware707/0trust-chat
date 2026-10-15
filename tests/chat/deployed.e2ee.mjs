/**
 * End-to-end encryption check against a *deployed* Lumen stack (the real web app at
 * https://app.<base>, the real homeserver and its PostgreSQL database).
 *
 *   sudo node tests/chat/deployed.e2ee.mjs [--base lumen.test]
 *
 * Two people sign up on the portal, sign in to the deployed chat app through SSO,
 * and exchange messages in a direct chat. Then the homeserver's own database is
 * queried (as root, through `lumenctl compose exec postgres`) to prove that it
 * stores only ciphertext: no event in the room is a plaintext m.room.message and
 * the unique marker strings appear nowhere in the event store.
 *
 * Creates two portal accounts (chate2ea…/chate2eb…). Needs root for the DB check.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "./lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "output");
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "lumen.test";
const app = `https://app.${base}`;
const T = 60_000;

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const noProxy = [process.env.no_proxy || process.env.NO_PROXY, base, `.${base}`, "127.0.0.1", "localhost"].filter(Boolean).join(",");
const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${base} 127.0.0.1, MAP *.${base} 127.0.0.1`],
  env: { ...process.env, no_proxy: noProxy, NO_PROXY: noProxy },
});

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(err?.message || err).split("\n").slice(0, 8).join("\n     ")}`);
    throw err;
  }
}

function sql(query) {
  return execFileSync(path.join(REPO, "lumenctl"), ["compose", "exec", "-T", "postgres", "psql", "-qAtU", "postgres", "-d", "synapse", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function person(label) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || /Content Security Policy/i.test(m.text())) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  const username = `chate2e${label}${randomBytes(3).toString("hex")}`;
  const password = `E2E-Test-${randomBytes(9).toString("hex")}`;
  return { ctx, page, problems, username, password, userId: `@${username}:${base}` };
}

async function signUpAndSignIn(p) {
  const { page } = p;
  await page.goto(`https://${base}/accounts/signup/`);
  await page.fill("input[name=username]", p.username);
  await page.fill("input[name=email]", `${p.username}@example.org`);
  await page.fill("input[name=password1]", p.password);
  await page.fill("input[name=password2]", p.password);
  await page.check("input[name=accept_terms]");
  await Promise.all([page.waitForNavigation(), page.locator("main form button[type=submit]").click()]);
  assert.match(page.url(), /\/portal\/dashboard\/$/);

  // The homeserver rate-limits logins per client IP (rc_login.address); every test login
  // comes from 127.0.0.1, so wait and retry when the app reports it.
  for (let attempt = 1; ; attempt++) {
    await page.goto(app + "/");
    await page.getByRole("button", { name: /Continue with your .* account/ }).click();
    // homeserver SSO -> portal OIDC (already signed in; consent is skipped for the first-party client)
    for (let i = 0; i < 8 && !page.url().startsWith(app); i++) {
      await page.waitForLoadState("domcontentloaded");
      if (page.url().startsWith(app)) break;
      const next = page.locator("a:has-text('Continue'), button:has-text('Continue')");
      if (await next.count()) await Promise.all([page.waitForNavigation({ timeout: 15_000 }).catch(() => undefined), next.first().click()]);
      else await page.waitForTimeout(1000);
    }
    const ready = page.getByRole("heading", { name: "Set up secure backup" });
    const limited = page.getByText("You're doing that too often");
    await ready.or(limited).first().waitFor({ timeout: T }).catch(() => undefined);
    if ((await limited.count()) && attempt < 10) {
      console.log(`     (homeserver login rate limit; retrying in 60 s, attempt ${attempt})`);
      await page.waitForTimeout(60_000);
      continue;
    }
    break;
  }
  await page
    .getByRole("heading", { name: "Set up secure backup" })
    .waitFor({ timeout: T })
    .catch(async (e) => {
      await page.screenshot({ path: path.join(OUT, `deployed-e2ee-signin-failed-${p.username}.png`) });
      const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`${e.message.split("\n")[0]} at ${page.url()} — page says: ${text}`);
    });
  assert.ok(!page.url().includes("loginToken"), "login token removed from the address bar");
  assert.equal((await page.locator(".user-chip-id").textContent())?.trim(), p.userId);
}

const msg = (page, text) => page.locator("article.msg", { has: page.locator(".msg-body", { hasText: text }) });
const markerA = `lumen-e2ee-marker-a-${randomBytes(6).toString("hex")}`;
const markerB = `lumen-e2ee-marker-b-${randomBytes(6).toString("hex")}`;
const alice = await person("a");
const bob = await person("b");
let roomId = "";

try {
  await step("both people sign up on the portal and sign in to the deployed app via SSO", async () => {
    await signUpAndSignIn(alice);
    await signUpAndSignIn(bob);
  });

  await step("Alice sets up secure backup (recovery key shown once, confirmed)", async () => {
    const page = alice.page;
    await page.getByRole("button", { name: "Continue" }).click();
    const key = (await page.locator(".recovery-key").textContent()).trim();
    assert.match(key, /^([A-Za-z0-9]{4} ){11}[A-Za-z0-9]{4}$/);
    await page.getByLabel("I've saved my recovery key somewhere safe").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Recovery key").fill(key);
    await page.getByRole("button", { name: "Finish set-up" }).click();
    await page.getByText("Secure backup is set up").waitFor({ timeout: T });
    await page.getByRole("button", { name: "Done" }).click();
    await bob.page.getByRole("button", { name: "Later" }).click();
  });

  await step("Alice starts an encrypted direct chat with Bob and sends a message", async () => {
    const page = alice.page;
    await page.getByRole("button", { name: "Start a conversation" }).click();
    await page.getByRole("menuitem", { name: "New direct message" }).click();
    await page.getByLabel("Find people").fill(bob.userId);
    await page.locator(".user-result").first().click({ timeout: T });
    await page.getByRole("button", { name: "Start conversation" }).click();
    await page.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor({ timeout: T });
    roomId = decodeURIComponent(new URL(page.url()).hash.match(/!([^/?]+)/)?.[0] ?? "");
    await page.locator("#composer").fill(`Hello Bob ${markerA}`);
    await page.keyboard.press("Enter");
    await msg(page, markerA).waitFor({ timeout: T });
  });

  await step("Bob accepts, decrypts Alice's message and replies", async () => {
    const page = bob.page;
    await page.getByRole("button", { name: "Accept" }).first().click({ timeout: T });
    await msg(page, markerA).waitFor({ timeout: T });
    await page.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor();
    await page.locator("#composer").fill(`Hi Alice ${markerB}`);
    await page.keyboard.press("Enter");
    await msg(alice.page, markerB).waitFor({ timeout: T });
    await alice.page.screenshot({ path: path.join(OUT, "deployed-e2ee-alice.png") });
  });

  await step("homeserver database: room holds only m.room.encrypted message events", async () => {
    if (!roomId.startsWith("!")) {
      roomId = sql(
        `SELECT e.room_id FROM events e JOIN room_memberships m ON m.event_id = e.event_id WHERE m.user_id = '${bob.userId}' AND m.membership = 'join' ORDER BY e.stream_ordering DESC LIMIT 1`,
      );
    }
    assert.match(roomId, /^![A-Za-z0-9._~+\/=:-]+$/, `room id resolved (${roomId})`);  // v12 room IDs have no server part
    const types = Object.fromEntries(
      sql(`SELECT type, count(*) FROM events WHERE room_id = '${roomId}' GROUP BY type`)
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("|")),
    );
    assert.ok(Number(types["m.room.encrypted"] ?? 0) >= 2, `encrypted events present: ${JSON.stringify(types)}`);
    assert.equal(types["m.room.message"], undefined, `no plaintext message events: ${JSON.stringify(types)}`);
    assert.ok(types["m.room.encryption"], "room has m.room.encryption state");
  });

  await step("homeserver database: the plaintext markers appear nowhere in the event store", async () => {
    for (const marker of [markerA, markerB]) {
      assert.equal(sql(`SELECT count(*) FROM event_json WHERE json LIKE '%${marker}%'`), "0", marker);
    }
    // Sanity check of the method: the room's (unencrypted) membership events are findable.
    assert.notEqual(sql(`SELECT count(*) FROM event_json WHERE room_id = '${roomId}' AND json LIKE '%${bob.username}%'`), "0");
  });

  await step("no CSP violations or page errors in the deployed app", async () => {
    // 4xx answers from the Matrix API are part of the protocol (e.g. 404 for "no key
    // backup yet", 429 for the login rate limit handled above): listed, not failures.
    // Browser "Failed to load resource" lines duplicate the HTTP lines.
    const all = [...alice.problems, ...bob.problems];
    const info = [...new Set(all.filter((p) => /^HTTP 4\d\d /.test(p)))];
    if (info.length) console.log(`     (Matrix API 4xx responses seen: ${info.join("; ")})`);
    const unexpected = all.filter((p) => !/^Failed to load resource/.test(p) && !/^HTTP 4\d\d /.test(p));
    assert.deepEqual(unexpected, []);
  });
} catch {
  // reported by step()
} finally {
  await browser.close();
  console.log(`\ndeployed e2ee: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
