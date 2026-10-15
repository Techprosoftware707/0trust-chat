/**
 * The mobile apps' call path, end to end, on this Linux host.
 *
 * The Android/iOS apps run the Lumen call widget (services/chat, `npm run build:widget`) in a
 * system WebView and connect it to the user's session through the Matrix Rust SDK's widget
 * driver (matrix-sdk-ffi). This test runs the same SDK code — tests/apps/widget-harness, the
 * widget driver of matrix-rust-sdk 2a3db80e (= sdk-android 26.09.28) with the apps' capability
 * set — and puts a real Chromium page in the WebView's place, connected through the native
 * bridge of docs/apps/integration.md §6.2:
 *
 *   widget page ──window.lumenNative.postMessage(json)──▶ test (= native) ──stdin──▶ harness
 *   widget page ◀──window.postMessage(json, origin)────── test (= native) ◀─stdout── harness
 *
 * `window.lumenNative` is injected like Android's WebViewCompat.addWebMessageListener: an
 * object with postMessage(string), only for the widget's origin, top frame only. The widget is
 * served from http://localhost:<port> (a secure context, like WebViewAssetLoader's https
 * origin) by a plain static server inside the "phone"'s network namespace.
 *
 * A second user in the normal web client (https://app.lumen.test, another browser in another
 * network namespace) takes part in the same call. Everything asserted is real protocol state
 * or RTCPeerConnection.getStats() numbers; nothing is simulated.
 *
 *   sudo bash tests/calls/lab.sh up
 *   (cd services/chat && npm run build:widget)
 *   (cd tests/apps/widget-harness && cargo build --release)
 *   sudo node tests/apps/widget-call.test.mjs [--base lumen.test] [--server-ip 10.200.0.1] [--no-netns]
 *
 * Raw output: docs/test-results/apps-widget-call.txt
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acceptIncoming, hangUpAll, remoteTiles, waitE2EE, waitPhase } from "../calls/lib/callui.mjs";
import { BASE, hearRemoteTones, HS, lab, launchClient, mx, NO_NETNS, openRoom, REPO, RESULTS, sampleRates, signIn, signOutServer, T } from "../calls/lib/lab.mjs";
import { startHarness } from "./lib/harness.mjs";

const CA = process.env.LUMEN_CA_BUNDLE || "/etc/lumen/ca/bundle.crt";
const WIDGET_DIR = path.join(REPO, "services/chat/dist-widget");
const WIDGET_PORT = Number(process.env.LUMEN_WIDGET_PORT || 18765);
const WIDGET_ORIGIN = `http://localhost:${WIDGET_PORT}`;
const WIDGET_URL = `${WIDGET_ORIGIN}/index.html`;
const OUT = path.join(REPO, "tests/apps/output");
fs.mkdirSync(OUT, { recursive: true });

// ---- reporting (same format as the call suites; result file docs/test-results/apps-widget-call.txt)
const lines = [];
const started = new Date();
let passed = 0;
let failed = 0;
const log = (...parts) => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  lines.push(line);
  console.log(line);
};
const cleanups = [];
let shotTargets = [];
async function step(title, fn) {
  log(`\n--- ${title}`);
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    log(`PASS ${title} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return true;
  } catch (e) {
    failed++;
    log(`FAIL ${title} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n     ${String(e?.stack || e).split("\n").slice(0, 12).join("\n     ")}`);
    const slug = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase();
    for (const c of shotTargets) if (c?.page && !c.page.isClosed()) await c.page.screenshot({ path: path.join(OUT, `fail-${slug}-${c.label}.png`) }).catch(() => undefined);
    return false;
  }
}

// ---- the capability set the apps grant (getElementCallRequiredPermissions, matrix-sdk-ffi
// widget.rs at 2a3db80e) — restated here as the specification the harness is checked against.
function requiredCapabilities(u, d) {
  const SS = "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#";
  const readSend = ["org.matrix.rageshake_request", "io.element.call.encryption_keys", "io.element.call.reaction", "m.reaction", "m.room.redaction", "org.matrix.msc4310.rtc.decline"];
  return [
    "io.element.requires_client",
    "org.matrix.msc4157.update_delayed_event",
    "org.matrix.msc4157.send.delayed_event",
    "org.matrix.msc4039.download_file",
    "org.matrix.msc4515.rtc_transports",
    ...["org.matrix.msc3401.call.member", "m.room.name", "m.room.member", "m.room.encryption", "m.room.create"].map((t) => `org.matrix.msc2762.receive.state_event:${t}`),
    ...readSend.map((t) => `org.matrix.msc2762.receive.event:${t}`),
    "org.matrix.msc3819.receive.to_device:io.element.call.encryption_keys",
    "org.matrix.msc2762.send.event:org.matrix.msc4075.rtc.notification",
    "org.matrix.msc2762.send.event:org.matrix.msc4075.call.notify",
    `${SS}${u}`,
    `${SS}${u}_${d}`,
    `${SS}${u}_${d}_m.call`,
    `${SS}_${u}_${d}`,
    `${SS}_${u}_${d}_m.call`,
    ...readSend.map((t) => `org.matrix.msc2762.send.event:${t}`),
    "org.matrix.msc3819.send.to_device:io.element.call.encryption_keys",
  ];
}
const MSC4533_GET_TOKEN = "org.matrix.msc4533.rtc_livekit_get_token";
const livekitIdentity = (userId, memberId) => createHash("sha256").update(JSON.stringify([userId, memberId])).digest("base64").replace(/=+$/, "");
const jwtClaims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

/**
 * The native user's portal account. Sign-ups are rate-limited per IP (10/h), so, like the call
 * suites, the account is created once from a lab namespace with the shared signIn() helper
 * and cached (tests/calls/output/accounts.json, key "appwidgetnative"); the web session that
 * creates it is signed out again.
 */
