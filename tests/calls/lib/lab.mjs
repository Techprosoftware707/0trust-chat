/**
 * Shared helpers for the call tests: real Chromium clients, each started inside its own
 * network namespace (see tests/calls/lab.sh), signed in to the deployed Lumen stack
 * (https://app.lumen.test) through the portal's SSO.
 *
 * Nothing here simulates media or signalling: every client is a separate browser
 * process with its own network stack, fake capture devices (Chromium's
 * --use-fake-device-for-media-stream) and a distinct test tone as microphone input,
 * talking to the real homeserver, lk-jwt-service and LiveKit SFU.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "../../chat/lib/deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Matrix API calls from the test (Node side) must trust the stack's internal CA.
const STACK_CA = process.env.LUMEN_CA || "/etc/lumen/ca/caddy-local-root.crt";
const CA_LIST = [...tls.rootCertificates, ...(fs.existsSync(STACK_CA) ? [fs.readFileSync(STACK_CA, "utf8")] : [])];

/** Minimal fetch-like HTTPS request trusting the stack CA: resolves { status, text }. */
export function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca: CA_LIST }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const REPO = path.resolve(HERE, "../../..");
export const OUT = path.join(REPO, "tests/calls/output");
export const SHOTS = path.join(REPO, "tests/calls/screenshots");
export const RESULTS = path.join(REPO, "docs/test-results");
/**
 * Command-line options shared by every call test:
 *   --base <domain>     Lumen base domain (default lumen.test): app.<base>, matrix.<base>, rtc.<base>
 *   --server-ip <ip>    address every client resolves <base> and *.<base> to (default 10.200.0.1,
 *                       the lab bridge, which LiveKit advertises with CALLS_PUBLIC_IP in lab mode)
 *   --no-netns          run all clients in the host's network namespace (no lab.sh); tests that
 *                       need per-client network impairment are then skipped
 * Environment equivalents: LUMEN_BASE, LUMEN_SERVER_IP, LUMEN_NO_NETNS=1.
 */
const argv = process.argv.slice(2);
function opt(name, env, def) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env[env] || def;
}
export const BASE = opt("--base", "LUMEN_BASE", "lumen.test");
export const LAB_HOST_IP = opt("--server-ip", "LUMEN_SERVER_IP", "10.200.0.1");
export const NO_NETNS = argv.includes("--no-netns") || process.env.LUMEN_NO_NETNS === "1";
export const APP = `https://app.${BASE}`;
export const HS = `https://matrix.${BASE}`;
export const T = 60_000;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const pw = await importChatDep("playwright");
export const chromium = pw.chromium ?? pw.default.chromium;

// ---------------------------------------------------------------------------------------
// Lab (network namespaces)
// ---------------------------------------------------------------------------------------

export function lab(...args) {
  return execFileSync("bash", [path.join(REPO, "tests/calls/lab.sh"), ...args], { encoding: "utf8" }).trim();
}

export function ensureLab() {
  if (NO_NETNS) return "no network namespaces (--no-netns): all clients share the host network";
  const status = lab("status");
  if (!/lab-a: 10\.200\.0\.11/.test(status) || !/lab-c: 10\.200\.0\.13/.test(status)) lab("up");
  for (const ns of ["lab-a", "lab-b", "lab-c"]) {
    lab("unshape", ns);
    lab("unblock-all", ns);
    lab("link", ns, "up");
  }
  return lab("status");
}

/** The newest full Chromium build Playwright installed (not the headless shell). */
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

/** A tiny launcher that runs Chromium inside the given network namespace. */
export function wrapperFor(ns) {
  if (NO_NETNS) return chromeBinary();
  const file = path.join(OUT, `chrome-${ns}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\nexec ip netns exec ${ns} ${chromeBinary()} "$@"\n`, { mode: 0o755 });
  return file;
}

// ---------------------------------------------------------------------------------------
// Test tones: 48 kHz mono PCM WAV, one distinct frequency per client
// ---------------------------------------------------------------------------------------

