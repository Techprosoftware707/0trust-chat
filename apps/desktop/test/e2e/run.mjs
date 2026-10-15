#!/usr/bin/env node
/**
 * End-to-end test of the desktop app against the dev Lumen stack (Linux, Xvfb).
 *
 *   (a) first run: server picker → discovery of lumen.test → web client sign-in screen
 *   (b) SSO in the "system browser" with the io.lumen.secure callback delivered like the OS
 *       does (second launch with the URL); stray / replayed callbacks are ignored
 *   (c) end-to-end encrypted DM both ways with a web user (Chromium on https://app.lumen.test)
 *   (e) OS notification created by the main process; clicking it opens the room
 *   (d) call desktop ↔ web: connected, media received (getStats), E2EE label; screen share
 *       from the desktop through the app's source picker
 *   (f) app lock with PIN (wrong PIN refused, right PIN unlocks, OS lock-screen event locks)
 *   (h) no access token / store key / crypto-store passphrase in plaintext under userData
 *   (g) sign-out wipes the store key and browser storage; the old token is dead
 *
 *   npm run test:e2e            (runs itself under xvfb-run when there is no DISPLAY)
 *   --keep                      keep the temporary HOME directories
 *   --only <regex>              run only matching steps (the setup steps always run)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux" && !process.env.DISPLAY) {
  const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { _electron, chromium } = await import("playwright");
const env = await import("./lib/env.mjs");
const { scanForSecrets } = await import("./lib/scan.mjs");
const { APP_DIR, OUT, BASE, WEB, HS, ELECTRON } = env;

const T = 60_000;
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const ONLY = argv.includes("--only") ? new RegExp(argv[argv.indexOf("--only") + 1], "i") : null;
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------------------
const lines = [];
let passed = 0;
let failed = 0;
const log = (...p) => {
  const l = p.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  lines.push(l);
  console.log(l);
};
async function step(name, fn, { always = false } = {}) {
  if (ONLY && !always && !ONLY.test(name)) {
    log(`- skip  ${name}`);
    return;
  }
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    log(`✔ pass  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    log(`✘ FAIL  ${name}: ${e?.stack ?? e}`);
    await shot(`fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`).catch(() => undefined);
    if (always) throw e;
  }
}

// ---------------------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------------------
const appHome = env.makeHome("app");
const browserHome = env.makeHome("browser");
const opener = env.fakeOpener(appHome);
if (process.platform === "linux") spawnSync("sh", [path.join(APP_DIR, "test/e2e/setup-linux-deps.sh")], { stdio: "inherit" });
let notifyService = null;
try {
  notifyService = await env.startNotificationService(appHome);
} catch (e) {
  console.log(`(no Linux notification service for the test: ${e.message})`);
}
const appEnv = { ...env.appEnv(appHome, opener.bin), ...(notifyService?.env ?? {}) };
const userData = env.userDataDir(appHome);
const mainLog = () => {
  try {
    return fs.readFileSync(path.join(userData, "logs", "main.log"), "utf8");
  } catch {
    return "";
  }
};
log(`desktop e2e against ${BASE} — Electron ${ELECTRON}`);
log(`app HOME ${appHome} (userData ${userData}); running as root: ${env.IS_ROOT} (adds --no-sandbox, test harness only)`);

/** Test-only instrumentation (not part of the app): remember RTCPeerConnections for getStats. */
function instrument() {
  const Native = window.RTCPeerConnection;
  if (!Native || window.__lumenTestPcs) return;
  const pcs = [];
  window.__lumenTestPcs = pcs;
  window.RTCPeerConnection = new Proxy(Native, {
    construct(target, args) {
      const pc = Reflect.construct(target, args);
      pcs.push(pc);
      return pc;
    },
  });
}

const app = await _electron.launch({ executablePath: ELECTRON, args: env.appArgs(env.toneFile(523)), env: appEnv, timeout: T });
await app.context().addInitScript(instrument);
app.process().stdout?.on("data", (d) => fs.appendFileSync(path.join(OUT, "app-stdout.log"), d));
app.process().stderr?.on("data", (d) => fs.appendFileSync(path.join(OUT, "app-stdout.log"), d));
let win = await app.firstWindow();
// Playwright occasionally attaches to the window after its first navigation committed and then
// reports an empty URL for it; a reload resynchronises it (first run: the server picker).
for (let i = 0; i < 50 && !win.url(); i++) await new Promise((r) => setTimeout(r, 200));
if (!win.url()) await win.reload();
const cspProblems = [];
const watchPage = (p, who) => {
  p.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|create|connect)/i.test(m.text())) cspProblems.push(`${who}: ${m.text()}`);
  });
  p.on("pageerror", (e) => log(`  [${who} pageerror] ${e.message}`));
};
watchPage(win, "desktop");