const CALL_ACCOUNTS = path.join(REPO, "tests/calls/output/accounts.json");
async function nativeAccount() {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(CALL_ACCOUNTS, "utf8")).appwidgetnative ?? null;
    } catch {
      return null;
    }
  };
  if (!read()) {
    const c = await launchClient({ ns: "lab-c", label: "signup" });
    try {
      await signIn(c, "appwidgetnative", "Phone Lumen");
      await signOutServer(c);
    } finally {
      await c.browser.close();
    }
  }
  const acct = read();
  assert.ok(acct, "native account created");
  return acct;
}

/** Login tokens from SSO with the apps' redirect URI (tests/apps/lib/app_login_token.py). */
function appLoginTokens(acct, count) {
  const args = [path.join(REPO, "tests/apps/lib/app_login_token.py"), "--base", BASE, "--ca", CA, "--count", String(count), "--username", acct.username, "--password", acct.password];
  return JSON.parse(execFileSync("python3", args, { encoding: "utf8", timeout: 120_000 }));
}

// ---- the native bridge (integration.md §6.2), as Android implements it --------------------

/**
 * Injected before any page script, like WebViewCompat.addWebMessageListener(webView,
 * "lumenNative", setOf(widgetOrigin), listener): a `lumenNative` object with
 * postMessage(String), present only in the top frame of the allowed origin.
 */
function nativeBridgeInit({ origin }) {
  const post = window.__lumenNativeBridge;
  try {
    delete window.__lumenNativeBridge;
  } catch {
    /* not configurable: harmless, it is origin-checked on the native side too */
  }
  if (location.origin !== origin || window.top !== window || typeof post !== "function") return;
  const lumenNative = Object.freeze({
    postMessage(message) {
      if (typeof message !== "string") throw new TypeError("lumenNative.postMessage takes a string");
      post(message);
    },
  });
  Object.defineProperty(window, "lumenNative", { value: lumenNative, writable: false, configurable: false });
}

