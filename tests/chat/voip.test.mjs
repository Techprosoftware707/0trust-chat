/**
 * 1:1 voice/video call test (legacy Matrix VoIP via matrix-js-sdk), with
 * `voip_enabled: true` and Chromium's fake camera/microphone. Both browsers run
 * on this machine, so ICE uses host candidates (no TURN needed).
 *
 * Checks that the call connects in both directions of signalling (encrypted DM),
 * and that the "media encrypted" badge only appears once getStats() reports a
 * connected DTLS transport with an SRTP cipher.
 *
 * Run: npm run test:voip   (from services/chat; needs `npm run devserver:up`)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { importChatDep } from "./lib/deps.mjs";
import { defaultConfig, startServer } from "./lib/serve.mjs";
import { devServerInfo, ensureReachable, registerUser } from "./lib/synapse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "screenshots");
const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const info = devServerInfo();
const T = 30_000;

let server;
let origin;
let browser;
let ada;
let grace;
let A;
let B;

async function signIn(user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone", "camera"] });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => logs.push({ type: "pageerror", text: e.message }));
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Sign in to another Matrix server" }).click();
  await page.getByLabel("Server name or URL").fill(origin);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Later" }).click({ timeout: T });
  return { ctx, page, logs };
}

before(async () => {
  await ensureReachable(info.baseUrl);
  A = await registerUser(info, { displayname: "Ada Lovelace" });
  B = await registerUser(info, { displayname: "Grace Hopper" });
  ({ server, origin } = await startServer({ port: 0, upstream: info.baseUrl, config: () => ({ ...defaultConfig(), voip_enabled: true }) }));
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  ada = await signIn(A);
  grace = await signIn(B);
  await ada.page.getByRole("button", { name: "Start a conversation" }).click();
  await ada.page.getByRole("menuitem", { name: "New direct message" }).click();
  await ada.page.getByLabel("Find people").fill(B.user_id);
  await ada.page.locator(".user-result").first().click();
  await ada.page.getByRole("button", { name: "Start conversation" }).click();
  await ada.page.locator("#composer").fill("Call me?");
  await ada.page.keyboard.press("Enter");
  await grace.page.getByRole("button", { name: "Accept" }).first().click({ timeout: T });
  await grace.page.locator(".msg-body", { hasText: "Call me?" }).waitFor({ timeout: T });
  await ada.page.locator(".room-header .room-sub").waitFor();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function connectAndCheck(kind) {
  await ada.page.getByRole("button", { name: kind === "video" ? "Video call" : "Voice call" }).click({ timeout: T });
  await ada.page.locator(".call-view .call-status", { hasText: /Calling|Ringing|Starting|Waiting/ }).waitFor({ timeout: T });
  const incoming = grace.page.getByRole("dialog", { name: "Ada Lovelace is calling" });
  await incoming.waitFor({ timeout: T });
  await incoming.getByRole("button", { name: "Answer" }).click();
  for (const p of [ada.page, grace.page]) {
    await p.locator(".call-view .call-status", { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: T });
    const badge = p.locator(".call-view .badge", { hasText: "Media encrypted" });
    await badge.waitFor({ timeout: T });
    assert.match(await badge.textContent(), /DTLS-SRTP \((AES|AEAD)[A-Z0-9_]+\)/);
  }
  if (kind === "video") {
    const size = await grace.page.locator(".call-remote").evaluate(async (v) => {
      for (let i = 0; i < 50 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
      return [v.videoWidth, v.videoHeight];
    });
    assert.ok(size[0] > 0 && size[1] > 0, "remote video is playing");
  }
}

test("voice call connects with DTLS-SRTP media protection reported from getStats()", async () => {
  await connectAndCheck("voice");
  const mute = ada.page.getByRole("button", { name: "Mute microphone" });
  await mute.click();
  await ada.page.getByRole("button", { name: "Unmute microphone" }).waitFor();
  await ada.page.screenshot({ path: path.join(SHOTS, "desktop-light-voice-call.png") });
  await grace.page.getByRole("button", { name: "Hang up" }).click();
  for (const p of [ada.page, grace.page]) await p.locator(".call-view .call-status", { hasText: "Call ended" }).waitFor({ timeout: T });
  await ada.page.locator(".call-view").waitFor({ state: "detached", timeout: T });
});

test("video call connects; remote video plays", async () => {
  await connectAndCheck("video");
  await ada.page.screenshot({ path: path.join(SHOTS, "desktop-light-video-call.png") });
  await ada.page.getByRole("button", { name: "Hang up" }).click();
  for (const p of [ada.page, grace.page]) await p.locator(".call-view .call-status", { hasText: "Call ended" }).waitFor({ timeout: T });
});

test("declining an incoming call ends it for the caller", async () => {
  await ada.page.locator(".call-view").waitFor({ state: "detached", timeout: T });
  await ada.page.getByRole("button", { name: "Voice call" }).click();
  const incoming = grace.page.getByRole("dialog", { name: "Ada Lovelace is calling" });
  await incoming.getByRole("button", { name: "Decline" }).click({ timeout: T });
  await ada.page.locator(".call-view .call-status", { hasText: "Call ended" }).waitFor({ timeout: T });
});

test("no CSP violations or page errors during calls", async () => {
  const all = [...ada.logs, ...grace.logs];
  assert.deepEqual(all.filter((l) => /Content Security Policy/i.test(l.text)), []);
  assert.deepEqual(all.filter((l) => l.type === "pageerror"), []);
});