export function toneFile(freq, { seconds = 10, amplitude = 0.3 } = {}) {
  const file = path.join(OUT, `tone-${freq}hz.wav`);
  if (fs.existsSync(file)) return file;
  const rate = 48_000;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // whole number of periods per file so the loop is seamless
    const s = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

// ---------------------------------------------------------------------------------------
// Browser clients
// ---------------------------------------------------------------------------------------

/**
 * Test-only instrumentation injected before any page script (never part of the app):
 * remembers every RTCPeerConnection so the test can read getStats() independently of the
 * app's own diagnostics.
 */
function instrument() {
  const Native = window.RTCPeerConnection;
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

/**
 * Starts a Chromium client inside `ns`. `tone` (Hz) is the microphone input; `fakeDevices`
 * false gives a browser without any capture device (for the permission/no-device test).
 */
/**
 * A per-namespace browser profile HOME whose NSS store trusts the stack's internal CA
 * (Chromium's WebRTC TURN/TLS client checks certificates independently of Playwright's
 * ignoreHTTPSErrors). Test environment only: real users' devices trust a public CA.
 */
function profileHome(ns) {
  const home = path.join(OUT, `home-${ns}`);
  const db = path.join(home, ".pki", "nssdb");
  const ca = STACK_CA;
  try {
    if (!fs.existsSync(path.join(db, "cert9.db"))) {
      fs.mkdirSync(db, { recursive: true });
      execFileSync("certutil", ["-N", "-d", `sql:${db}`, "--empty-password"], { stdio: "ignore" });
    }
    if (fs.existsSync(ca)) execFileSync("certutil", ["-A", "-d", `sql:${db}`, "-t", "C,,", "-n", "lumen-test-ca", "-i", ca], { stdio: "ignore" });
  } catch {
    /* certutil missing: TURN/TLS may then fail certificate checks */
  }
  return home;
}

export async function launchClient({ ns, label, tone = 440, viewport = { width: 1280, height: 800 }, colorScheme = "light", permissions = ["microphone", "camera"], fakeDevices = true, fakeVideo = "fps=30,device-count=3", fakeUi = true, extraArgs = [] }) {
  const args = [
    `--host-resolver-rules=MAP ${BASE} ${LAB_HOST_IP}, MAP *.${BASE} ${LAB_HOST_IP}`,
    "--no-proxy-server",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    ...(fakeDevices ? [`--use-fake-device-for-media-stream=${fakeVideo}`, `--use-file-for-fake-audio-capture=${toneFile(tone)}`] : []),
    ...(fakeUi ? ["--use-fake-ui-for-media-stream"] : []),
    ...extraArgs,
  ];
  const browser = await chromium.launch({ executablePath: wrapperFor(ns), headless: true, args, env: { ...process.env, HOME: profileHome(ns) } });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, colorScheme, permissions });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const problems = [];
  const logs = [];
  page.on("console", (m) => {
    const text = m.text();
    logs.push(`[${m.type()}] ${text}`);
    if (/Content Security Policy|Refused to (load|execute|create|connect)/i.test(text)) problems.push(`CSP: ${text}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return { ns, label, tone, browser, context, page, problems, logs };
}

// ---------------------------------------------------------------------------------------
// Accounts (portal sign-up, SSO sign-in)
// ---------------------------------------------------------------------------------------

const ACCOUNTS = path.join(OUT, "accounts.json");

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"));
  } catch {
    return {};
  }
}

function saveAccounts(a) {
  fs.writeFileSync(ACCOUNTS, JSON.stringify(a, null, 2), { mode: 0o600 });
}

/** Portal sign-up from inside the client's namespace (the portal rate-limits per IP). */
async function portalSignUp(page, acct) {
  await page.goto(`https://${BASE}/accounts/signup/`);
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
}

/** Follows app -> homeserver SSO -> portal OIDC (logging in when asked) -> app. */
async function ssoSignIn(client, acct) {
  const { page } = client;
  let loginBody = null;
  const onResponse = async (r) => {
    if (r.url().endsWith("/_matrix/client/v3/login") && r.request().method() === "POST" && r.status() === 200) {
      loginBody = await r.json().catch(() => null);
    }
  };
  page.on("response", onResponse);
  for (let attempt = 1; ; attempt++) {
    await page.goto(APP + "/");
    await page.getByRole("button", { name: /Continue with your .* account/ }).click({ timeout: T });
    for (let i = 0; i < 10 && !page.url().startsWith(APP); i++) {
      await page.waitForLoadState("domcontentloaded");
      if (page.url().startsWith(APP)) break;
      if (await page.locator("input[name=login]").count()) {
        await page.fill("input[name=login]", acct.username);
        await page.fill("input[name=password]", acct.password);
        await Promise.all([page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), page.locator("form button[type=submit]").last().click()]);
        continue;
      }
      const next = page.locator("a:has-text('Continue'), button:has-text('Continue'), button:has-text('Allow'), button:has-text('Authorize')");
      if (await next.count()) await Promise.all([page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined), next.first().click()]);
      else await page.waitForTimeout(1000);
    }
    const ready = page.locator(".user-chip-id");
    const limited = page.getByText("You're doing that too often");
    await ready.or(limited).first().waitFor({ timeout: T }).catch(() => undefined);
    if ((await limited.count()) && attempt < 6) {
      console.log(`     (homeserver login rate limit for ${acct.username}; retrying in 30 s)`);
      await page.waitForTimeout(30_000);
      continue;
    }
    break;
  }
  page.off("response", onResponse);
  await page.locator(".user-chip-id").waitFor({ timeout: T });
  assert.equal((await page.locator(".user-chip-id").textContent())?.trim(), acct.userId);
  // First-run security prompts (backup set-up / verify this device): not part of these tests.
  for (let i = 0; i < 3; i++) {
    const later = page.getByRole("dialog").getByRole("button", { name: /^(Later|Not now|Skip)$/ });
    if (await later.count()) await later.first().click().catch(() => undefined);
    else await page.waitForTimeout(700);
  }
  client.accessToken = loginBody?.access_token ?? null;
  client.deviceId = loginBody?.device_id ?? null;
}

/**
 * Signs `client` in as the account cached under `key` (created through the portal on first
 * use, from inside the client's namespace).
 */
export async function signIn(client, key, displayName) {
  const accounts = loadAccounts();
  let acct = accounts[key];
  if (!acct) {
    const username = `call${key.replace(/[^a-z0-9]/g, "")}${randomBytes(3).toString("hex")}`;
    acct = { username, displayName, password: `Call-Test-${randomBytes(9).toString("hex")}`, userId: `@${username}:${BASE}` };
    await portalSignUp(client.page, acct);
    accounts[key] = acct;
    saveAccounts(accounts);
    console.log(`     created portal account ${acct.userId} (${displayName}) from ${client.ns}`);
  }
  client.acct = acct;
  client.userId = acct.userId;
  await ssoSignIn(client, acct);
  return acct;
}

/** Ends the client's Matrix session on the server (keeps the account). */
export async function signOutServer(client) {
  if (!client?.accessToken) return;
  await request(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${client.accessToken}` } }).catch(() => undefined);
}

/** Matrix client-server API call with the client's access token (from the host). */
export async function mx(client, method, p, body) {
  const r = await request(`${HS}${p}`, {
    method,
    headers: { Authorization: `Bearer ${client.accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = r.text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}

// ---------------------------------------------------------------------------------------
// Chat helpers (through the UI)
// ---------------------------------------------------------------------------------------

/** Creates a DM (from `a` to `b`), b accepts. Returns the room id. */
export async function createDm(a, b) {
  const page = a.page;
  await page.getByRole("button", { name: "Start a conversation" }).click();
  await page.getByRole("menuitem", { name: "New direct message" }).click();
  await page.getByLabel("Find people").fill(b.userId);
  await page.locator(".user-result").first().click({ timeout: T });
  await page.getByRole("button", { name: "Start conversation" }).click();
  // the app opens the existing DM with this person if there is one, else creates it
  await page.locator(".room-header .room-title", { hasText: b.acct.displayName }).waitFor({ timeout: T });
  await page.waitForFunction(() => /#\/room\//.test(location.hash), null, { timeout: T });
  const roomId = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/room\//, "").split("/")[0]));
  await page.locator("#composer").fill(`Hi ${b.acct.displayName}`);
  await page.keyboard.press("Enter");
  await acceptInvite(b, roomId);
  return roomId;
}

/** Creates a group with the given members (from `a`), everyone accepts. */
export async function createGroup(a, others, name) {
  const page = a.page;
  await page.getByRole("button", { name: "Start a conversation" }).click();
  await page.getByRole("menuitem", { name: "New group" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Group name|Name/).first().fill(name);
  for (const o of others) {
    await dialog.getByLabel(/Find people|Invite/).first().fill(o.userId);
    await dialog.locator(".user-result").first().click({ timeout: T });
  }
  await dialog.getByRole("button", { name: /Create/ }).click();
  await page.locator(".room-header .room-title", { hasText: name }).waitFor({ timeout: T });
  await page.waitForFunction(() => /#\/room\//.test(location.hash), null, { timeout: T });
  const roomId = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/room\//, "").split("/")[0]));
  for (const o of others) await acceptInvite(o, roomId);
  return roomId;
}

export async function acceptInvite(client, roomId) {
  const page = client.page;
  await page.goto(`${APP}/#/room/${encodeURIComponent(roomId)}`);
  // (an existing DM is reused by the app: then there is no invite to accept)
  const accept = page.locator(".empty-card").getByRole("button", { name: "Accept" });
  const header = page.locator(".room-header");
  await accept.or(header).first().waitFor({ timeout: T });
  if (await accept.count()) await accept.click();
  await header.waitFor({ timeout: T });
}

export async function openRoom(client, roomId) {
  await client.page.goto(`${APP}/#/room/${encodeURIComponent(roomId)}`);
  await client.page.locator(".room-header").waitFor({ timeout: T });
}

// ---------------------------------------------------------------------------------------
// Media evidence (run in the page)
// ---------------------------------------------------------------------------------------

/**
 * Dominant frequency of every remote audio element in the call (by participant), measured
 * with an AnalyserNode on the received MediaStreamTrack.
 */
export async function hearRemoteTones(client, ms = 2500) {
  return client.page.evaluate(async (ms) => {
    const els = [...document.querySelectorAll("audio[data-call-audio]")];
    const ctx = new AudioContext();
    await ctx.resume().catch(() => undefined);
    const results = [];
    const probes = els.map((el) => {
      const stream = el.srcObject;
      const track = stream?.getAudioTracks?.()[0];
      if (!track) return null;
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      return { el, an, peaks: [], rms: [] };
    });
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 250));
      for (const p of probes) {
        if (!p) continue;
        const f = new Float32Array(p.an.frequencyBinCount);
        p.an.getFloatFrequencyData(f);
        let best = 0;
        for (let i = 1; i < f.length; i++) if (f[i] > f[best]) best = i;
        const td = new Float32Array(p.an.fftSize);
        p.an.getFloatTimeDomainData(td);
        let sum = 0;
        for (const v of td) sum += v * v;
        p.peaks.push({ hz: Math.round((best * ctx.sampleRate) / p.an.fftSize), db: Math.round(f[best]) });
        p.rms.push(Math.sqrt(sum / td.length));
      }
    }
    for (const p of probes) {
      if (!p) continue;
      const loud = p.peaks.filter((x, i) => p.rms[i] > 0.003);
      const hz = loud.length ? loud.map((x) => x.hz).sort((a, b) => a - b)[Math.floor(loud.length / 2)] : null;
      results.push({
        participant: p.el.dataset.participant ?? null,
        name: p.el.dataset.name ?? null,
        source: p.el.dataset.source ?? null,
        medianPeakHz: hz,
        audibleFraction: Math.round((loud.length / Math.max(1, p.peaks.length)) * 100) / 100,
        meanRms: Math.round((p.rms.reduce((a, b) => a + b, 0) / Math.max(1, p.rms.length)) * 10000) / 10000,
      });
    }
    await ctx.close();
    return results;
  }, ms);
}

/** Raw getStats() of every peer connection, reduced to the fields the tests look at. */
export async function rtcStats(client) {
  return client.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__lumenTestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      const r = await pc.getStats();
      const all = [];
      r.forEach((s) => all.push(s));
      out.push({ connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, stats: all });
    }
    return out;
  });
}

