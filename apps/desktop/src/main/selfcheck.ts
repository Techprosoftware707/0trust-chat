/**
 * `--self-check[=<report.json>]`: starts the app with a throw-away profile, opens the server
 * picker and checks, from inside the running app, that the hardening is in effect: window and
 * picker render, CSP headers are served and enforced, sandbox / context isolation / no Node in
 * the renderer, the permission handler denies, navigation is locked. Writes a JSON report,
 * exits 0 (all required checks passed) or 1.
 *
 * This lets CI check the packaged, fused, signed binary itself, which a debugger cannot be
 * attached to (fuses and the forbidden-switch check). It reads no user data and never loads
 * the web client with a session.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";
import { buildDesktopPageCsp } from "../core/csp.ts";
import { ctx, PAGE } from "./context.ts";
import { log } from "./log.ts";
import { storageProtection } from "./secrets.ts";
import { mainWindowPreferences } from "./windows.ts";

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitLoaded(win: BrowserWindow, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for the server picker")), ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    if (!win.webContents.isLoading() && win.webContents.getURL() === PAGE.setup) done();
    else win.webContents.once("did-finish-load", done);
  });
}

export function selfCheckArg(argv: readonly string[]): { enabled: boolean; report: string | null } {
  for (const a of argv) {
    if (a === "--self-check") return { enabled: true, report: null };
    if (a.startsWith("--self-check=")) return { enabled: true, report: a.slice("--self-check=".length) || null };
  }
  return { enabled: false, report: null };
}

export async function runSelfCheck(reportPath: string | null): Promise<void> {
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail?: string, required = true) => checks.push({ name, ok, required, ...(detail ? { detail } : {}) });
  const win = ctx.mainWindow;
  try {
    if (!win) throw new Error("no main window");
    await waitLoaded(win, 30_000);
    await sleep(500);
    const wc = win.webContents;
    const js = <T>(code: string) => wc.executeJavaScript(code, true) as Promise<T>;

    push("main window opened", !win.isDestroyed(), `visible=${win.isVisible()}`);
    push("server picker loaded from the app bundle", wc.getURL() === PAGE.setup, wc.getURL());
    const dom = await js<{ input: boolean; heading: string }>(
      `(() => ({ input: !!document.querySelector("#server-input"), heading: document.querySelector("h1")?.textContent ?? "" }))()`,
    );
    push("server picker rendered", dom.input && dom.heading.length > 0, dom.heading);

    const page = await session.defaultSession.fetch(PAGE.setup);
    const pageCsp = page.headers.get("content-security-policy");
    push("CSP header on desktop pages", pageCsp === buildDesktopPageCsp(), pageCsp ?? "missing");
    const web = await session.defaultSession.fetch("app://lumen/");
    const webCsp = web.headers.get("content-security-policy") ?? "";
    push("web client bundled (app://lumen/ index.html)", web.status === 200 && /<div id="root">/.test(await web.text()), `HTTP ${web.status}`);
    push(
      "CSP header on the web client",
      /script-src 'self' 'wasm-unsafe-eval';/.test(webCsp) && /connect-src 'self' blob:;/.test(webCsp) && !/unsafe-inline/.test(webCsp),
      webCsp || "missing",
    );
    const traversal = await session.defaultSession.fetch("app://lumen/%2e%2e/%2e%2e/package.json");
    push("app:// refuses path traversal", traversal.status === 404, `HTTP ${traversal.status}`);

    const inline = await js<{ ran: boolean; violated: string | null }>(`new Promise((resolve) => {
      let violated = null;
      document.addEventListener("securitypolicyviolation", (e) => { violated = e.violatedDirective; }, { once: true });
      const s = document.createElement("script");
      s.textContent = "window.__selfCheckInline = true";
      document.head.appendChild(s);
      setTimeout(() => resolve({ ran: window.__selfCheckInline === true, violated }), 300);
    })`);
    push("CSP enforced (inline script blocked)", !inline.ran && !!inline.violated?.startsWith("script-src"), JSON.stringify(inline));

    const prefs = mainWindowPreferences ?? {};
    push(
      "webPreferences (as created): sandbox, contextIsolation, no nodeIntegration, webSecurity",
      prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.webSecurity !== false,
      JSON.stringify({ sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity }),
    );
    const g = await js<Record<string, string>>(
      `({ require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, setup: typeof window.lumenSetup, desktop: typeof window.lumenDesktop, bridged: String(window.lumenSetup && window.lumenSetup.init) })`,
    );
    push("context isolation (preload API is a bridged proxy)", /\[native code\]/.test(g.bridged ?? ""), g.bridged);
    push("renderer main world has no Node.js", g.require === "undefined" && g.process === "undefined" && g.module === "undefined" && g.Buffer === "undefined", JSON.stringify(g));
    push("preload exposes only this page's API", g.setup === "object" && g.desktop === "undefined", JSON.stringify(g));

    const pid = wc.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (typeof metric?.sandboxed === "boolean") push("renderer process sandboxed by the OS", metric.sandboxed, `pid ${pid}`);
    else if (process.platform === "linux") {
      // Linux: Chromium's renderer sandbox installs a seccomp-bpf filter (Seccomp: 2) and sets no_new_privs.
      let status = "";
      try {
        status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      } catch {
        /* not readable */
      }
      const seccomp = /^Seccomp:\s*(\d)/m.exec(status)?.[1];
      const nnp = /^NoNewPrivs:\s*(\d)/m.exec(status)?.[1];
      push("renderer process sandboxed by the OS (seccomp-bpf)", seccomp === "2", `pid ${pid}: Seccomp=${seccomp ?? "?"} NoNewPrivs=${nnp ?? "?"}`, app.isPackaged);
    } else push("renderer process sandboxed by the OS", true, "not reported by Electron on this platform", false);

    const perm = await js<string[]>(`Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => e.name),
      Notification.requestPermission(),
      navigator.permissions.query({ name: "geolocation" }).then((p) => p.state, (e) => "error:" + e.name),
      navigator.permissions.query({ name: "microphone" }).then((p) => p.state, (e) => "error:" + e.name),
      navigator.permissions.query({ name: "camera" }).then((p) => p.state, (e) => "error:" + e.name),
    ])`);
    // (getUserMedia fails with NotFoundError instead of NotAllowedError on a machine without devices.)
    push("permission handler: getUserMedia not granted to non-app pages", perm[0] !== "granted", perm[0]);
    push("permission check: microphone and camera denied to non-app pages", perm[3] === "denied" && perm[4] === "denied", `${perm[3]}, ${perm[4]}`);
    push("permission handler: notifications denied to non-app pages", perm[1] === "denied", perm[1]);
    push("permission handler: geolocation denied", perm[2] === "denied", perm[2]);

    const opened = await js<boolean>(`window.open("file:///etc/hosts") !== null`);
    push("window.open denied", !opened);
    await js(`(location.href = "file:///etc/hosts", 1)`).catch(() => undefined);
    await sleep(1000);
    push("navigation away from the app blocked", wc.getURL() === PAGE.setup, wc.getURL());

    push("packaged build", app.isPackaged, app.isPackaged ? "forbidden debug/insecure switches are refused" : "development run", false);
    if (process.platform !== "darwin") {
      // (macOS: not touched here; Keychain access from a CI runner can block on a prompt.)
      const sp = storageProtection();
      push("OS-protected storage (safeStorage)", sp.level === "os", `${sp.level} (${sp.backend})`, process.platform === "win32");
    }
  } catch (e) {
    push("self-check ran to completion", false, (e as Error).message);
  }
  const ok = checks.every((c) => c.ok || !c.required);
  const report = {
    ok,
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    checks,
  };
  const text = JSON.stringify(report, null, 2);
  if (reportPath) {
    try {
      fs.writeFileSync(reportPath, text);
    } catch (e) {
      log.error("couldn't write the self-check report", e);
    }
  }
  for (const c of checks) console.log(`[self-check] ${c.ok ? "PASS" : c.required ? "FAIL" : "info"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(`[self-check] ${ok ? "OK" : "FAILED"}`);
  // Remove the throw-away profile (best effort: Chromium may still hold a file open on Windows).
  const profile = app.getPath("userData");
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  await session.defaultSession.flushStorageData();
  await sleep(300);
  try {
    if (path.basename(profile).startsWith("lumen-self-check-")) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the OS temp cleaner */
  }
  app.exit(ok ? 0 : 1);
}