const browser = await chromium.launch({
  executablePath: env.chromeBinary(),
  headless: true,
  args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${env.toneFile(330)}`, "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  env: { ...process.env, HOME: browserHome, no_proxy: env.noProxy(), NO_PROXY: env.noProxy() },
});
async function shot(name) {
  // (a hidden window renders no frames: don't let a screenshot fail a step)
  if (win && !win.isClosed()) await win.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 5000 }).catch(() => undefined);
}
const showAppWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://lumen"))?.show());

// accounts: A = desktop user, B = web user
const A = env.account("a", "Desktop Dana");
const B = env.account("b", "Web Wes");
const sysCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); // A's "system browser"
const sysPage = await sysCtx.newPage();
const bCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone", "camera"] });
await bCtx.addInitScript(instrument);
const bPage = await bCtx.newPage();
watchPage(bPage, "web");

let tokenA = null;
let tokenB = null;
let roomId = null;
win.on("response", async (r) => {
  if (r.url() === `${HS}/_matrix/client/v3/login` && r.request().method() === "POST" && r.status() === 200) tokenA = (await r.json().catch(() => null))?.access_token ?? tokenA;
});

async function dismissFirstRunPrompts(page) {
  for (let i = 0; i < 4; i++) {
    const later = page.getByRole("dialog").getByRole("button", { name: /^(Later|Not now|Skip)$/ });
    if (await later.count()) await later.first().click().catch(() => undefined);
    else await page.waitForTimeout(700);
  }
}

// =======================================================================================
try {
  await step(
    "(a) first run: server picker, discovery of lumen.test, web client sign-in screen",
    async () => {
      await win.waitForURL("app://desktop/setup.html", { timeout: T });
      await win.locator("#server-input").waitFor({ timeout: T });
      await shot("01-server-picker");
      await win.fill("#server-input", BASE);
      await win.click("#continue");
      await win.locator("#step-confirm").waitFor({ state: "visible", timeout: T });
      const facts = Object.fromEntries(
        await win.$$eval("#step-confirm dl dt", (dts) => dts.map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ""])),
      );
      log("  discovered:", facts);
      assert.equal(facts.Server, BASE);
      assert.equal(facts.Homeserver, HS);
      assert.match(facts["Sign-in"], /Single sign-on/);
      await shot("02-server-confirm");
      await win.click("#connect");
      await win.waitForURL("app://lumen/", { timeout: T });
      await win.getByRole("button", { name: /Continue with your .* account/ }).waitFor({ timeout: T });
      const cfg = await win.evaluate(() => fetch("/config.json").then((r) => r.json()));
      log("  synthesized config.json:", cfg);
      assert.equal(cfg.homeserver.base_url, HS);
      assert.equal(cfg.homeserver.server_name, BASE);
      assert.equal(cfg.sso?.idp_id, "oidc-lumen");
      assert.equal(cfg.allow_custom_homeserver, false);
      const csp = await win.evaluate(() => fetch("/").then((r) => r.headers.get("content-security-policy")));
      log("  CSP:", csp);
      assert.match(csp, new RegExp(`connect-src 'self' ${HS.replace(/\./g, "\\.")} `));
      assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'| https: | wss: /);
      const api = await win.evaluate(() => ({ desktop: typeof window.lumenDesktop, version: window.lumenDesktop?.version, require: typeof require, process: typeof process }));
      const prot = await win.evaluate(() => window.lumenDesktop.storageProtection());
      log("  storage protection:", prot);
      if (prot.level !== "os") {
        const warning = win.getByTestId("keyring-warning");
        await warning.waitFor({ timeout: T });
        log(`  visible warning: "${(await warning.innerText()).trim()}"`);
      }
      assert.deepEqual(api, { desktop: "object", version: 1, require: "undefined", process: "undefined" });
      await shot("03-sign-in");
    },
    { always: true },
  );

  await step(
    "(b) SSO in the system browser; stray and replayed io.lumen.secure callbacks are ignored",
    async () => {
      if (A.isNew) await env.portalSignUp(sysPage, A);
      if (B.isNew) await env.portalSignUp(bPage, B);
      log(`  accounts: A=${A.userId} (desktop), B=${B.userId} (web)`);

      const before = opener.urls().length;
      await win.getByRole("button", { name: /Continue with your .* account/ }).click();
      await win.getByText("Continue in your web browser").waitFor({ timeout: T });
      await win.waitForFunction(() => true);
      for (let i = 0; i < 50 && opener.urls().length === before; i++) await new Promise((r) => setTimeout(r, 200));
      const ssoUrl = opener.urls().at(-1);
      log("  app opened in the system browser:", ssoUrl.replace(/n%3D[^&]+/, "n%3D<nonce>"));
      const m = /^https:\/\/matrix\.[^/]+\/_matrix\/client\/v3\/login\/sso\/redirect\/oidc-lumen\?redirectUrl=io\.lumen\.secure%3A%2Fsso-callback%3Fn%3D([A-Za-z0-9_-]{20,})$/.exec(ssoUrl);
      assert.ok(m, `unexpected SSO URL ${ssoUrl}`);
      const nonce = m[1];

      // A forged callback without the nonce, and one with a wrong nonce: both ignored.
      const forged = await env.deliverAsOs(appEnv, "io.lumen.secure:/sso-callback?loginToken=forged_token_1");
      const wrong = await env.deliverAsOs(appEnv, "io.lumen.secure:/sso-callback?n=not-the-nonce&loginToken=forged_token_2");
      log(`  stray callbacks delivered (second instances exited ${forged.code}, ${wrong.code})`);
      await win.waitForTimeout(1500);
      assert.equal((mainLog().match(/ignored an io\.lumen\.secure link/g) ?? []).length >= 2, true, "stray callbacks must be logged as ignored");
      assert.ok(await win.getByText("Continue in your web browser").isVisible(), "still waiting for the real callback");

      // The user signs in in the browser; the homeserver redirects to the app's scheme.
      const callback = await env.browserSso(sysPage, ssoUrl, A);
      assert.ok(callback.startsWith(`io.lumen.secure:/sso-callback?n=${nonce}&loginToken=`), `callback ${callback.replace(/loginToken=.*/, "loginToken=…")}`);
      log("  browser was redirected to io.lumen.secure:/sso-callback?n=<nonce>&loginToken=<…>");
      for (const n of env.browserNotes) log(`  ${n}`);
      const delivered = await env.deliverAsOs(appEnv, callback);
      log(`  callback delivered as the OS would (second instance exit code ${delivered.code})`);
      await win.locator(".user-chip-id").waitFor({ timeout: T });
      assert.equal((await win.locator(".user-chip-id").textContent())?.trim(), A.userId);
      assert.match(mainLog(), /sign-in callback accepted/);
      await shot("04-signed-in");
      await dismissFirstRunPrompts(win);

      // Replay of the same (used) callback: ignored, nothing changes.
      const ignoredBefore = (mainLog().match(/ignored an io\.lumen\.secure link/g) ?? []).length;
      await env.deliverAsOs(appEnv, callback);
      await win.waitForTimeout(1000);
      assert.equal((mainLog().match(/ignored an io\.lumen\.secure link/g) ?? []).length, ignoredBefore + 1, "replayed callback ignored");

      const device = await env.request(`${HS}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${tokenA}` } });
      assert.equal(device.json?.user_id, A.userId);
      const devs = await env.request(`${HS}/_matrix/client/v3/devices`, { headers: { Authorization: `Bearer ${tokenA}` } });
      const mine = devs.json.devices.find((d) => d.device_id === device.json.device_id);
      log(`  device display name: ${mine?.display_name}`);
      assert.match(mine?.display_name ?? "", /Desktop \(Linux\)$/);
    },
    { always: true },
  );

  await step(
    "web user B signs in on https://app.lumen.test (normal web SSO)",
    async () => {
      bPage.on("response", async (r) => {
        if (r.url() === `${HS}/_matrix/client/v3/login` && r.request().method() === "POST" && r.status() === 200) tokenB = (await r.json().catch(() => null))?.access_token ?? tokenB;
      });
      await bPage.goto(`${WEB}/`);
      await bPage.getByRole("button", { name: /Continue with your .* account/ }).click({ timeout: T });
      for (let i = 0; i < 12 && !bPage.url().startsWith(WEB); i++) {
        await bPage.waitForLoadState("domcontentloaded");
        if (bPage.url().startsWith(WEB)) break;
        if (await bPage.locator("input[name=login]").count()) {
          await bPage.fill("input[name=login]", B.username);
          await bPage.fill("input[name=password]", B.password);
          await Promise.all([bPage.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), bPage.locator("form button[type=submit]").last().click()]);
          continue;
        }
        const next = bPage.locator("a:has-text('Continue'), button:has-text('Continue'), button:has-text('Allow')");
        if (await next.count()) await Promise.all([bPage.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), next.first().click()]);
        else await bPage.waitForTimeout(1000);
      }
      await bPage.locator(".user-chip-id").waitFor({ timeout: T });
      await dismissFirstRunPrompts(bPage);
      assert.ok(tokenB, "web login token captured");
    },
    { always: true },
  );

  await step("(c) encrypted DM both ways: desktop → web and web → desktop", async () => {
    await win.getByRole("button", { name: "Start a conversation" }).click();
    await win.getByRole("menuitem", { name: "New direct message" }).click();
    await win.getByLabel("Find people").fill(B.userId);
    await win.locator(".user-result").first().click({ timeout: T });
    await win.getByRole("button", { name: "Start conversation" }).click();
    await win.locator(".room-header .room-title", { hasText: B.displayName }).waitFor({ timeout: T });
    await win.waitForFunction(() => /#\/room\//.test(location.hash), null, { timeout: T });
    roomId = await win.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/room\//, "").split("/")[0]));
    log(`  DM room ${roomId}`);
    const hello = `Hello from the desktop app ${Date.now()}`;
    await win.locator("#composer").fill(hello);
    await win.keyboard.press("Enter");

    await bPage.goto(`${WEB}/#/room/${encodeURIComponent(roomId)}`);
    const accept = bPage.locator(".empty-card").getByRole("button", { name: "Accept" });
    await accept.or(bPage.locator(".room-header")).first().waitFor({ timeout: T });
    if (await accept.count()) await accept.click();
    await bPage.locator("p", { hasText: hello }).first().waitFor({ timeout: T });
    log("  web user B decrypted the desktop message");

    const reply = `Hello from the web ${Date.now()}`;
    await bPage.locator("#composer").fill(reply);
    await bPage.keyboard.press("Enter");
    await win.locator("p", { hasText: reply }).first().waitFor({ timeout: T });
    log("  desktop user A decrypted the web reply");
    await shot("05-dm");

    // What the server stores: only m.room.encrypted, no plaintext.
    const msgs = await env.request(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=30`, { headers: { Authorization: `Bearer ${tokenB}` } });
    const types = msgs.json.chunk.map((e) => e.type);
    assert.ok(types.includes("m.room.encrypted"), `encrypted events on the server (${types.join(",")})`);
    assert.ok(!msgs.text.includes(hello) && !msgs.text.includes(reply), "no plaintext on the server");
    assert.ok(!types.includes("m.room.message"), "no unencrypted messages");
  });

  await step("(e) OS notification from the main process; click opens the room", async () => {
    try {
      await notificationTest();
    } finally {
      await showAppWindow();
    }
  });

  async function notificationTest() {
    // Turn notifications on in the web client's settings (permission via the app's handler).
    await win.getByRole("button", { name: "Settings" }).click();
    await win.getByRole("tab", { name: "Notifications" }).click();
    const toggle = win.getByRole("switch", { name: "Desktop notifications" }).or(win.getByLabel("Desktop notifications"));
    await toggle.first().click();
    await win.waitForFunction(() => JSON.parse(localStorage.getItem("lumen-chat-prefs") || "{}").notifications === true, null, { timeout: T });
    await win.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await win.evaluate(() => (location.hash = "#/"));

    // Listen for notifications the main process creates (wraps show(); the real one still runs).
    await app.evaluate(({ Notification }) => {
      globalThis.__shown = [];
      const orig = Notification.prototype.show;
      Notification.prototype.show = function () {
        globalThis.__shown.push(this);
        return orig.call(this);
      };
    });
    // Playwright makes pages believe they are always focused (focus emulation): turn that off
    // so the web client sees the real window state, as it would outside the test.
    const cdp = await win.context().newCDPSession(win);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    // Close the window: the app keeps running in the tray (window hidden, not focused).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://lumen"))?.close());
    await win.waitForFunction(() => !document.hasFocus(), null, { timeout: 10_000 });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://lumen"))?.isVisible()), false, "window hidden");
    const stillRunning = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.ok(stillRunning >= 1, "closing the window keeps the app running");

    assert.ok(notifyService, "test notification service running");
    const supported = await app.evaluate(({ Notification }) => Notification.isSupported());
    assert.equal(supported, true, "Electron sees an OS notification service");
    const before = notifyService.notifications().length;
    const text = `Ping for a notification ${Date.now()}`;
    await bPage.locator("#composer").fill(text);
    await bPage.keyboard.press("Enter");
    let shown = [];
    let all = [];
    for (let i = 0; i < 60 && !shown.length; i++) {
      all = await app.evaluate(() => globalThis.__shown.map((n) => ({ title: n.title, body: n.body, silent: n.silent })));
      shown = all.filter((n) => !/still running/.test(n.title));
      if (!shown.length) await new Promise((r) => setTimeout(r, 500));
    }
    const hintShown = all.find((n) => /still running/.test(n.title));
    log(`  first close to the tray showed the hint: "${hintShown?.title ?? "(none)"}"`);
    log("  notification(s) created by the main process:", shown);
    assert.ok(shown.length >= 1, "a notification was created");
    assert.equal(shown[0].title, B.displayName);
    assert.equal(shown[0].body, "New encrypted message", "previews are hidden by default");
    assert.ok(!JSON.stringify(shown).includes(text), "message text not in the notification");
    let osSide = [];
    for (let i = 0; i < 20 && osSide.length <= before; i++) {
      osSide = notifyService.notifications();
      if (osSide.length <= before) await new Promise((r) => setTimeout(r, 250));
    }
    const delivered = osSide.slice(before).filter((n) => !/still running/.test(n.summary));
    log("  received by the OS notification service (D-Bus):", delivered);
    assert.ok(delivered.some((n) => n.summary === B.displayName && n.body === "New encrypted message"), "delivered over D-Bus");
    // The user clicks it: the notification service emits ActionInvoked("default").
    notifyService.click(delivered.at(-1).id);
    await win.waitForFunction((id) => decodeURIComponent(location.hash) === `#/room/${id}`, roomId, { timeout: 10_000 });
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://lumen"))?.isVisible());
    assert.equal(visible, true, "click shows the window again");
    log("  click on the notification showed the window and opened the room");
  }

  async function openDesktopSettings() {
    const existing = app.windows().find((p) => p.url() === "app://desktop/settings.html");
    if (existing) return existing;
    const settingsPromise = app.waitForEvent("window", { timeout: T });
    await app.evaluate(({ Menu }) => {
      const find = (items) => {
        for (const i of items) {
          if (/Desktop settings|Settings…/.test(i.label)) return i;
          const sub = i.submenu && find(i.submenu.items);
          if (sub) return sub;
        }
        return null;
      };
      find(Menu.getApplicationMenu().items).click();
    });
    const settings = await settingsPromise;
    await settings.waitForURL("app://desktop/settings.html", { timeout: T });
    await settings.locator("#dnd").waitFor({ timeout: T });
    return settings;
  }

  await step("(e2) Do not disturb suppresses notifications; unread badge reported", async () => {
    const settings = await openDesktopSettings();
    await settings.check("#dnd");
    await settings.waitForTimeout(300);
    const before = await app.evaluate(() => globalThis.__shown?.length ?? 0);
    const osBefore = notifyService.notifications().length;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://lumen"))?.hide());
    await win.waitForFunction(() => !document.hasFocus(), null, { timeout: 10_000 });
    await win.evaluate(() => (location.hash = "#/"));
    const text = `While do-not-disturb is on ${Date.now()}`;
    await bPage.locator("#composer").fill(text);
    await bPage.keyboard.press("Enter");
    await win.locator(".room-preview", { hasText: text }).first().waitFor({ timeout: T });
    await win.waitForTimeout(3000);
    assert.equal(await app.evaluate(() => globalThis.__shown?.length ?? 0), before, "no notification while do-not-disturb is on");
    assert.equal(notifyService.notifications().length, osBefore, "nothing reached the OS notification service");
    log("  message arrived (decrypted in the room list), no notification while do-not-disturb is on");
    const badge = await app.evaluate(({ app }) => app.getBadgeCount());
    log(`  app.getBadgeCount() = ${badge} (Linux only shows it on Unity-style launchers)`);
    await settings.uncheck("#dnd");
    const updateMsg = await settings.locator("#update-msg").innerText();
    log(`  updates: "${updateMsg}"`);
    await settings.close();
    await showAppWindow();
  });

  async function hangUp() {
    for (const p of [win, bPage]) {
      const btn = p.getByRole("button", { name: "Leave call" });
      if (await btn.count()) await btn.click().catch(() => undefined);
      const close = p.locator(".call-screen").getByRole("button", { name: "Close" });
      if (await close.count()) await close.click().catch(() => undefined);
    }
    for (const p of [win, bPage]) await p.locator(".call-screen").waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  }

  await step("(d) call desktop ↔ web: connected, media both ways, E2EE label; screen share from the desktop", async () => {
    try {
      await callTest();
    } finally {
      await hangUp();
    }
  });

  async function callTest() {
    await win.evaluate((id) => (location.hash = `#/room/${encodeURIComponent(id)}`), roomId);
    await win.locator(".room-header").waitFor({ timeout: T });
    // B (web) starts a video call; A (desktop) accepts with video.
    await bPage.locator(".room-header").getByRole("button", { name: "Video call" }).click({ timeout: T });
    const lobby = bPage.getByRole("dialog");
    const allow = lobby.getByRole("button", { name: /^Allow/ });
    const start = lobby.getByRole("button", { name: /(Start|Join) call/ });
    await allow.or(start).first().waitFor({ timeout: T });
    if (await allow.count()) await allow.click();
    await bPage.waitForFunction(() => !document.querySelector("dialog .spinner"), null, { timeout: T });
    await start.click();
    await bPage.locator(".call-screen").waitFor({ timeout: T });

    const card = win.locator(".incoming-call").first();
    await card.waitFor({ timeout: T });
    await shot("06-incoming-call");
    await card.getByRole("button", { name: /^(Video|Join with video)$/ }).click();
    await win.locator(".call-screen").waitFor({ timeout: T });
    for (const [who, p] of [["desktop", win], ["web", bPage]]) {
      await p.locator('.call-screen[data-phase="connected"]').waitFor({ timeout: T });
      await p.locator('[data-testid="call-e2ee"]').waitFor({ timeout: 45_000 });
      log(`  ${who}: connected, label "${(await p.locator('[data-testid="call-e2ee"]').innerText()).trim()}"`);
    }
    await win.waitForTimeout(5000);
    const inbound = async (p) =>
      p.evaluate(async () => {
        const rows = [];
        for (const pc of window.__lumenTestPcs ?? []) {
          if (pc.connectionState === "closed") continue;
          (await pc.getStats()).forEach((s) => {
            if (s.type === "inbound-rtp") rows.push({ kind: s.kind, bytes: s.bytesReceived, frames: s.framesDecoded ?? null });
          });
        }
        return rows;
      });
    const inA = await inbound(win);
    const inB = await inbound(bPage);
    log("  desktop inbound-rtp:", inA);
    log("  web inbound-rtp:", inB);
    for (const [who, rows] of [["desktop", inA], ["web", inB]]) {
      assert.ok(rows.some((r) => r.kind === "audio" && r.bytes > 0), `${who} receives audio`);
      assert.ok(rows.some((r) => r.kind === "video" && r.bytes > 0), `${who} receives video`);
    }
    await shot("07-call-connected");

    // Screen share: the desktop's own source picker (desktopCapturer).
    const pickerPromise = app.waitForEvent("window", { timeout: T });
    await win.getByRole("button", { name: "Share your screen" }).click();
    const picker = await pickerPromise;
    await picker.waitForURL("app://desktop/picker.html", { timeout: T });
    await picker.locator(".source").first().waitFor({ timeout: T });
    const sources = await picker.$$eval(".source span", (els) => els.map((e) => e.textContent));
    log("  picker sources:", sources);
    await picker.screenshot({ path: path.join(SHOTS, "08-screen-picker.png") });
    await picker.locator("#screens .source").first().click();
    await picker.click("#share", { noWaitAfter: true }).catch((e) => {
      if (!/closed/.test(String(e))) throw e; // the picker closes itself once a source is chosen
    });
    await win.getByRole("button", { name: "Stop sharing your screen" }).waitFor({ timeout: T });
    const screenTile = bPage.locator(`.call-tile.screen[data-participant="${A.userId}"] video`);
    await screenTile.waitFor({ timeout: T });
    await bPage.waitForTimeout(4000);
    const inB2 = await inbound(bPage);
    const videoIn = inB2.filter((r) => r.kind === "video" && r.bytes > 0);
    log("  web inbound video streams while sharing:", videoIn);
    assert.ok(videoIn.length >= 2, "web receives camera and screen video from the desktop");
    await bPage.screenshot({ path: path.join(SHOTS, "09-web-sees-desktop-screen.png") });
    await win.getByRole("button", { name: "Stop sharing your screen" }).click();
  }

  await step("(f) app lock: PIN set in desktop settings, lock hides the app, wrong PIN refused, right PIN unlocks, OS lock event locks", async () => {
    const settings = await openDesktopSettings();
    await settings.locator("#pin-new").waitFor({ timeout: T });
    const storageText = await settings.locator("#storage").innerText();
    log(`  key storage: ${storageText}`);
    await settings.fill("#pin-new", "246810");
    await settings.fill("#pin-repeat", "246810");
    await settings.click("#pin-save");
    await settings.getByText("PIN saved.").waitFor({ timeout: T });
    await settings.screenshot({ path: path.join(SHOTS, "10-desktop-settings.png") });
    const lockPromise = app.waitForEvent("window", { timeout: T });
    await settings.click("#lock-now");
    const lockPage = await lockPromise;
    await lockPage.waitForURL("app://desktop/lock.html", { timeout: T });
    await lockPage.locator("#pin").waitFor({ timeout: T });
    const hidden = await win.evaluate(() => ({ visibility: getComputedStyle(document.documentElement).visibility, locked: document.documentElement.hasAttribute("data-lumen-locked"), inert: document.body.inert }));
    log("  web client while locked:", hidden);
    assert.deepEqual(hidden, { visibility: "hidden", locked: true, inert: true });
    await shot("11-locked");
    await lockPage.fill("#pin", "000000");
    await lockPage.click("#unlock");
    await lockPage.getByText("Wrong PIN.").waitFor({ timeout: T });
    await lockPage.fill("#pin", "246810");
    await lockPage.click("#unlock");
    await win.waitForFunction(() => !document.documentElement.hasAttribute("data-lumen-locked"), null, { timeout: T });
    assert.equal(await win.evaluate(() => getComputedStyle(document.documentElement).visibility), "visible");
    log("  unlocked with the PIN");

    // The OS locking the screen locks the app (powerMonitor 'lock-screen').
    const lock2 = app.waitForEvent("window", { timeout: T });
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    const lockPage2 = await lock2;
    await lockPage2.waitForURL("app://desktop/lock.html", { timeout: T });
    await win.waitForFunction(() => document.documentElement.hasAttribute("data-lumen-locked"), null, { timeout: T });
    await lockPage2.fill("#pin", "246810");
    await lockPage2.click("#unlock");
    await win.waitForFunction(() => !document.documentElement.hasAttribute("data-lumen-locked"), null, { timeout: T });
    log("  OS lock-screen event locked the app; unlocked again");
    const verifierFile = fs.readFileSync(path.join(userData, "applock.bin"));
    assert.ok(!verifierFile.includes(Buffer.from("246810")), "PIN not stored");
    assert.ok(!verifierFile.includes(Buffer.from('"PBKDF2-SHA-256"')), "verifier stored encrypted (safeStorage), not as plain JSON");
  });

  let secrets = null;
  await step("(h) no access token, store key or crypto-store passphrase in plaintext under userData", async () => {
    assert.ok(tokenA, "desktop access token captured from the login response");
    const keyAndPass = await win.evaluate(async () => {
      const key = await window.lumenDesktop.storeKey.get();
      const meta = JSON.parse(localStorage.getItem("lumen-session"));
      const ck = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["decrypt"]);
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("lumen-session");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const rec = await new Promise((res, rej) => {
        const r = db.transaction("secrets").objectStore("secrets").get(`${meta.userId}|${meta.deviceId}`);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const keys = await new Promise((res) => {
        const r = db.transaction("pickle-keys").objectStore("pickle-keys").count();
        r.onsuccess = () => res(r.result);
      });
      db.close();
      const ctx = `lumen:storage-password:${meta.userId}:${meta.deviceId}`;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.storagePassword.iv, additionalData: new TextEncoder().encode(ctx) }, ck, rec.storagePassword.ct);
      return { key: Array.from(key), storagePassword: new TextDecoder().decode(pt), pickleKeysInIdb: keys };
    });
    assert.equal(keyAndPass.pickleKeysInIdb, 0, "no browser key in IndexedDB on desktop");
    secrets = { "access token": tokenA, "store key": Uint8Array.from(keyAndPass.key), "crypto-store passphrase": keyAndPass.storagePassword, "app PIN": "246810" };
    await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
    await win.waitForTimeout(2000);
    const r = scanForSecrets(userData, secrets);
    log(`  scanned ${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB, ${r.tables} LevelDB tables / ${r.blocks} decompressed blocks`);
    // Positive control: the (non-secret) user ID is on disk in plaintext; the scanner must find it.
    const control = scanForSecrets(userData, { "user ID (control)": A.userId });
    log(`  positive control (user ID, stored in plaintext by design): ${control.hits.length} hit(s), e.g. ${control.hits[0]?.file}`);
    assert.ok(control.hits.length > 0, "scanner positive control");
    log("  secret hits:", r.hits);
    assert.deepEqual(r.hits, [], "no secret in plaintext");
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    log("  persisted window state:", saved.window);
    assert.ok(saved.window && saved.window.width >= 380, "window state persisted");
    const keyFile = fs.readFileSync(path.join(userData, "store-key.bin"));
    log(`  store-key.bin: ${keyFile.length} bytes, prefix ${JSON.stringify(keyFile.subarray(0, 3).toString("latin1"))} (safeStorage format)`);
  });

  await step("(g) sign-out wipes the store key and the app's browser storage; the token is revoked", async () => {
    await showAppWindow();
    assert.ok(fs.existsSync(path.join(userData, "store-key.bin")));
    await win.getByRole("button", { name: "Sign out" }).click();
    await win.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
    await win.getByText("You've signed out.").waitFor({ timeout: T });
    await win.waitForTimeout(1500);
    assert.equal(fs.existsSync(path.join(userData, "store-key.bin")), false, "store key deleted");
    const idbDir = path.join(userData, "IndexedDB");
    const idb = fs.existsSync(idbDir) ? fs.readdirSync(idbDir) : [];
    log("  IndexedDB directory after sign-out:", idb);
    assert.ok(!idb.some((d) => d.startsWith("app_lumen")), "app origin's IndexedDB deleted");
    const dbs = await win.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    assert.deepEqual(dbs.filter((n) => /lumen|matrix-js-sdk/.test(n ?? "")), [], "no databases left");
    if (secrets) {
      const r = scanForSecrets(userData, secrets);
      log(`  re-scan after sign-out: ${r.files} files, hits: ${JSON.stringify(r.hits)}`);
      assert.deepEqual(r.hits, []);
    }
    const who = await env.request(`${HS}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(who.status, 401, "old access token rejected by the server");
    await shot("12-signed-out");
  });
  await step("(i) Change server…: confirmation, sign-out on the server, local wipe, back to the server picker", async () => {
    // Sign in again (the system browser still has its portal session: GET-only SSO chain).
    tokenA = null;
    const before = opener.urls().length;
    await win.getByRole("button", { name: /Continue with your .* account/ }).click();
    for (let i = 0; i < 50 && opener.urls().length === before; i++) await new Promise((r) => setTimeout(r, 200));
    const callback = await env.browserSso(sysPage, opener.urls().at(-1), A);
    await env.deliverAsOs(appEnv, callback);
    await win.locator(".user-chip-id").waitFor({ timeout: T });
    await dismissFirstRunPrompts(win);
    for (let i = 0; i < 20 && !tokenA; i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(tokenA, "signed in again");
    assert.ok(fs.existsSync(path.join(userData, "store-key.bin")));
    // The user answers the native confirmation with "Sign out and change server" (button 1).
    await app.evaluate(({ dialog }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_w, opts) => {
        globalThis.__asked.push(opts.message);
        return { response: 1, checkboxChecked: false };
      };
    });
    await app.evaluate(({ Menu }) => {
      const find = (items) => {
        for (const i of items) {
          if (i.label === "Change server…") return i;
          const sub = i.submenu && find(i.submenu.items);
          if (sub) return sub;
        }
        return null;
      };
      find(Menu.getApplicationMenu().items).click();
    });
    await win.waitForURL("app://desktop/setup.html", { timeout: T });
    await win.locator("#server-input").waitFor({ timeout: T });
    const asked = await app.evaluate(() => globalThis.__asked);
    log("  confirmation asked:", asked);
    assert.match(asked[0], new RegExp(`Sign out of ${BASE.replace(/\./g, "\\.")}`));
    assert.equal(fs.existsSync(path.join(userData, "server.json")), false, "server configuration removed");
    assert.equal(fs.existsSync(path.join(userData, "store-key.bin")), false, "store key deleted");
    const who = await env.request(`${HS}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(who.status, 401, "signed out on the server first");
    const idbDir = path.join(userData, "IndexedDB");
    assert.ok(!(fs.existsSync(idbDir) ? fs.readdirSync(idbDir) : []).some((d) => d.startsWith("app_lumen")), "IndexedDB wiped");
    log("  back at the server picker; session revoked on the server; local data wiped");
    await shot("13-change-server");
  });
} catch (e) {
  log(`aborted: ${e?.message ?? e}`);
} finally {
  if (cspProblems.length) {
    failed++;
    log("✘ FAIL  CSP violations:", cspProblems);
  } else log("✔ no CSP violations in the desktop app or the web client");
  // B leaves the server session alone (cached account); sign B out of this browser session.
  if (tokenB) await env.request(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${tokenB}` } }).catch(() => undefined);
  await app.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  notifyService?.stop();
  if (!KEEP) for (const d of [appHome, browserHome]) fs.rmSync(d, { recursive: true, force: true });
  log(`\n${passed} passed, ${failed} failed`);
  fs.writeFileSync(path.join(OUT, "e2e-report.txt"), lines.join("\n") + "\n");
  process.exit(failed ? 1 : 0);
}