/** Summary of media flowing in/out (one row per RTP stream). */
export function summariseRtp(pcs) {
  const rows = [];
  for (const pc of pcs) {
    const byId = new Map(pc.stats.map((s) => [s.id, s]));
    for (const s of pc.stats) {
      if (s.type !== "inbound-rtp" && s.type !== "outbound-rtp") continue;
      const codec = byId.get(s.codecId);
      rows.push({
        dir: s.type === "inbound-rtp" ? "in" : "out",
        kind: s.kind,
        ssrc: s.ssrc,
        rid: s.rid,
        mimeType: codec?.mimeType,
        clockRate: codec?.clockRate,
        channels: codec?.channels,
        fmtp: codec?.sdpFmtpLine,
        bytes: s.type === "inbound-rtp" ? s.bytesReceived : s.bytesSent,
        packets: s.type === "inbound-rtp" ? s.packetsReceived : s.packetsSent,
        packetsLost: s.packetsLost,
        jitter: s.jitter,
        frameWidth: s.frameWidth,
        frameHeight: s.frameHeight,
        framesPerSecond: s.framesPerSecond,
        framesDecoded: s.framesDecoded,
        framesEncoded: s.framesEncoded,
        framesDropped: s.framesDropped,
        keyFramesDecoded: s.keyFramesDecoded,
        qualityLimitationReason: s.qualityLimitationReason,
        targetBitrate: s.targetBitrate,
        concealedSamples: s.concealedSamples,
        totalSamplesReceived: s.totalSamplesReceived,
        concealmentEvents: s.concealmentEvents,
        insertedSamplesForDeceleration: s.insertedSamplesForDeceleration,
        audioLevel: s.audioLevel,
        totalAudioEnergy: s.totalAudioEnergy,
        fecPacketsReceived: s.fecPacketsReceived,
        retransmittedPacketsSent: s.retransmittedPacketsSent,
        nackCount: s.nackCount,
        remoteLoss: (() => {
          const r = pc.stats.find((x) => x.type === "remote-inbound-rtp" && (x.localId === s.id || x.ssrc === s.ssrc));
          return r ? { packetsLost: r.packetsLost, fractionLost: r.fractionLost, rtt: r.roundTripTime, jitter: r.jitter } : undefined;
        })(),
        active: s.active,
        trackIdentifier: s.trackIdentifier,
        pcState: pc.connectionState,
      });
    }
  }
  return rows;
}

