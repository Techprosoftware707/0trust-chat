#!/usr/bin/env node
/**
 * Screenshot gallery of the desktop app's own pages (server picker, lock screen, desktop
 * settings, screen-share picker), for design review.
 *
 * The built pages (dist/pages, from `npm run build` or `node scripts/build-app.mjs`) are opened
 * in Chromium from disk with stand-ins for their preload APIs (window.lumenSetup, lumenLock,
 * lumenSettings, lumenPicker): the same HTML, CSS and scripts the app serves from
 * app://desktop/, with canned answers instead of the main process. The full app (sign-in,
 * notifications, calls, lock, sign-out) is exercised by test/e2e/run.mjs.
 *
 *   node test/gallery/pages.mjs [--pages DIR] [--out DIR]
 *
 * Output: desktop-<page>-<state>-<theme>.png (default docs/test-results/ui-polish/web/after).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const REPO = path.resolve(APP, "../..");
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PAGES = path.resolve(opt("--pages", path.join(APP, "dist/pages")));
const OUT = path.resolve(opt("--out", path.join(REPO, "docs/test-results/ui-polish/web/after")));
mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright");
const browser = await chromium.launch();

/** Stand-ins for the preload bridges (run in the page before its script). */
function stubs(state) {
  const thumb = (hue) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 200;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 320, 200);
    grad.addColorStop(0, `hsl(${hue} 60% 55%)`);
    grad.addColorStop(1, `hsl(${hue + 40} 60% 35%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = "rgba(255,255,255,.85)";
    g.fillRect(20, 20, 180, 14);
    g.fillRect(20, 44, 120, 10);
    return c.toDataURL("image/png");
  };
  const summary = { serverName: "lumen.example", homeserverUrl: "https://matrix.lumen.example", brandName: "Lumen Secure", isLumen: true, sso: true, passwordLogin: false, signupUrl: "https://lumen.example/accounts/signup/", calls: "advertised" };
  window.lumenSetup = {
    init: async () => ({ defaultServer: state.defaultServer ?? null, storage: { level: state.storage ?? "os", backend: "keychain" } }),
    discover: async (v) => (state.discoverError ? { ok: false, error: state.discoverError } : { ok: true, summary: { ...summary, serverName: v || summary.serverName } }),
    connect: async () => false,
    openSignup: () => undefined,
  };
  window.lumenLock = {
    state: async () => ({ brand: "Lumen Secure", touchId: !!state.touchId, retryAfterMs: state.retryAfterMs ?? 0 }),
    unlock: async () => ({ ok: false, retryAfterMs: 0, error: "That PIN isn't right. Try again." }),
    touchId: async () => ({ ok: false, error: "Touch ID was cancelled." }),
  };
  const view = {
    platform: "darwin",
    appVersion: "1.0.0",
    electronVersion: "44.7.2",
    packaged: true,
    brand: { name: "Lumen Secure", shortName: "Lumen" },
    server: { serverName: "lumen.example", homeserverUrl: "https://matrix.lumen.example", accountUrl: "https://lumen.example/portal/", accountDeleteUrl: "https://lumen.example/portal/account/delete/" },
    settings: { closeToTray: true, openAtLogin: false, doNotDisturb: false, autoLockMinutes: 5, lockOnSuspend: true, touchId: true },
    autoLockChoices: [0, 1, 5, 15, 30, 60],
    lockEnabled: !!state.lockEnabled,
    touchIdAvailable: true,
    openAtLoginSupported: true,
    storage: { level: state.storage ?? "os", backend: "keychain" },
    update: { status: "idle", message: "Lumen Secure is up to date." },
  };
  window.lumenSettings = {
    get: async () => view,
    set: async () => view,
    setPin: async () => ({ ok: true }),
    removePin: async () => ({ ok: true }),
    lockNow: async () => true,
    changeServer: async () => undefined,
    checkForUpdates: async () => undefined,
    installUpdate: async () => undefined,
    openAccount: () => undefined,
    openAccountDelete: () => undefined,
    onChanged: () => () => undefined,
  };
  window.lumenPicker = {
    sources: async () => ({
      sources: [
        { id: "screen:1", name: "Entire screen", kind: "screen", thumbnail: thumb(200) },
        { id: "screen:2", name: "Display 2 (external)", kind: "screen", thumbnail: thumb(260) },
        { id: "window:1", name: "Quarterly planning — Slides", kind: "window", thumbnail: thumb(20) },
        { id: "window:2", name: "Terminal — ssh ops@lumen.example", kind: "window", thumbnail: thumb(140) },
        { id: "window:3", name: "Notes", kind: "window", thumbnail: "" },
      ],
      audioSupported: true,
      screenPermission: state.screenPermission ?? "granted",
    }),
    choose: () => undefined,
    openPrivacySettings: () => undefined,
  };
}

const shots = [];
async function page(name, file, { state = {}, size = { width: 1000, height: 720 }, themes = ["light", "dark"], act } = {}) {
  for (const theme of themes) {
    const ctx = await browser.newContext({ viewport: size, colorScheme: theme, reducedMotion: "reduce" });
    await ctx.addInitScript(stubs, state);
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(path.join(PAGES, file)).href);
    await p.waitForLoadState("networkidle");
    if (act) await act(p);
    await p.waitForTimeout(300);
    const out = path.join(OUT, `desktop-${name}-${theme}.png`);
    await p.screenshot({ path: out });
    shots.push(path.basename(out));
    await ctx.close();
  }
}

await page("server-picker", "setup.html", { themes: ["light", "dark"] });
await page("server-confirm", "setup.html", {
  themes: ["light"],
  act: async (p) => {
    await p.fill("#server-input", "lumen.example");
    await p.click("#continue");
    await p.locator("#step-confirm").waitFor({ state: "visible" });
  },
});
await page("server-error", "setup.html", {
  state: { discoverError: "We couldn't find a Matrix server at lumen.exmple. Check the spelling, or ask your administrator for the server name.", storage: "basic" },
  themes: ["dark"],
  act: async (p) => {
    await p.fill("#server-input", "lumen.exmple");
    await p.click("#continue");
    await p.locator("#error").waitFor({ state: "visible" });
  },
});
await page("lock", "lock.html", { themes: ["dark"] });
await page("lock-error", "lock.html", {
  state: { touchId: true },
  themes: ["dark"],
  act: async (p) => {
    await p.fill("#pin", "123456");
    await p.click("#unlock");
    await p.locator("#error").waitFor({ state: "visible" });
  },
});
await page("settings", "settings.html", { state: { lockEnabled: true }, size: { width: 760, height: 900 }, themes: ["light", "dark"] });
await page("picker", "picker.html", { size: { width: 900, height: 640 }, themes: ["dark"] });
await browser.close();
console.log(`${shots.length} desktop page screenshots → ${path.relative(REPO, OUT)}\n  ${shots.join("\n  ")}`);
