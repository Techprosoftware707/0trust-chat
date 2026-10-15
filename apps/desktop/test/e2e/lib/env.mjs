/**
 * Test environment for the desktop e2e suite (Linux, against the dev Lumen stack).
 *
 * - Certificates: the stack uses Caddy's internal CA. Electron and Chromium on Linux trust
 *   the NSS database in $HOME/.pki/nssdb, so each process gets a temporary HOME whose NSS DB
 *   has that CA added (certutil). Certificate verification stays fully on; no
 *   --ignore-certificate-errors, no ignoreHTTPSErrors.
 * - "The OS": Electron's shell.openExternal runs xdg-open on Linux. A tiny xdg-open on PATH
 *   records the URL instead of starting a desktop browser; the test then plays the system
 *   browser (Playwright Chromium) and hands the callback back to the app the way the OS does on
 *   Windows/Linux: by launching the app's executable with the URL as an argument
 *   (single-instance lock → `second-instance` in the running app).
 * - Proxy: *.lumen.test resolve to this host; they are added to no_proxy.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, "../../..");
export const REPO = path.resolve(APP_DIR, "../..");
export const OUT = path.join(APP_DIR, "test-output");
export const BASE = process.env.LUMEN_BASE || "lumen.test";
export const WEB = `https://app.${BASE}`;
export const HS = `https://matrix.${BASE}`;
export const PORTAL = `https://${BASE}`;
export const STACK_CA = process.env.LUMEN_CA || "/etc/lumen/ca/caddy-local-root.crt";
export const ELECTRON = path.join(APP_DIR, "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
export const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
fs.mkdirSync(OUT, { recursive: true });

const CA_LIST = [...tls.rootCertificates, ...(fs.existsSync(STACK_CA) ? [fs.readFileSync(STACK_CA, "utf8")] : [])];

/** HTTPS request from the test process (trusting the stack CA explicitly): { status, text, json }. */
export function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca: CA_LIST, agent: false }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, text: data, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** A temporary HOME whose NSS database trusts the stack CA (test environment only). */
export function makeHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lumen-e2e-${name}-`));
  const db = path.join(home, ".pki", "nssdb");
  fs.mkdirSync(db, { recursive: true });
  execFileSync("certutil", ["-N", "-d", `sql:${db}`, "--empty-password"], { stdio: "ignore" });
  execFileSync("certutil", ["-A", "-d", `sql:${db}`, "-t", "C,,", "-n", "lumen-dev-stack-ca", "-i", STACK_CA], { stdio: "ignore" });
  return home;
}

/** A directory with an `xdg-open` that records the URL it is asked to open. */
export function fakeOpener(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "opened-urls.txt");
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`, { mode: 0o755 });
  return { bin, log, urls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

export function noProxy() {
  return [process.env.no_proxy || process.env.NO_PROXY, BASE, `.${BASE}`, "localhost", "127.0.0.1"].filter(Boolean).join(",");
}

/** Environment of the Electron app under test. */
export function appEnv(home, openerBin) {
  const np = noProxy();
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${openerBin}:${process.env.PATH}`, no_proxy: np, NO_PROXY: np };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

export function userDataDir(home) {
  return path.join(home, ".config", "Lumen Secure");
}

/** Chromium switches for the app in this harness only (never in the app's code). */
export function appArgs(toneFile) {
  return [
    APP_DIR,
    ...(IS_ROOT ? ["--no-sandbox"] : []),
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${toneFile}`,
  ];
}

/** Delivers a URL to the running app the way Windows/Linux do: a second launch with the URL as argument. */
export function deliverAsOs(env, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [APP_DIR, ...(IS_ROOT ? ["--no-sandbox"] : []), url], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`second instance did not exit: ${out.slice(-500)}`));
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

/** 48 kHz mono PCM WAV test tone for the fake microphone. */
export function toneFile(freq) {
  const file = path.join(OUT, `tone-${freq}hz.wav`);
  if (fs.existsSync(file)) return file;
  const rate = 48_000;
  const n = rate * 10;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.3 * Math.sin((2 * Math.PI * freq * i) / rate) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/** The newest full Chromium build Playwright installed (fake media devices need the full browser). */
export function chromeBinary() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dirs = fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const p = path.join(root, d, "chrome-linux", "chrome");
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no Chromium under ${root}`);
}

// ---- portal accounts (cached across runs: the portal rate-limits sign-ups per IP) ----
const ACCOUNTS = path.join(OUT, "accounts.json");

export function account(key, displayName) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"));
  } catch {
    /* first run */
  }
  if (all[key]) return { ...all[key], isNew: false };
  const username = `desk${key}${randomBytes(3).toString("hex")}`;
  const acct = { username, displayName, password: `Desk-Test-${randomBytes(9).toString("hex")}`, userId: `@${username}:${BASE}` };
  return { ...acct, isNew: true, save: () => fs.writeFileSync(ACCOUNTS, JSON.stringify({ ...all, [key]: acct }, null, 2), { mode: 0o600 }) };
}

export async function portalSignUp(page, acct) {
  await page.goto(`${PORTAL}/accounts/signup/`);
  await page.fill("input[name=username]", acct.username);
  await page.fill("input[name=display_name]", acct.displayName);
  await page.fill("input[name=email]", `${acct.username}@example.org`);
  await page.fill("input[name=password1]", acct.password);
  await page.fill("input[name=password2]", acct.password);
  await page.check("input[name=accept_terms]");
  await Promise.all([page.waitForNavigation(), page.locator("main form button[type=submit]").click()]);
  if (!/\/portal\/dashboard\/$/.test(page.url())) {
    const text = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`portal sign-up failed for ${acct.username} at ${page.url()}: ${text}`);
  }
  acct.save?.();
}

/**
 * Plays the user in the system browser: opens `url` (the homeserver's SSO redirect), signs in
 * at the portal when asked, and returns the first redirect to `scheme:` it sees (the browser
 * would hand that to the OS).
 */
export async function browserSso(page, url, acct, scheme = "io.lumen.secure:") {
  let callback = null;
  const onResponse = (r) => {
    const loc = r.headers()["location"];
    if (loc && loc.startsWith(scheme) && !callback) callback = loc;
  };
  page.on("response", onResponse);
  try {
    await page.goto(url).catch(() => undefined);
    for (let i = 0; i < 15 && !callback; i++) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      if (callback) break;
      if (await page.locator("input[name=login]").count()) {
        await page.fill("input[name=login]", acct.username);
        await page.fill("input[name=password]", acct.password);
        await Promise.all([page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), page.locator("form button[type=submit]").last().click()]);
        continue;
      }
      const link = page.locator(`a[href^="${scheme}"]`);
      if (await link.count()) {
        callback = await link.first().getAttribute("href");
        break;
      }
      const next = page.locator("a:has-text('Continue'), button:has-text('Continue'), button:has-text('Allow'), button:has-text('Authorize')");
      if (await next.count()) await Promise.all([page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), next.first().click()]);
      else await page.waitForTimeout(1000);
    }
  } finally {
    page.off("response", onResponse);
  }
  if (!callback) throw new Error(`no ${scheme} redirect; browser ended at ${page.url()}`);
  return callback;
}