/** Selected ICE candidate pair(s): local/remote candidate type, protocol, relay protocol, RTT. */
export function selectedPairs(pcs) {
  const out = [];
  for (const pc of pcs) {
    const byId = new Map(pc.stats.map((s) => [s.id, s]));
    for (const t of pc.stats.filter((s) => s.type === "transport")) {
      const pair = byId.get(t.selectedCandidatePairId);
      if (!pair) continue;
      const l = byId.get(pair.localCandidateId);
      const r = byId.get(pair.remoteCandidateId);
      out.push({
        state: pair.state,
        localType: l?.candidateType,
        localProtocol: l?.protocol,
        relayProtocol: l?.relayProtocol,
        localAddress: l?.address,
        remoteType: r?.candidateType,
        remoteProtocol: r?.protocol,
        remoteAddress: r?.address,
        remotePort: r?.port,
        rtt: pair.currentRoundTripTime,
        dtlsState: t.dtlsState,
        srtpCipher: t.srtpCipher,
      });
    }
  }
  return out;
}

/** Every ICE candidate pair of the client's peer connections, with check counters (evidence when ICE fails). */
export async function icePairs(client) {
  return client.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__lumenTestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      const st = await pc.getStats();
      st.forEach((s) => {
        if (s.type !== "candidate-pair") return;
        const l = st.get(s.localCandidateId);
        const r = st.get(s.remoteCandidateId);
        out.push(`${s.state}: ${l?.candidateType}/${l?.protocol}${l?.relayProtocol ? ` via ${l.relayProtocol}` : ""} ${l?.address ?? ""}:${l?.port ?? ""} → ${r?.candidateType}/${r?.protocol} ${r?.address || "?"}:${r?.port} checks sent ${s.requestsSent}, answered ${s.responsesReceived}, received ${s.requestsReceived}`);
      });
    }
    return out;
  });
}