/** Connects a page to a harness: returns the native-side state of the bridge. */
async function connectBridge(client, harness, origin) {
  const bridge = { fromWidget: [], callStates: [], other: [], delivered: 0, deliveryErrors: [] };
  // widget → native
  await client.context.exposeBinding("__lumenNativeBridge", (source, json) => {
    // allowedOriginRules + main frame only (what addWebMessageListener enforces)
    let o = null;
    try {
      o = new URL(source.frame.url()).origin;
    } catch {
      /* about:blank etc. */
    }
    if (o !== origin || source.frame !== source.page.mainFrame()) return;
    // WidgetBridge.classify (apps/android/core/.../calls/WidgetBridge.kt), same rules on iOS
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      msg = null;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      bridge.other.push({ invalid: String(json).slice(0, 80) });
      return;
    }
    if (msg.type === "io.lumen.call_state") {
      const body = msg.data && typeof msg.data === "object" ? msg.data : msg;
      if (["connecting", "connected", "reconnecting", "ended"].includes(body.state)) bridge.callStates.push({ at: Date.now(), ...body, type: undefined });
      else bridge.other.push({ invalidCallState: true });
      return;
    }
    const forDriver =
      typeof msg.api === "string" &&
      msg.widgetId === harness.info.widget_id &&
      typeof msg.requestId === "string" &&
      msg.requestId !== "" &&
      typeof msg.action === "string" &&
      msg.action !== "" &&
      ((msg.api === "fromWidget" && !("response" in msg)) || (msg.api === "toWidget" && msg.response && typeof msg.response === "object" && !Array.isArray(msg.response)));
    if (forDriver) {
      bridge.fromWidget.push(msg);
      harness.send(json); // WidgetDriverHandle.send(json), verbatim
    } else {
      bridge.other.push(msg);
    }
  });
  await client.context.addInitScript(nativeBridgeInit, { origin });
  // native → widget: every WidgetDriverHandle.recv() string, in order, via
  // evaluateJavascript("postMessage(<json>, '<origin>')")
  let chain = Promise.resolve();
  harness.onMessage((_msg, line) => {
    chain = chain.then(async () => {
      try {
        await client.page.evaluate(([m, o]) => window.postMessage(m, o), [JSON.parse(line), origin]);
        bridge.delivered++;
      } catch (e) {
        bridge.deliveryErrors.push(String(e).slice(0, 200));
      }
    });
  });
  // WidgetBridge.actionMessage: {"type":"io.lumen.call_action","action":…}, via postMessage
  bridge.action = (action) => client.page.evaluate(([m, o]) => window.postMessage(m, o), [{ type: "io.lumen.call_action", action }, origin]);
  bridge.lastState = () => bridge.callStates[bridge.callStates.length - 1] ?? null;
  bridge.waitState = async (pred, timeout = T, what = "call state") => {
    const t0 = Date.now();
    for (;;) {
      const s = bridge.callStates.find(pred);
      if (s) return s;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}; states: ${JSON.stringify(bridge.callStates.slice(-5))}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  return bridge;
}

/** Static server for dist-widget inside the phone's namespace (its localhost). */
function startWidgetServer(ns) {
  const script = path.join(REPO, "tests/apps/lib/widget-server.mjs");
  const cmd = NO_NETNS ? [process.execPath, script, WIDGET_DIR, String(WIDGET_PORT)] : ["ip", "netns", "exec", ns, process.execPath, script, WIDGET_DIR, String(WIDGET_PORT)];
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("widget server did not start")), 10_000);
    child.stdout.on("data", (d) => {
      if (/listening/.test(String(d))) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => log(`     [widget-server] ${String(d).trim()}`));
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`widget server exited (${code})`));
    });
  });
}

const summary = (rows, dir) =>
  rows
    .filter((r) => r.dir === dir && r.pcState === "connected")
    .map((r) => `${r.kind} ${r.mimeType ?? "?"} bytes=${r.bytes} packets=${r.packets} kbps=${r.kbps}${r.kind === "video" ? ` ${r.frameWidth ?? "?"}x${r.frameHeight ?? "?"} framesDecoded=${r.framesDecoded ?? "-"}` : ""}`)
    .join("; ");

function assertInbound(rows, label) {
  const inb = rows.filter((r) => r.dir === "in" && r.pcState === "connected");
  const audio = inb.filter((r) => r.kind === "audio" && (r.bytes ?? 0) > 0 && (r.dPackets ?? 0) > 0);
  const video = inb.filter((r) => r.kind === "video" && (r.bytes ?? 0) > 0 && (r.dFramesDecoded ?? 0) > 0);
  assert.ok(audio.length >= 1, `${label}: no inbound audio with bytes and new packets (${summary(rows, "in")})`);
  assert.ok(video.length >= 1, `${label}: no inbound video with bytes and newly decoded frames (${summary(rows, "in")})`);
  return { audio: audio[0], video: video[0] };
}

// ---------------------------------------------------------------------------------------------

/**
 * The lab namespaces (tests/calls/lab.sh), created if missing. Unlike the call suites'
 * ensureLab() this does not reset shaping or blocks in the namespaces, so it can't disturb a
 * call suite running at the same time; this test uses lab-a (phone), lab-b (web), lab-c.
 */
