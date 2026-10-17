/**
 * Web side of the Android end-to-end test (driven by tests/apps/android-e2e/run.sh).
 *
 *   node web-user.mjs account --base HOST --file FILE
 *       Signs up the portal account the Android app will sign in with. Writes
 *       {"username", "password", "userId"} to FILE (mode 0600). The password is generated here and
 *       never printed.
 *
 *   node web-user.mjs peer --base HOST --peer @a:HOST --send MARK --expect MARK --state DIR [--out DIR]
 *       User B in the deployed web app (https://app.HOST/): signs up, signs in through SSO, checks
 *       on the server that A's device has published its keys, opens an encrypted direct chat with A
 *       and sends a message containing --send. Writes DIR/sent.json ({userId, roomId}) for the
 *       Android phase, then waits for A's reply containing --expect and requires it decrypted.
 *       Finally checks the homeserver database: the room holds only m.room.encrypted message events
 *       and neither marker appears in the event store.
 *
 * The browser trusts the server's private test CA through the NSS database ($HOME/.pki/nssdb), the
 * way Chrome on Linux trusts a CA a person imports; certificate errors are never ignored.
 * Database checks run `lumenctl compose exec postgres psql` (as root, through sudo -n when needed).
 * Prints PASS/FAIL lines; exit status 0 only if every step passed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};
const base = opt("base");
if (!base || !/^[a-z0-9.-]+$/.test(base)) {
  console.error("usage: web-user.mjs account|peer --base HOST ...");
  process.exit(64);
}
const app = `https://app.${base}`;
const outDir = opt("out", path.join(HERE, "output"));
fs.mkdirSync(outDir, { recursive: true });
const T = 60_000;
const LUMENCTL = process.env.LUMENCTL || "/opt/lumen/lumenctl";
const MXID = /^@[a-z0-9._=/+-]+:[a-z0-9.-]+$/;

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

let passed = 0;
let failed = 0;
async function step(name, fn) {
  const started = Date.now();
  try {
    const r = await fn();
    passed++;
    console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)} s)`);
    return r;
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(err?.message || err).split("\n").slice(0, 8).join("\n     ")}`);
    throw err;
  }
}

function sql(query) {
  const argv = [LUMENCTL, "compose", "exec", "-T", "postgres", "psql", "-qAtU", "postgres", "-d", "synapse", "-c", query];
  const [cmd, ...args] = process.getuid?.() === 0 ? argv : ["sudo", "-n", ...argv];
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  return { ctx, page };
}

/** The browser must trust the server through the test CA (no ignored certificate errors). */
async function checkTrust(page) {
  const r = await page.goto(`https://${base}/healthz`).catch((e) => {
    throw new Error(`HTTPS to ${base} failed in the browser (is the test CA in $HOME/.pki/nssdb?): ${e.message.split("\n")[0]}`);
  });
  assert.equal(r.status(), 200, `https://${base}/healthz answered ${r.status()}`);
}

async function signUp(page, username, password, displayName) {
  await page.goto(`https://${base}/accounts/signup/`);
  await page.fill("input[name=username]", username);
  if (await page.locator("input[name=display_name]").count()) await page.fill("input[name=display_name]", displayName);
  await page.fill("input[name=email]", `${username}@example.org`);
  await page.fill("input[name=password1]", password);
  await page.fill("input[name=password2]", password);
  await page.check("input[name=accept_terms]");
  await Promise.all([page.waitForNavigation(), page.locator("main form button[type=submit]").click()]);
  assert.match(page.url(), /\/portal\/dashboard\/$/, `sign-up ended at ${new URL(page.url()).pathname}`);
}

async function signInToWebApp(page, userId) {
  // The homeserver rate-limits logins per client address; retry when the app says so.
  for (let attempt = 1; ; attempt++) {
    await page.goto(app + "/");
    await page.getByRole("button", { name: /Continue with your .* account/ }).click();
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
    if ((await limited.count()) && attempt < 6) {
      console.log(`     (homeserver login rate limit; retrying in 60 s, attempt ${attempt})`);
      await page.waitForTimeout(60_000);
      continue;
    }
    break;
  }
  await page.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: T });
  assert.ok(!page.url().includes("loginToken"), "login token removed from the address bar");
  assert.equal((await page.locator(".user-chip-id").textContent())?.trim(), userId);
}

const msg = (page, text) => page.locator("article.msg", { has: page.locator(".msg-body", { hasText: text }) });

async function account() {
  const file = opt("file");
  assert.ok(file, "--file FILE is required");
  const username = `droid${randomBytes(4).toString("hex")}`;
  const password = `E2E-Test-${randomBytes(12).toString("hex")}`;
  const browser = await chromium.launch();
  try {
    const { page } = await newPage(browser);
    await step("browser trusts the server's test CA", () => checkTrust(page));
    await step(`portal sign-up for the Android user (${username})`, () => signUp(page, username, password, "Android Tester"));
  } finally {
    await browser.close();
  }
  fs.writeFileSync(file, JSON.stringify({ username, password, userId: `@${username}:${base}` }), { mode: 0o600 });
}

