#!/usr/bin/env node
/**
 * Smoke test of the PACKAGED app in release/ (CI: after `npm run dist:<os>`; no server needed).
 *
 *  1. Fuses read back from the packaged executable (RunAsNode off, NODE_OPTIONS off,
 *     --inspect off, asar integrity on, only-load-from-asar on, cookie encryption on, …).
 *  2. Bundle contents: the web client, the crypto WASM, main, preloads, desktop pages,
 *     desktop-config.json; no source maps; only electron-updater's dependency tree in node_modules.
 *  3. The packaged binary refuses debugging switches (--remote-debugging-port, --inspect).
 *  4. `--self-check`: the packaged binary itself opens its window, renders the server picker
 *     and checks CSP headers + enforcement, sandbox/context isolation/no Node in the renderer,
 *     the permission handler and the navigation lock, and writes a JSON report.
 *
 * Linux as root (containers): Chromium can't run as root without --no-sandbox, which a
 * released build refuses; then step 3 checks that refusal and step 4 runs the same app.asar on
 * the matching stock Electron (unfused, development mode) — reported as such.
 * Linux CI (non-root): the unpacked app's chrome-sandbox must be setuid root (Ubuntu 24.04
 * restricts unprivileged user namespaces); with CI=true this script does that with `sudo -n`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const release = path.join(root, "release");
const productName = process.env.LUMEN_PRODUCT_NAME || "Lumen Secure";
let failures = 0;
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const info = (msg) => console.log(`info ${msg}`);

function findApp() {
  if (process.platform === "linux") {
    const exe = path.join(release, "linux-unpacked", "lumen-secure");
    return { exe, resources: path.join(release, "linux-unpacked", "resources") };
  }
  if (process.platform === "win32") {
    const dir = path.join(release, "win-unpacked");
    return { exe: path.join(dir, `${productName}.exe`), resources: path.join(dir, "resources") };
  }
  const want = process.arch === "arm64" ? ["mac-arm64", "mac-universal", "mac"] : ["mac", "mac-universal", "mac-arm64"];
  for (const d of want) {
    const appDir = path.join(release, d, `${productName}.app`);
    if (fs.existsSync(appDir)) return { exe: path.join(appDir, "Contents", "MacOS", productName), resources: path.join(appDir, "Contents", "Resources"), appDir };
  }
  throw new Error(`no ${productName}.app under ${release}`);
}

function run(cmd, args, { timeout = 60_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, out });
    });
  });
}

const isRootLinux = process.platform === "linux" && process.getuid?.() === 0;
const app = findApp();
info(`packaged app: ${app.exe}`);
ok("packaged executable exists", fs.existsSync(app.exe));

// ---- 1. fuses ----
const wire = await getCurrentFuseWire(app.appDir ?? app.exe);
const fuse = (o) => (wire[o] === 49 ? "on" : wire[o] === 48 ? "off" : `unknown(${wire[o]})`);
const expected = {
  RunAsNode: "off",
  EnableCookieEncryption: "on",
  EnableNodeOptionsEnvironmentVariable: "off",
  EnableNodeCliInspectArguments: "off",
  EnableEmbeddedAsarIntegrityValidation: "on",
  OnlyLoadAppFromAsar: "on",
  GrantFileProtocolExtraPrivileges: "off",
};
for (const [k, v] of Object.entries(expected)) ok(`fuse ${k} = ${v}`, fuse(FuseV1Options[k]) === v, fuse(FuseV1Options[k]));

// ---- 2. bundle contents ----
const asarFile = path.join(app.resources, "app.asar");
const files = asar.listPackage(asarFile, { isPack: false }).map((f) => f.replace(/\\/g, "/"));
for (const f of ["/package.json", "/dist/main/index.cjs", "/dist/preload/app.cjs", "/dist/preload/lock.cjs", "/dist/pages/setup.html", "/dist/web/index.html", "/dist/web/theme-init.js", "/dist/desktop-config.json", "/dist/web/brand/logo.svg"]) {
  ok(`bundle contains ${f}`, files.includes(f));
}
ok("bundle contains the crypto WASM", files.some((f) => /^\/dist\/web\/assets\/matrix_sdk_crypto_wasm_bg-.*\.wasm$/.test(f)));
ok("no source maps in the bundle", !files.some((f) => f.endsWith(".map")));
const topModules = [...new Set(files.filter((f) => /^\/node_modules\/[^/]+$/.test(f)).map((f) => f.split("/")[2]))];
ok("node_modules limited to electron-updater's tree", topModules.includes("electron-updater") && !topModules.some((m) => ["electron", "sharp", "playwright", "esbuild", "typescript", "electron-builder"].includes(m)), topModules.join(", "));
const cfg = JSON.parse(asar.extractFile(asarFile, "dist/desktop-config.json").toString("utf8"));
info(`build-time default server: ${cfg.default_server || "(none: asks on first run)"}`);

// Linux CI: make chrome-sandbox setuid root (Ubuntu 24.04 restricts unprivileged user namespaces).
if (process.platform === "linux" && !isRootLinux) {
  const sandbox = path.join(path.dirname(app.exe), "chrome-sandbox");
  const st = fs.statSync(sandbox);
  if (!(st.uid === 0 && st.mode & 0o4000)) {
    if (process.env.CI === "true") {
      execFileSync("sudo", ["-n", "chown", "root:root", sandbox]);
      execFileSync("sudo", ["-n", "chmod", "4755", sandbox]);
      info("set chrome-sandbox setuid root (CI)");
    } else {
      info(`chrome-sandbox is not setuid root; if the launch fails run: sudo chown root:root '${sandbox}' && sudo chmod 4755 '${sandbox}'`);
    }
  }
}

// ---- 3. debugging switches are refused by the packaged binary ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-smoke-"));
const extra = isRootLinux ? ["--no-sandbox"] : [];
for (const sw of ["--remote-debugging-port=0", "--inspect=0"]) {
  const r = await run(app.exe, [...extra, sw], { timeout: 30_000 });
  const refused = r.code === 1 && (process.platform === "win32" || /refusing to start/.test(r.out));
  ok(`packaged app refuses ${sw}${extra.length ? " (and --no-sandbox)" : ""}`, refused, `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`);
}

// ---- 4. self-check ----
const report = path.join(tmp, "self-check.json");
let r;
if (isRootLinux) {
  const stock = path.join(root, "node_modules/electron/dist/electron");
  info("running as root: self-check of the packaged app.asar on the stock Electron binary (unfused, development mode)");
  r = await run(stock, ["--no-sandbox", asarFile, `--self-check=${report}`], { timeout: 120_000 });
} else {
  r = await run(app.exe, [`--self-check=${report}`], { timeout: 120_000 });
}
let rep = null;
try {
  rep = JSON.parse(fs.readFileSync(report, "utf8"));
} catch {
  /* no report */
}
if (!rep) {
  ok("self-check report written", false, r.out.slice(-1500));
} else {
  for (const c of rep.checks) {
    if (c.required) ok(`self-check: ${c.name}`, c.ok, c.detail ?? "");
    else info(`self-check: ${c.name}: ${c.detail ?? c.ok}`);
  }
  ok("self-check exit code 0", r.code === 0, `exit ${r.code}; packaged=${rep.packaged}, electron ${rep.electron}, chrome ${rep.chrome}, ${rep.platform}/${rep.arch}`);
}
fs.writeFileSync(path.join(release, `smoke-${process.platform}-${process.arch}.json`), JSON.stringify({ results, selfCheck: rep }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${results.filter((x) => x.pass).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