function checkLab() {
  if (NO_NETNS) return "no network namespaces (--no-netns): all clients share the host network";
  let status = lab("status");
  if (!/lab-a: 10\.200\.0\.11/.test(status) || !/lab-c: 10\.200\.0\.13/.test(status)) status = (lab("up"), lab("status"));
  return status;
}

log(`lab: ${checkLab().replace(/\n/g, " | ")}`);
log(`widget bundle: ${WIDGET_DIR} (${fs.existsSync(path.join(WIDGET_DIR, "index.html")) ? "present" : "MISSING — run npm run build:widget"})`);
let web = null;
let phone = null;
let server = null;
let harness = null;
let probe = null;
let nativeAcct = null;
let roomId = "";
let bridge = null;

try {
  await step("web user signs in to https://app.lumen.test (lab-b) through portal SSO", async () => {
    web = await launchClient({ ns: "lab-b", label: "web", tone: 660, colorScheme: "dark" });
    shotTargets.push(web);
    await signIn(web, "appwidgetweb", "Web Lumen");
    log(`web user ${web.userId}, device ${web.deviceId}`);
  });

  await step("native user: portal account, SSO with the apps' redirect URI (io.lumen.secure:/sso-callback) → login tokens", async () => {
    const acct = await nativeAccount();
    nativeAcct = appLoginTokens(acct, 2);
    assert.equal(nativeAcct.user_id, acct.userId);
    assert.equal(nativeAcct.login_tokens.length, 2);
    log(`native user ${nativeAcct.user_id}; got ${nativeAcct.login_tokens.length} single-use login tokens from the app-scheme callback`);
  });

  await step("web user opens an encrypted DM with the native user (normal web client UI)", async () => {
    const page = web.page;
    await page.getByRole("button", { name: "Start a conversation" }).click();
    await page.getByRole("menuitem", { name: "New direct message" }).click();
    await page.getByLabel("Find people").fill(nativeAcct.user_id);
    await page.locator(".user-result").first().click({ timeout: T });
    await page.getByRole("button", { name: "Start conversation" }).click();
    await page.waitForFunction(() => /#\/room\//.test(location.hash), null, { timeout: T });
    roomId = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/room\//, "").split("/")[0]));
    const enc = await mx(web, "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`);
    assert.equal(enc.status, 200, enc.text);
    assert.equal(enc.json.algorithm, "m.megolm.v1.aes-sha2");
    log(`DM ${roomId}, encryption ${enc.json.algorithm}`);
  });

  await step("negative: the harness grants exactly the apps' capability set and refuses everything beyond it", async () => {
    probe = await startHarness({ homeserver: HS, loginToken: nativeAcct.login_tokens[0], roomId, widgetUrl: WIDGET_URL, widgetId: "lumen-call-probe", ca: CA, label: "probe", log });
    const { user_id: u, device_id: d, widget_id: w } = probe.info;
    log(`probe harness: ${u} device ${d}, room encrypted=${probe.info.room_encrypted}, matrix-rust-sdk ${probe.info.matrix_rust_sdk_rev}`);
    const versions = await probe.request("supported_api_versions");
    log(`driver API versions: ${versions.response.supported_versions.join(", ")}`);
    assert.ok(versions.response.supported_versions.includes("org.matrix.msc4515"), "MSC4515 (RTC transports) advertised by the SDK driver");
    assert.ok(versions.response.supported_versions.includes("org.matrix.msc4533"), "MSC4533 advertised by the native layer");

    // content_loaded → the driver starts capability negotiation (init_after_content_load = true)
    const loaded = await probe.request("content_loaded");
    assert.deepEqual(loaded.response, {});
    const capReq = await probe.waitFor((m) => m.api === "toWidget" && m.action === "capabilities" && m.response === undefined, 15_000, "capabilities request");
    const required = requiredCapabilities(u, d);
    const extras = [
      "org.matrix.msc2762.send.event:m.room.message",
      "org.matrix.msc2762.receive.event:m.room.message",
      "org.matrix.msc2762.send.event:m.room.message#m.text",
      `org.matrix.msc2762.timeline:${roomId}`,
      "org.matrix.msc2762.timeline:*",
      "org.matrix.msc2762.send.state_event:m.room.name",
      "org.matrix.msc2762.send.state_event:m.room.power_levels",
      "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#_@someone:lumen.test_OTHER_m.call",
      "org.matrix.msc2762.receive.state_event:m.room.power_levels",
      "org.matrix.msc3819.send.to_device:m.room_key_request",
      "org.matrix.msc3819.receive.to_device:m.room_key",
      "org.matrix.msc4533.rtc_livekit_delegate_delayed_leave",
      "org.matrix.msc3846.turn_servers",
      "m.always_on_screen",
      "org.matrix.msc2931.navigate",
    ];
    probe.send({ ...capReq, response: { capabilities: [...required, MSC4533_GET_TOKEN, ...extras] } });
    const notify = await probe.waitFor((m) => m.api === "toWidget" && m.action === "notify_capabilities" && m.response === undefined, 15_000, "notify_capabilities");
    probe.send({ ...notify, response: {} });
    const approved = notify.data.approved;
    const missing = required.filter((c) => !approved.includes(c));
    const leaked = extras.filter((c) => approved.includes(c));
    const unexpected = approved.filter((c) => !required.includes(c) && c !== MSC4533_GET_TOKEN);
    log(`requested ${required.length + 1 + extras.length}, approved ${approved.length}; refused: ${extras.length} extras`);
    assert.deepEqual(missing, [], "every required capability approved");
    assert.deepEqual(leaked, [], "no capability beyond the required set approved");
    assert.deepEqual(unexpected, [], "nothing approved that is not in the required set (+ MSC4533 token)");
    assert.ok(approved.includes(MSC4533_GET_TOKEN), "MSC4533 token capability approved (requested)");

    // what the widget may not do is refused by the driver / native layer
    const msg = await probe.request("send_event", { type: "m.room.message", content: { msgtype: "m.text", body: "should never be sent" } });
    assert.ok(msg.response.error, `m.room.message refused (${JSON.stringify(msg.response).slice(0, 160)})`);
    log(`send m.room.message → error: ${msg.response.error.message}`);
    const foreign = await probe.request("send_event", { type: "org.matrix.msc3401.call.member", state_key: "_@someone:lumen.test_OTHER_m.call", content: {} });
    assert.ok(foreign.response.error, "call membership of another user refused");
    log(`send call.member for another user → error: ${foreign.response.error.message}`);
    const pl = await probe.request("send_event", { type: "m.room.power_levels", state_key: "", content: {} });
    assert.ok(pl.response.error, "power levels refused");
    const td = await probe.request("send_to_device", { type: "m.room_key_request", encrypted: true, messages: { [u]: { "*": { action: "request" } } } });
    assert.ok(td.response.error, "to-device of a type outside the set refused");
    log(`send_to_device m.room_key_request → error: ${td.response.error.message}`);
    const readMsgs = await probe.request("org.matrix.msc2876.read_events", { type: "m.room.message", limit: 10 });
    assert.ok(readMsgs.response.error || (Array.isArray(readMsgs.response.events) && readMsgs.response.events.length === 0), `reading m.room.message refused (${JSON.stringify(readMsgs.response).slice(0, 160)})`);
    log(`read m.room.message → ${readMsgs.response.error ? `error: ${readMsgs.response.error.message}` : "no events"}`);
    const delegate = await probe.request("org.matrix.msc4533.rtc_livekit_delegate_delayed_leave", { delay_id: "x" });
    assert.ok(delegate.response.error, "MSC4533 delegate_delayed_leave refused");

    // MSC4533 token: only for the bound room and this device's member ID
    const transports = await probe.request("org.matrix.msc4515.get_rtc_transports");
    const sfu = transports.response.rtc_transports?.find((t) => t.type === "livekit")?.url;
    assert.ok(sfu, `RTC transports via the driver: ${JSON.stringify(transports.response)}`);
    const body = { url: sfu, server_name: BASE, room_id: roomId, slot_id: "m.call#ROOM", member_id: `${u}:${d}` };
    const other = await probe.request(MSC4533_GET_TOKEN, { ...body, room_id: "!notthisroom:lumen.test" });
    assert.ok(other.response.error, "token for another room refused");
    const imp = await probe.request(MSC4533_GET_TOKEN, { ...body, member_id: `${web.userId}:${web.deviceId}` });
    assert.ok(imp.response.error, "token for another member ID refused");
    const ok = await probe.request(MSC4533_GET_TOKEN, body);
    assert.ok(ok.response.jwt, `token for own room/member issued (${JSON.stringify(ok.response).slice(0, 200)})`);
    const claims = jwtClaims(ok.response.jwt);
    assert.equal(claims.sub, livekitIdentity(u, `${u}:${d}`), "LiveKit identity = sha256([user, member]) (same as the web client's)");
    log(`own-room token: identity ${claims.sub.slice(0, 8)}… (pseudonymous hash), valid ${Math.round((claims.exp - Date.now() / 1000) / 60)} min`);
    // no state was changed by the refused requests
    const msgs = await mx(web, "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`);
    assert.ok(!JSON.stringify(msgs.json).includes("should never be sent"));
    await probe.stop();
    log(`probe harness stopped (exit ${JSON.stringify(probe.exited)})`);
    probe = null;
  });

  await step("native: the harness signs in (m.login.token), trusts the dev CA, joins the DM and builds the widget URL", async () => {
    harness = await startHarness({ homeserver: HS, loginToken: nativeAcct.login_tokens[1], roomId, widgetUrl: WIDGET_URL, intent: "start_call", video: true, notify: "ring", ca: CA, label: "native", log });
    const i = harness.info;
    const u = new URL(i.webview_url);
    const p = Object.fromEntries(u.searchParams);
    log(`widget URL params: ${Object.keys(p).join(", ")}`);
    assert.equal(u.origin, WIDGET_ORIGIN);
    assert.equal(p.widgetId, i.widget_id);
    assert.equal(p.parentUrl, WIDGET_ORIGIN);
    assert.equal(p.roomId, roomId);
    assert.equal(p.userId, nativeAcct.user_id);
    assert.equal(p.deviceId, i.device_id);
    assert.equal(new URL(p.baseUrl).origin, HS);
    assert.equal(p.lang, "en-US");
    assert.equal(p.theme, "dark");
    assert.equal(p.intent, "start_call");
    assert.equal(p.video, "true");
    assert.equal(p.notify, "ring");
    assert.ok(!/access_token|loginToken|syt_/.test(i.webview_url), "no credential in the widget URL");
    assert.equal(i.room_encrypted, true);
  });

  await step("widget page (lab-a, http://localhost) connects over the native bridge; capabilities negotiated", async () => {
    assert.ok(fs.existsSync(path.join(WIDGET_DIR, "index.html")), "services/chat/dist-widget/index.html exists (npm run build:widget)");
    server = await startWidgetServer("lab-a");
    phone = await launchClient({ ns: "lab-a", label: "widget", tone: 440, viewport: { width: 412, height: 915 }, colorScheme: "dark" });
    shotTargets.push(phone);
    bridge = await connectBridge(phone, harness, WIDGET_ORIGIN);
    await phone.page.goto(harness.info.webview_url);
    const caps = await harness.waitFor((m) => m.api === "toWidget" && m.action === "notify_capabilities", 45_000, "notify_capabilities");
    // what the widget asked for, verbatim (the driver's notify_capabilities.requested only
    // lists what the Rust SDK can parse)
    const answer = bridge.fromWidget.find((m) => m.api === "toWidget" && m.action === "capabilities" && m.response);
    assert.ok(answer, "widget answered the capabilities request");
    const requested = answer.response.capabilities;
    const approved = caps.data.approved;
    const required = requiredCapabilities(harness.info.user_id, harness.info.device_id);
    log(`widget requested ${requested.length}, approved ${approved.length}`);
    log(`requested but not approved: ${JSON.stringify(requested.filter((c) => !approved.includes(c)))}`);
    assert.deepEqual(required.filter((c) => !approved.includes(c)), [], "all required capabilities approved");
    assert.deepEqual(approved.filter((c) => !required.includes(c) && c !== MSC4533_GET_TOKEN), [], "nothing beyond the required set");
    assert.ok(requested.includes(MSC4533_GET_TOKEN) && approved.includes(MSC4533_GET_TOKEN), "SFU token capability requested and approved");
    assert.ok(bridge.fromWidget.some((m) => m.action === "content_loaded"), "widget sent content_loaded");
    assert.equal(bridge.other.filter((m) => m.invalid).length, 0);
  });

  await step("widget starts the call (ring) and joins it over MatrixRTC through the Rust SDK", async () => {
    const connected = await bridge.waitState((s) => s.state === "connected", 90_000, "call_state connected");
    log(`call_state sequence: ${bridge.callStates.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]).join(" → ")}; video=${connected.video} muted=${connected.muted}`);
    for (const s of bridge.callStates) assert.ok(!JSON.stringify(s).match(/"key"|jwt|access_token/i), "call_state carries no keys or tokens");
    const sk = `_${harness.info.user_id}_${harness.info.device_id}_m.call`;
    const st = await mx(web, "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(sk)}`);
    assert.equal(st.status, 200, `membership state of the widget's device: ${st.text}`);
    log(`widget membership (sent through the driver): application=${st.json.application} call_id=${JSON.stringify(st.json.call_id)} transport=${JSON.stringify(st.json.foci_preferred ?? st.json.focus_active ?? st.json.transports)}`);
    const sentMember = bridge.fromWidget.filter((m) => m.action === "send_event" && m.data?.type === "org.matrix.msc3401.call.member");
    const delayed = bridge.fromWidget.filter((m) => m.action === "send_event" && m.data?.delay !== undefined);
    log(`widget → driver: ${sentMember.length} call.member sends (${delayed.length} delayed), ${bridge.fromWidget.filter((m) => m.action === "org.matrix.msc4157.update_delayed_event").length} delayed-event updates, ${bridge.fromWidget.filter((m) => m.action === MSC4533_GET_TOKEN).length} SFU token request(s)`);
    assert.ok(delayed.length >= 1, "delayed leave event scheduled through the driver");
  });

  await step("web user answers the ring in the normal web client and joins the same call", async () => {
    await openRoom(web, roomId);
    await acceptIncoming(web, "video");
    await waitPhase(web, "connected");
    log(`web call status: ${(await web.page.locator('[data-testid="call-status"]').textContent())?.trim()}`);
  });

  await step("E2EE on both sides, with media keys exchanged as Olm-encrypted to-device messages through the Rust SDK", async () => {
    await waitE2EE(web, 60_000);
    const tiles = await remoteTiles(web);
    const nat = tiles.find((t) => t.user === nativeAcct.user_id);
    assert.ok(nat, `web shows the native participant (${JSON.stringify(tiles)})`);
    assert.equal(nat.enc, "encrypted", `web: native participant's media is ${nat.enc}`);
    assert.ok(nat.key !== "" && nat.key !== undefined, "web holds a key (index) for the native participant");
    log(`web UI: "${(await web.page.locator('[data-testid="call-e2ee"]').textContent())?.trim()}"; native tile encryption=${nat.enc} key index=${nat.key}`);
    const enc = await bridge.waitState((s) => s.state === "connected" && s.e2ee === "encrypted", 60_000, "call_state e2ee encrypted");
    log(`widget call_state: e2ee=${enc.e2ee} remoteEncrypted=${enc.remoteEncrypted}/${enc.remoteTotal}`);
    await phone.page.locator('[data-testid="call-e2ee"]').waitFor({ timeout: 30_000 });
    log(`widget UI: "${(await phone.page.locator('[data-testid="call-e2ee"]').textContent())?.trim()}"`);
    // protocol evidence: keys went both ways as encrypted to-device messages via the driver
    const keysIn = harness.toWidget.filter((m) => m.api === "toWidget" && m.action === "send_to_device" && m.data?.type === "io.element.call.encryption_keys");
    const keysOut = bridge.fromWidget.filter((m) => m.action === "send_to_device" && m.data?.type === "io.element.call.encryption_keys");
    log(`media keys: ${keysIn.length} received by the widget (encrypted flag: ${[...new Set(keysIn.map((m) => m.data.encrypted))].join("/")}, senders: ${[...new Set(keysIn.map((m) => m.data.sender))].join(", ")}), ${keysOut.length} sent (encrypted flag: ${[...new Set(keysOut.map((m) => m.data.encrypted))].join("/")})`);
    assert.ok(keysIn.length >= 1 && keysIn.every((m) => m.data.encrypted === true), "widget received the web user's key Olm-encrypted");
    assert.ok(keysIn.some((m) => m.data.sender === web.userId), "the key came from the web user");
    assert.ok(keysOut.length >= 1 && keysOut.every((m) => m.data.encrypted === true), "widget sent its key with encryption requested");
    assert.ok(!bridge.callStates.some((s) => JSON.stringify(s).includes(keysIn[0]?.data?.content?.keys?.[0]?.key ?? "@@")), "keys never appear in call_state messages");
  });

  await step("media flows both ways: inbound RTP audio and video on both sides (getStats), tones identified by FFT", async () => {
    const [w, b] = await Promise.all([sampleRates(phone, 4000), sampleRates(web, 4000)]);
    const wi = assertInbound(w, "widget");
    const bi = assertInbound(b, "web");
    log(`widget inbound: ${summary(w, "in")}`);
    log(`widget outbound: ${summary(w, "out")}`);
    log(`web inbound: ${summary(b, "in")}`);
    log(`web outbound: ${summary(b, "out")}`);
    log(`widget receives audio ${wi.audio.kbps} kbit/s, video ${wi.video.frameWidth}x${wi.video.frameHeight}; web receives audio ${bi.audio.kbps} kbit/s, video ${bi.video.frameWidth}x${bi.video.frameHeight}`);
    const heardByWeb = await hearRemoteTones(web);
    const heardByWidget = await hearRemoteTones(phone);
    log(`web hears: ${JSON.stringify(heardByWeb)}`);
    log(`widget hears: ${JSON.stringify(heardByWidget)}`);
    const near = (rows, user, hz) => rows.some((r) => r.participant === user && r.medianPeakHz !== null && Math.abs(r.medianPeakHz - hz) <= 15);
    assert.ok(near(heardByWeb, nativeAcct.user_id, 440), "web hears the phone's 440 Hz tone");
    assert.ok(near(heardByWidget, web.userId, 660), "widget hears the web user's 660 Hz tone");
    await phone.page.screenshot({ path: path.join(OUT, "widget-in-call-mobile-dark.png") });
  });

  await step("hang-up from the native side (io.lumen.call_action hangup) ends the widget's call; the web user sees the leave", async () => {
    const before = bridge.callStates.length;
    await bridge.action("hangup");
    const ended = await bridge.waitState((s) => s.state === "ended" && bridge.callStates.indexOf(s) >= before, 30_000, "call_state ended");
    log(`widget call_state: ended (${ended.reason ?? "no reason"})`);
    // 1:1: the web client ends its call when the other person leaves
    await web.page.locator('[data-testid="call-status"]', { hasText: /left the call/ }).or(web.page.locator(".call-screen[data-phase=ended]")).first().waitFor({ timeout: 45_000 });
    log(`web call status: ${(await web.page.locator('[data-testid="call-status"]').textContent().catch(() => "(closed)"))?.trim()}`);
    const sk = `_${harness.info.user_id}_${harness.info.device_id}_m.call`;
    const st = await mx(web, "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(sk)}`);
    assert.ok(st.status === 404 || (st.status === 200 && Object.keys(st.json).length === 0), `widget membership cleared (${st.status} ${st.text.slice(0, 120)})`);
    log(`widget membership state after hang-up: ${st.status === 200 ? JSON.stringify(st.json) : st.status}`);
  });

  await step("bridge hygiene: no CSP violations or page errors in the widget, nothing undeliverable", async () => {
    log(`bridge: ${bridge.fromWidget.length} widget → driver messages, ${bridge.delivered} driver → widget messages delivered, ${bridge.callStates.length} call_state messages, ${bridge.other.length} other`);
    assert.deepEqual(bridge.deliveryErrors, []);
    assert.deepEqual(phone.problems, [], "widget page: no CSP violations or page errors");
    const leaks = harness.stderr.filter((l) => /syt_|loginToken=|access_token|"key":/i.test(l));
    assert.deepEqual(leaks, [], "harness log contains no tokens or keys");
  });
} finally {
  if (web) await hangUpAll(web).catch(() => undefined);
  if (probe) await probe.stop().catch(() => undefined);
  if (harness) {
    const ex = await harness.stop().catch(() => null);
    log(`native harness stopped (exit ${JSON.stringify(ex)}): logged out, device deleted`);
  }
  for (const c of [phone, web]) await c?.browser?.close().catch(() => undefined);
  if (web) await signOutServer(web).catch(() => undefined);
  if (server) server.kill("SIGTERM");
  log(`\napps-widget-call: ${passed} passed, ${failed} failed (started ${started.toISOString()}, finished ${new Date().toISOString()})`);
  const file = path.join(RESULTS, "apps-widget-call.txt");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`raw output saved to ${path.relative(REPO, file)}`);
  process.exitCode = failed ? 1 : 0;
}