async function peer() {
  const peerId = opt("peer");
  const send = opt("send");
  const expect = opt("expect");
  const state = opt("state");
  const waitMinutes = Number(opt("wait-minutes", "15"));
  assert.match(peerId ?? "", MXID, "--peer @user:server");
  assert.match(send ?? "", /^[A-Za-z0-9-]{8,}$/, "--send MARKER");
  assert.match(expect ?? "", /^[A-Za-z0-9-]{8,}$/, "--expect MARKER");
  assert.ok(state, "--state DIR");
  fs.mkdirSync(state, { recursive: true });

  const username = `webpeer${randomBytes(4).toString("hex")}`;
  const password = `E2E-Test-${randomBytes(12).toString("hex")}`;
  const userId = `@${username}:${base}`;
  const browser = await chromium.launch();
  const { page } = await newPage(browser);
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  let roomId = "";
  try {
    await step("browser trusts the server's test CA", () => checkTrust(page));
    await step(`web user signs up on the portal (${userId})`, () => signUp(page, username, password, "Web Tester"));
    await step("web user signs in to the deployed web app through SSO", () => signInToWebApp(page, userId));
    await page.getByRole("button", { name: "Later" }).click();

    await step("server: the Android device has published its identity and one-time keys", async () => {
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        const devKeys = Number(sql(`SELECT count(*) FROM e2e_device_keys_json WHERE user_id = '${peerId}'`));
        const otks = Number(sql(`SELECT count(*) FROM e2e_one_time_keys_json WHERE user_id = '${peerId}'`));
        const fallback = Number(sql(`SELECT count(*) FROM e2e_fallback_keys_json WHERE user_id = '${peerId}'`));
        if (devKeys > 0 && otks + fallback > 0) {
          console.log(`     device keys: ${devKeys}, one-time keys: ${otks}, fallback keys: ${fallback}`);
          return;
        }
        if (Date.now() > deadline) throw new Error(`no keys for ${peerId} (device keys ${devKeys}, one-time ${otks}, fallback ${fallback})`);
        await sleep(3000);
      }
    });

    await step("web user opens an encrypted direct chat with the Android user and writes", async () => {
      await page.getByRole("button", { name: "Start a conversation" }).click();
      await page.getByRole("menuitem", { name: "New direct message" }).click();
      await page.getByLabel("Find people").fill(peerId);
      await page.locator(".user-result").first().click();
      await page.getByRole("button", { name: "Start conversation" }).click();
      await page.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor();
      roomId = decodeURIComponent(new URL(page.url()).hash.match(/!([^/?]+)/)?.[0] ?? "");
      await page.locator("#composer").fill(`Hello from the web ${send}`);
      await page.keyboard.press("Enter");
      await msg(page, send).waitFor();
      if (!roomId.startsWith("!")) {
        roomId = sql(
          `SELECT m.room_id FROM room_memberships m JOIN events e ON e.event_id = m.event_id WHERE m.user_id = '${peerId}' AND m.membership = 'invite' AND m.sender = '${userId}' ORDER BY e.stream_ordering DESC LIMIT 1`,
        );
      }
      assert.match(roomId, /^![A-Za-z0-9._~+/=:-]+$/, `room id (${roomId})`);
      fs.writeFileSync(path.join(state, "sent.json"), JSON.stringify({ userId, roomId }));
    });

    await step("web user sees the Android user's reply, decrypted", async () => {
      await msg(page, expect).waitFor({ timeout: waitMinutes * 60_000 });
      const body = (await msg(page, expect).locator(".msg-body").first().textContent()) ?? "";
      assert.ok(body.includes(`Reply from Android ${expect}`), `reply text: ${body}`);
      await page.screenshot({ path: path.join(outDir, "web-user-conversation.png") });
    });

    await step("server database: the room holds only m.room.encrypted message events", async () => {
      const types = Object.fromEntries(
        sql(`SELECT type, count(*) FROM events WHERE room_id = '${roomId}' GROUP BY type`)
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("|")),
      );
      console.log(`     event types in the room: ${JSON.stringify(types)}`);
      assert.ok(Number(types["m.room.encrypted"] ?? 0) >= 2, "both messages stored as m.room.encrypted");
      assert.equal(types["m.room.message"], undefined, "no plaintext m.room.message events");
      assert.ok(types["m.room.encryption"], "room has m.room.encryption state");
      const androidEncrypted = Number(sql(`SELECT count(*) FROM events WHERE room_id = '${roomId}' AND type = 'm.room.encrypted' AND sender = '${peerId}'`));
      assert.ok(androidEncrypted >= 1, "the Android user's reply is stored encrypted");
    });

    await step("server database: neither message text appears anywhere in the event store", async () => {
      for (const marker of [send, expect]) {
        assert.equal(sql(`SELECT count(*) FROM event_json WHERE json LIKE '%${marker}%'`), "0", marker);
      }
      // The method works: the room's plaintext membership events are found the same way.
      assert.notEqual(sql(`SELECT count(*) FROM event_json WHERE room_id = '${roomId}' AND json LIKE '%${username}%'`), "0");
    });

    if (problems.length) console.log(`     (page errors seen: ${problems.join("; ")})`);
  } catch {
    await page.screenshot({ path: path.join(outDir, "web-user-failure.png") }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

try {
  if (command === "account") await account();
  else if (command === "peer") await peer();
  else throw new Error(`unknown command ${command}`);
} catch (err) {
  if (!failed) {
    failed++;
    console.log(`FAIL ${command}: ${String(err?.message || err).split("\n")[0]}`);
  }
}
console.log(`web user (${command}): ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