/** Two stats samples `ms` apart → per-stream bitrate (kbit/s) and packet deltas. */
export async function sampleRates(client, ms = 4000) {
  const a = summariseRtp(await rtcStats(client));
  await client.page.waitForTimeout(ms);
  const b = summariseRtp(await rtcStats(client));
  const key = (r) => `${r.dir}-${r.kind}-${r.ssrc}`;
  const prev = new Map(a.map((r) => [key(r), r]));
  return b.map((r) => {
    const p = prev.get(key(r));
    const dBytes = p ? (r.bytes ?? 0) - (p.bytes ?? 0) : null;
    return {
      ...r,
      kbps: dBytes === null ? null : Math.round((dBytes * 8) / ms),
      dPackets: p ? (r.packets ?? 0) - (p.packets ?? 0) : null,
      dLost: p && r.packetsLost !== undefined ? r.packetsLost - (p.packetsLost ?? 0) : null,
      dFramesDecoded: p && r.framesDecoded !== undefined ? r.framesDecoded - (p.framesDecoded ?? 0) : null,
      dConcealed: p && r.concealedSamples !== undefined ? r.concealedSamples - (p.concealedSamples ?? 0) : null,
      dSamples: p && r.totalSamplesReceived !== undefined ? r.totalSamplesReceived - (p.totalSamplesReceived ?? 0) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

const argvAll = process.argv.slice(2);
/** `--only <regex>`: run only matching steps (plus steps marked `always`). */
const ONLY = argvAll.includes("--only") ? new RegExp(argvAll[argvAll.indexOf("--only") + 1], "i") : null;

export function makeReporter(name) {
  const lines = [];
  const onFail = [];
  const started = new Date();
  let passed = 0;
  let failed = 0;
  const skipped = [];
  const log = (...parts) => {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    lines.push(line);
    console.log(line);
  };
  /** step(title, fn) or step(title, { always }, fn) */
  async function step(title, a, b) {
    const fn = typeof a === "function" ? a : b;
    const { always = false } = (typeof a === "function" ? b : a) ?? {};
    if (ONLY && !always && !ONLY.test(title)) return null;
    log(`\n--- ${title}`);
    const t0 = Date.now();
    try {
      await fn();
      passed++;
      log(`PASS ${title} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      return true;
    } catch (e) {
      failed++;
      log(`FAIL ${title} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n     ${String(e?.stack || e).split("\n").slice(0, 10).join("\n     ")}`);
      const slug = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase();
      for (const f of onFail) await f(slug).catch(() => undefined);
      return false;
    }
  }
  function skip(title, why) {
    skipped.push(title);
    log(`\n--- ${title}\nSKIP ${title}: ${why}`);
  }
  function finish() {
    log(`\n${name}: ${passed} passed, ${failed} failed, ${skipped.length} skipped (started ${started.toISOString()}, finished ${new Date().toISOString()})${ONLY ? ` — partial rerun, --only ${ONLY.source}` : ""}`);
    // a partial rerun (--only) never overwrites the full run's file
    const file = path.join(RESULTS, ONLY ? `calls-${name}-rerun.txt` : `calls-${name}.txt`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    console.log(`raw output saved to ${path.relative(REPO, file)}`);
    return { passed, failed, skipped };
  }
  /** screenshots on failure go to tests/calls/output/fail-*.png (not committed) */
  const failShots = (...clients) =>
    onFail.push(async (slug) => {
      for (const c of clients.flatMap((x) => (typeof x === "function" ? x() : [x])).flat()) if (c?.page && !c.page.isClosed()) await c.page.screenshot({ path: path.join(OUT, `fail-${name}-${slug}-${c.label}.png`) }).catch(() => undefined);
    });
  return { log, step, skip, finish, failShots };
}
