/**
 * Runs tests/apps/widget-harness (the Rust SDK widget driver the mobile apps use) as a
 * child process and speaks its stdio protocol: driver → widget messages arrive on stdout,
 * one JSON message per line; widget → driver messages are written to stdin, one per line.
 * The harness logs to stderr (no tokens, keys or message contents).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = path.resolve(HERE, "../widget-harness");

/** The release binary: $LUMEN_WIDGET_HARNESS, else $CARGO_TARGET_DIR or the crate's target/. */
export function harnessBinary() {
  const candidates = [
    process.env.LUMEN_WIDGET_HARNESS,
    process.env.CARGO_TARGET_DIR && path.join(process.env.CARGO_TARGET_DIR, "release/lumen-widget-harness"),
    path.join(HARNESS_DIR, "target/release/lumen-widget-harness"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`widget harness not built (looked at ${candidates.join(", ")}); build it with: cd tests/apps/widget-harness && cargo build --release`);
}

/**
 * Starts the harness. Resolves once it is ready (signed in, joined, widget driver running)
 * with an object to talk to it.
 */
export async function startHarness({ homeserver, loginToken, roomId, widgetUrl, widgetId = "lumen-call", intent = "join_existing", video = true, notify = "none", theme = "dark", lang = "en-US", ca, label = "harness", log = () => undefined, readyTimeout = 120_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-harness-"));
  const infoFile = path.join(dir, "info.json");
  const args = ["--homeserver", homeserver, "--room", roomId, "--widget-url", widgetUrl, "--widget-id", widgetId, "--intent", intent, "--video", String(video), "--notify", notify, "--theme", theme, "--lang", lang, "--info-file", infoFile, "--device-name", `Lumen harness (${label})`];
  if (ca) args.push("--ca-file", ca);
  // The deployment under test is reached directly (as the browsers do with --no-proxy-server),
  // never through an HTTP(S) proxy configured for this host's outbound traffic.
  const hsHost = new URL(homeserver).hostname;
  const domain = hsHost.split(".").slice(1).join(".");
  const noProxy = [process.env.NO_PROXY || process.env.no_proxy, hsHost, domain && `.${domain}`, domain, "localhost", "127.0.0.1"].filter(Boolean).join(",");
  // the login token goes through the environment, not the command line (visible in ps)
  const child = spawn(harnessBinary(), args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy, LUMEN_LOGIN_TOKEN: loginToken } });
  const stderr = [];
  const toWidget = []; // every driver → widget message (parsed), in order
  const listeners = new Set();
  let exited = null;
  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve((exited = { code, signal }))));

  readline.createInterface({ input: child.stderr }).on("line", (l) => {
    stderr.push(l);
    log(`     [${label}] ${l.replace(/^\S+\s+/, "")}`);
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stderr.push(`(unparseable stdout line: ${line.slice(0, 80)})`);
      return;
    }
    toWidget.push(msg);
    for (const l of listeners) l(msg, line);
  });

  const t0 = Date.now();
  while (!fs.existsSync(infoFile)) {
    if (exited) throw new Error(`harness exited before it was ready (${JSON.stringify(exited)}):\n${stderr.slice(-15).join("\n")}`);
    if (Date.now() - t0 > readyTimeout) {
      child.kill("SIGTERM");
      throw new Error(`harness not ready after ${readyTimeout / 1000} s:\n${stderr.slice(-15).join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));

  const h = {
    info,
    child,
    stderr,
    toWidget,
    get exited() {
      return exited;
    },
    /** widget → driver */
    send(msgOrLine) {
      const line = typeof msgOrLine === "string" ? msgOrLine : JSON.stringify(msgOrLine);
      if (line.includes("\n")) throw new Error("widget messages must be single-line JSON");
      child.stdin.write(line + "\n");
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Resolves with the first driver → widget message (already received or future) matching `pred`. */
    waitFor(pred, timeout = 30_000, what = "driver message") {
      const found = toWidget.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          off();
          reject(new Error(`timed out after ${timeout / 1000} s waiting for ${what}`));
        }, timeout);
        const off = h.onMessage((m) => {
          if (!pred(m)) return;
          clearTimeout(t);
          off();
          resolve(m);
        });
      });
    },
    /** Sends a fromWidget request and resolves with the driver's response to it. */
    async request(action, data = {}, timeout = 30_000) {
      const requestId = `test-${action}-${Math.random().toString(36).slice(2, 10)}`;
      h.send({ api: "fromWidget", widgetId: info.widget_id, requestId, action, data });
      return h.waitFor((m) => m.api === "fromWidget" && m.requestId === requestId && m.response !== undefined, timeout, `response to ${action}`);
    },
    /** Stops the harness (SIGTERM → it logs out, deleting its device) and waits for it. */
    async stop() {
      if (!exited) {
        child.stdin.end();
        child.kill("SIGTERM");
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 15_000))]);
        if (!exited) child.kill("SIGKILL");
      }
      fs.rmSync(dir, { recursive: true, force: true });
      return exited;
    },
  };
  return h;
}
