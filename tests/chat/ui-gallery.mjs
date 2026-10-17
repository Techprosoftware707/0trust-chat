#!/usr/bin/env node
/**
 * Screenshot gallery of the web chat client (and the call widget), for design review.
 *
 * Signs in several users on the disposable dev homeserver, creates realistic content (DMs and
 * groups with long names, unread counts, invites, an empty account; a DM with short and very
 * long messages, links, code, an image, a file, a reply, reactions, an edit, a deletion, an
 * unable-to-decrypt message and a run of call events) and captures every screen at
 * 360×740, 390×844, 768×1024, 1024×768, 1280×800 and 1920×1080 in light and dark, plus a
 * 640×400 viewport (= 200 % browser zoom on a 1280×800 laptop).
 *
 * Calls: the lobby, the incoming-call card and the call history come from the dev homeserver;
 * the in-call screens (voice, video, mini call) need a real SFU, so with `--calls` they are
 * taken against the deployed dev stack (https://app.lumen.test, portal SSO accounts as in
 * tests/calls), with the page's own HTML/JS/CSS served from the local build (Playwright
 * routes), so they show the code under review, not the deployed one.
 *
 *   npm run build && npm run build:widget            (in services/chat)
 *   node tests/chat/ui-gallery.mjs [--out DIR] [--calls] [--only REGEX] [--dist DIR] [--widget-dist DIR]
 *
 * Every screenshot goes to tests/chat/output/gallery/ (git-ignored); a curated set (CURATED
 * below, each PNG under ~300 KB) is copied to --out (default docs/test-results/ui-polish/web/after).
 * Needs `npm run devserver:up`; --calls also needs the deployed stack and
 * NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChatDep } from "./lib/deps.mjs";
import { CSP, defaultConfig, startServer } from "./lib/serve.mjs";
import { devServerInfo, ensureReachable, registerUser } from "./lib/synapse.mjs";
import { hoverAction, makePng, msg, passwordSignIn, setUpBackup, T } from "./lib/ui-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const OUT = path.resolve(opt("--out", path.join(REPO, "docs/test-results/ui-polish/web/after")));
const ONLY = argv.includes("--only") ? new RegExp(opt("--only"), "i") : null;
const WITH_CALLS = argv.includes("--calls");
const DIST = path.resolve(opt("--dist", path.join(REPO, "services/chat/dist")));
const WIDGET_DIST = path.resolve(opt("--widget-dist", path.join(REPO, "services/chat/dist-widget")));
const RAW = path.join(HERE, "output", "gallery");
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

export const VIEWPORTS = {
  360: { width: 360, height: 740 },
  390: { width: 390, height: 844 },
  768: { width: 768, height: 1024 },
  1024: { width: 1024, height: 768 },
  1280: { width: 1280, height: 800 },
  1920: { width: 1920, height: 1080 },
  zoom200: { width: 640, height: 400 },
};

/** The curated set copied to --out (names = files in tests/chat/output/gallery). */
const CURATED = [
  "login-1280-light",
  "login-390-dark",
  "backup-intro-1280-light",
  "backup-key-390-dark",
  "nudge-1280-light",
  "list-360-light",
  "list-390-dark",
  "empty-account-1280-light",
  "empty-account-390-dark",
  "dm-1280-light",
  "dm-1280-dark",
  "dm-1920-light",
  "dm-1024-dark",
  "dm-768-light",
  "dm-390-light",
  "dm-390-dark",
  "dm-360-light",
  "dm-zoom200-light",
  "calls-run-1280-light",
  "calls-run-390-dark",
  "group-1280-light",
  "utd-preview-1280-dark",
  "composer-1280-light",
  "composer-390-dark",
  "info-1280-light",
  "info-390-dark",
  "search-1280-dark",
  "settings-profile-1280-light",
  "settings-appearance-1280-dark",
  "settings-notifications-1280-light",
  "settings-calls-1280-light",
  "settings-security-1280-light",
  "settings-sessions-390-dark",
  "settings-about-zoom200-light",
  "verify-sas-1280-light",
  "verify-device-390-light",
  "offline-1280-light",
  "lobby-video-1280-dark",
  "lobby-voice-390-light",
  "incoming-1280-light",
  "incoming-390-dark",
  "join-call-header-1280-light",
  "widget-joining-390-dark",
  "call-voice-1280-dark",
  "call-video-1280-light",
  "call-voice-390-dark",
  "call-mini-1280-light",
];

const failures = [];
async function section(name, fn) {
  if (ONLY && !ONLY.test(name)) return console.log(`- skip ${name}`);
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures.push(name);
    console.log(`✘ ${name}: ${e?.stack ?? e}`);
  }
}

/** Screenshot of `page` at viewport `vp` (key of VIEWPORTS) in `theme`. */
async function shot(page, name, vp = "1280", theme = "light", { fullPage = false } = {}) {
  await page.setViewportSize(VIEWPORTS[vp]);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.mouse.move(VIEWPORTS[vp].width - 2, VIEWPORTS[vp].height - 2);
  await page.waitForTimeout(350);
  const file = path.join(RAW, `${name}-${vp}-${theme}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}
/** The same screen at several viewports and both themes. */
async function shots(page, name, vps, themes = ["light", "dark"], prepare = async () => undefined) {
  for (const vp of vps) for (const theme of themes) {
    await page.setViewportSize(VIEWPORTS[vp]);
    await prepare(vp, theme);
    await shot(page, name, vp, theme);
  }
  await page.setViewportSize(VIEWPORTS["1280"]);
  await page.emulateMedia({ colorScheme: "light" });
}

// ---------------------------------------------------------------------------------------
// Dev homeserver: users and content
// ---------------------------------------------------------------------------------------
const info = devServerInfo();
await ensureReachable(info.baseUrl);
const stamp = Date.now().toString(36).slice(-4);
const A = await registerUser(info, { username: `ada${stamp}`, displayname: "Ada Lovelace" });
const B = await registerUser(info, { username: `grace${stamp}`, displayname: "Grace Hopper" });
const C = await registerUser(info, { username: `charles${stamp}`, displayname: "Charles Babbage" });
const D = await registerUser(info, { username: `dorothy${stamp}`, displayname: "Dorothy Vaughan" });
const E = await registerUser(info, { username: `emmy${stamp}`, displayname: "Emmy Noether" });

const config = (origin) => ({ ...defaultConfig(origin), calls: { enabled: true } });
const { server, origin } = await startServer({ port: 0, upstream: info.baseUrl, config, distDir: DIST });
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const problems = [];

async function newPage(vp = "1280", { permissions = ["microphone", "camera"], init } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], colorScheme: "light", permissions, reducedMotion: "reduce" });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|create|connect)/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return { ctx, page };
}

async function api(method, pathname, token, body) {
  const r = await fetch(`${info.baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${pathname} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}
let txn = 0;
const send = (token, roomId, type, content) => api("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/g${stamp}${++txn}`, token, content);
const putState = (token, roomId, type, key, content) => api("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(key)}`, token, content);
const roomIdOf = (page) => page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/room\//, "").split("/")[0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends `text` from the composer and waits until the server has it (so ordering is deterministic). */
async function say(page, text) {
  await page.locator("#composer").fill(text);
  await page.keyboard.press("Enter");
  const m = msg(page, text.split("\n")[0].replace(/[*`]/g, "").slice(0, 30)).last();
  await m.getByRole("img", { name: /^Sent$|^Seen by/ }).waitFor({ timeout: T });
}
async function dismissFirstRun(page) {
  await page.getByRole("heading", { name: /Set up secure backup|Verify this device/ }).waitFor({ timeout: T });
  await page.getByRole("button", { name: "Later" }).click();
}
async function openRoom(page, name) {
  const href = await page.locator(".room-item", { hasText: name }).first().getAttribute("href", { timeout: T });
  await page.evaluate((h) => (location.hash = h), href);
  await page.locator(".room-header .room-title", { hasText: name }).waitFor({ timeout: T });
}

// Crafted MatrixRTC events (as another client would send them): call history items and rings.
const CALL_MEMBER = "org.matrix.msc3401.call.member";
const RTC_NOTIFICATION = "org.matrix.msc4075.rtc.notification";
const RTC_DECLINE = "org.matrix.msc4310.rtc.decline";
const memberKey = (u, dev) => `_${u.user_id}_${dev}_m.call`;
function membership(roomId, dev, intent) {
  return {
    application: "m.call",
    call_id: "",
    device_id: dev,
    scope: "m.room",
    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
    foci_preferred: [{ type: "livekit", livekit_service_url: "https://rtc.chatdev.test/livekit/jwt", livekit_alias: roomId }],
    "m.call.intent": intent,
    expires: 4 * 3600_000,
  };
}
async function joinCall(u, roomId, dev, intent) {
  const r = await putState(u.access_token, roomId, CALL_MEMBER, memberKey(u, dev), membership(roomId, dev, intent));
  return r.event_id;
}
const leaveCall = (u, roomId, dev) => putState(u.access_token, roomId, CALL_MEMBER, memberKey(u, dev), {});
async function ring(u, roomId, memberEventId, to, intent, { live = false } = {}) {
  const r = await send(u.access_token, roomId, RTC_NOTIFICATION, {
    notification_type: "ring",
    "m.mentions": { user_ids: [to.user_id], room: false },
    "m.relates_to": { rel_type: "m.reference", event_id: memberEventId },
    sender_ts: live ? Date.now() : Date.now() - 600_000,
    lifetime: live ? 90_000 : 30_000,
    "m.call.intent": intent,
  });
  return r.event_id;
}
/** An encrypted event this device can never decrypt (unknown Megolm session). */
const undecryptable = (u, roomId) =>
  send(u.access_token, roomId, "m.room.encrypted", {
    algorithm: "m.megolm.v1.aes-sha2",
    ciphertext: "AwgAEoABZm9vYmFyYmF6cXV4IGdhbGxlcnkgdGVzdCBjaXBoZXJ0ZXh0IHRoYXQgY2FuJ3QgYmUgZGVjcnlwdGVk",
    device_id: "GALLERYDEV",
    sender_key: "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZWFsIGtleQ",
    session_id: "Z2FsbGVyeSBzZXNzaW9uIHRoYXQgZG9lcyBub3QgZXhpc3Q",
  });

const LONG =
  "I went through the whole note set again tonight, and I think the most interesting part isn't the arithmetic at all — it's that the engine could act on anything whose mutual relations can be expressed symbolically: music, for instance, if the science of harmony were expressed in those terms. That's the leap from calculator to general-purpose machine, and I'd like the write-up to make it obvious to someone reading it in a hundred years.";
const CODE = "Here's the loop from note G:\n```\nfor (let n = 1; n <= 7; n++) {\n  const b = bernoulli(n);\n  table.push({ n, b });\n}\n```";

let ada, grace, charles, adaKey, dmId, opsId, quarterlyId;

await section("login screen", async () => {
  const { ctx, page } = await newPage();
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Continue with your Lumen account" }).waitFor({ timeout: T });
  await shots(page, "login", ["360", "390", "768", "1280", "1920"]);
  await page.getByRole("button", { name: "Sign in to another Matrix server" }).click();
  await shots(page, "login-other", ["390", "1280"], ["light"]);
  await ctx.close();
});

await section("sign-in, secure backup set-up, first-run prompts", async () => {
  ada = await newPage();
  await passwordSignIn(ada.page, origin, A);
  await ada.page.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: T });
  adaKey = await setUpBackup(ada.page, async (step) => {
    if (step === "intro") await shots(ada.page, "backup-intro", ["390", "1280"]);
    if (step === "key") await shots(ada.page, "backup-key", ["390", "1280"]);
    if (step === "mismatch") await shot(ada.page, "backup-mismatch", "1280", "light");
  });
  await ada.page.getByRole("img", { name: "This device is verified" }).waitFor({ timeout: T });
  grace = await newPage();
  await passwordSignIn(grace.page, origin, B);
  await dismissFirstRun(grace.page);
  charles = await newPage();
  await passwordSignIn(charles.page, origin, C);
  await dismissFirstRun(charles.page);
  await grace.page.getByRole("button", { name: /Set up secure backup/ }).waitFor({ timeout: T });
  await shots(grace.page, "nudge", ["390", "1280"]);
});

await section("empty account", async () => {
  const e = await newPage();
  await passwordSignIn(e.page, origin, E);
  await dismissFirstRun(e.page);
  await e.page.getByText(/No conversations yet/).first().waitFor({ timeout: T });
  await shots(e.page, "empty-account", ["360", "390", "1024", "1280", "1920"]);
  await e.page.getByRole("button", { name: "Start a conversation" }).click();
  await shot(e.page, "menu-new", "1280", "light");
  await e.page.getByRole("menuitem", { name: "New group" }).click();
  await e.page.getByLabel("Group name").fill("Reading group");
  await shots(e.page, "new-group", ["390", "1280"]);
  await e.ctx.close();
});

await section("DM content: messages, code, links, image, file, reply, reactions, edit, deletion, UTD, calls", async () => {
  const a = ada.page;
  const g = grace.page;
  await a.getByRole("button", { name: "Start a conversation" }).click();
  await a.getByRole("menuitem", { name: "New direct message" }).click();
  await a.getByLabel("Find people").fill(B.user_id);
  await a.locator(".user-result").first().click();
  await shots(a, "new-dm", ["390", "1280"], ["light"]);
  await a.getByRole("button", { name: "Start conversation" }).click();
  await a.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor({ timeout: T });
  dmId = await roomIdOf(a);
  await say(a, "Morning Grace! Did you get a chance to look at the engine notes?");
  await g.locator(".invite-item", { hasText: "Ada Lovelace" }).getByRole("button", { name: "Accept" }).click({ timeout: T });
  await g.locator(".room-header .room-title", { hasText: "Ada Lovelace" }).waitFor({ timeout: T });
  await msg(g, "Morning Grace").waitFor({ timeout: T });
  await say(g, "Yes — just finished. A few thoughts 👇");
  await say(g, "Short version: it works.");
  await msg(a, "Short version").waitFor({ timeout: T });
  await say(a, LONG);
  await say(a, CODE);
  await msg(g, "Here's the loop").waitFor({ timeout: T });
  await say(g, "Nice. The spec is at https://spec.matrix.org/latest/ and the diagram is in `docs/engine.md`.");
  await msg(g, "I went through").waitFor({ timeout: T });
  await hoverAction(g, "I went through", "Reply");
  await say(g, "Agreed — that's the part people will remember.");
  await msg(a, "Agreed").waitFor({ timeout: T });
  await hoverAction(a, "Agreed", "React");
  await a.getByRole("button", { name: "React with ❤️" }).click();
  await hoverAction(g, "Short version", "React");
  await g.getByRole("button", { name: "React with 👍" }).click();
  await hoverAction(a, "Short version", "React");
  await a.getByRole("button", { name: "React with 👍" }).click();
  // image + file
  const gradient = makePng(960, 600, (x, y) => [Math.round(20 + (x / 960) * 60), Math.round(60 + (y / 600) * 120), Math.round(140 + (x / 960) * 100)]);
  await a.locator(".composer input[type=file]").setInputFiles({ name: "punch-card-scan.png", mimeType: "image/png", buffer: gradient });
  await g.locator(".att-image img").first().waitFor({ timeout: T });
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n% Lumen gallery test file\n"), Buffer.alloc(48_000, 32)]);
  await g.locator(".composer input[type=file]").setInputFiles({ name: "Analytical Engine — sketch of the notes (Menabrea, translated).pdf", mimeType: "application/pdf", buffer: pdf });
  await a.locator(".att-file").first().waitFor({ timeout: T });
  // edit + deletion
  await say(a, "Lets meet at 3");
  await hoverAction(a, "Lets meet at 3", "Edit");
  await a.locator("#composer").fill("Let's meet at 3 pm instead");
  await a.keyboard.press("Enter");
  await msg(g, "3 pm instead").locator(".edited").waitFor({ timeout: T });
  await say(a, "Wrong chat, sorry");
  await hoverAction(a, "Wrong chat, sorry", "Delete");
  await a.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await g.getByText("Message deleted").last().waitFor({ timeout: T });
  // an undecryptable message from Grace's other (registration) session
  await undecryptable(B, dmId);
  await a.locator(".msg-utd").first().waitFor({ timeout: T });
  // a run of call events: answered voice call, missed call, declined video call
  let m = await joinCall(B, dmId, "GRACEPHONE", "audio");
  await ring(B, dmId, m, A, "audio");
  await joinCall(A, dmId, "ADALAPTOP", "audio");
  await sleep(2500);
  await leaveCall(A, dmId, "ADALAPTOP");
  await leaveCall(B, dmId, "GRACEPHONE");
  m = await joinCall(B, dmId, "GRACEPHONE", "audio");
  await ring(B, dmId, m, A, "audio");
  await sleep(1200);
  await leaveCall(B, dmId, "GRACEPHONE");
  m = await joinCall(B, dmId, "GRACEPHONE", "video");
  const n = await ring(B, dmId, m, A, "video");
  await send(A.access_token, dmId, RTC_DECLINE, { "m.relates_to": { rel_type: "m.reference", event_id: n } });
  await leaveCall(B, dmId, "GRACEPHONE");
  await say(g, "Let's talk tomorrow then. Sending the notes tonight.");
  await msg(a, "Let's talk tomorrow").waitFor({ timeout: T });
});

await section("groups, unread counts, mention, invite, UTD preview", async () => {
  const c = charles.page;
  // A group with a very long name, lots of unread messages and a mention.
  await c.getByRole("button", { name: "Start a conversation" }).click();
  await c.getByRole("menuitem", { name: "New group" }).click();
  await c.getByLabel("Group name").fill("Quarterly planning — infrastructure, security review and budget working group");
  await c.getByLabel("Invite people").fill(A.user_id);
  await c.locator(".user-result").first().click();
  await c.getByRole("button", { name: "Create group" }).click();
  await c.locator(".room-header .room-title", { hasText: "Quarterly planning" }).waitFor({ timeout: T });
  quarterlyId = await roomIdOf(c);
  await api("POST", `/_matrix/client/v3/join/${encodeURIComponent(quarterlyId)}`, A.access_token, {});
  // Ops group with Ada and Grace; its last message can't be decrypted.
  await c.getByRole("button", { name: "Start a conversation" }).click();
  await c.getByRole("menuitem", { name: "New group" }).click();
  await c.getByLabel("Group name").fill("Ops & incident response");
  for (const u of [A, B]) {
    await c.getByLabel("Invite people").fill(u.user_id);
    await c.locator(".user-result").first().click();
  }
  await c.getByRole("button", { name: "Create group" }).click();
  await c.locator(".room-header .room-title", { hasText: "Ops & incident response" }).waitFor({ timeout: T });
  opsId = await roomIdOf(c);
  for (const u of [A, B]) await api("POST", `/_matrix/client/v3/join/${encodeURIComponent(opsId)}`, u.access_token, {});
  await c.locator(".member-row, .room-sub", { hasText: "3 members" }).first().waitFor({ timeout: T }).catch(() => undefined);
  await sleep(1500);
  await say(c, "Pager rotation for next week is up — please check your slots.");
  await say(c, "Deploy of 1.4.2 finished, all health checks green ✅");
  await undecryptable(C, opsId);
  // DM from Charles with three unread messages
  await c.getByRole("button", { name: "Start a conversation" }).click();
  await c.getByRole("menuitem", { name: "New direct message" }).click();
  await c.getByLabel("Find people").fill(A.user_id);
  await c.locator(".user-result").first().click();
  await c.getByRole("button", { name: "Start conversation" }).click();
  await c.locator(".room-header .room-title", { hasText: "Ada Lovelace" }).waitFor({ timeout: T });
  const cdm = await roomIdOf(c);
  await api("POST", `/_matrix/client/v3/join/${encodeURIComponent(cdm)}`, A.access_token, {});
  await sleep(1500);
  for (const t of ["Are you around later?", "I've got the gears for the difference engine.", "Call me when you can."]) await say(c, t);
  // the long-named group: 12 messages, one mentions Ada
  await openRoom(c, "Quarterly planning");
  for (let i = 1; i <= 11; i++) await say(c, `Budget line ${i}: reviewed and approved.`);
  await say(c, "Ada Lovelace, can you review the security budget before Friday?");
  // Dorothy invites Ada to a group (raw API, no content)
  await api("POST", "/_matrix/client/v3/createRoom", D.access_token, { name: "Design critique", preset: "private_chat", invite: [A.user_id] });
  await ada.page.locator(".invite-item", { hasText: "Design critique" }).waitFor({ timeout: T });
  await ada.page.locator(".room-item", { hasText: "Ops & incident response" }).locator(".room-preview", { hasText: /decrypt/i }).waitFor({ timeout: T }).catch(() => undefined);
});

await section("DM screens at every viewport", async () => {
  const a = ada.page;
  await a.evaluate((h) => (location.hash = h), `#/room/${encodeURIComponent(dmId)}`);
  await a.locator(".room-header .room-title", { hasText: "Grace Hopper" }).waitFor({ timeout: T });
  await msg(a, "Let's talk tomorrow").waitFor({ timeout: T });
  const toBottom = async () => {
    await a.locator(".timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await a.waitForTimeout(150);
  };
  await shots(a, "dm", ["360", "390", "768", "1024", "1280", "1920", "zoom200"], ["light", "dark"], toBottom);
  // the call run and the upper part of the conversation
  const scrollTo = (sel) => async () => {
    await a.locator(sel).first().scrollIntoViewIfNeeded();
    await a.locator(".timeline").evaluate((el, s) => {
      const t = el.querySelector(s);
      if (t) el.scrollTop = t.offsetTop - 40;
    }, sel);
  };
  await shots(a, "calls-run", ["390", "1280"], ["light", "dark"], scrollTo(".call-item"));
  await shots(a, "dm-top", ["390", "1280"], ["light", "dark"], async () => a.locator(".timeline").evaluate((el) => (el.scrollTop = 0)));
  await toBottom();
  // phone: the list view
  await a.evaluate(() => (location.hash = "#/"));
  await shots(a, "list", ["360", "390", "768"]);
  await shots(a, "utd-preview", ["1280"], ["light", "dark"]);
});

await section("group room, info panel, search", async () => {
  const a = ada.page;
  await openRoom(a, "Ops & incident response");
  await shots(a, "group", ["390", "1280"]);
  await a.locator(".room-header").getByRole("button", { name: "Conversation details" }).click();
  await a.locator(".member-row").first().waitFor({ timeout: T });
  await shots(a, "group-info", ["1280"], ["light"]);
  await a.getByRole("button", { name: "Close details" }).click();
  await openRoom(a, "Grace Hopper");
  await a.locator(".room-header").getByRole("button", { name: "Conversation details" }).click();
  await a.locator(".member-row").first().waitFor({ timeout: T });
  await shots(a, "info", ["390", "1024", "1280"]);
  await a.getByRole("button", { name: "Close details" }).click();
  await a.locator(".room-header").getByRole("button", { name: "Search messages" }).click();
  await a.getByRole("searchbox", { name: "Search messages" }).fill("meet");
  await a.locator(".search-hit").first().waitFor({ timeout: T });
  await shots(a, "search", ["390", "1280"]);
  await a.getByRole("button", { name: "Close search" }).click();
  if (await a.locator(".room-header").getByRole("button", { name: "Call history" }).count()) {
    await a.locator(".room-header").getByRole("button", { name: "Call history" }).click();
    await shots(a, "call-history", ["1280"]);
    await a.locator(".right-panel").getByRole("button", { name: /^Close/ }).first().click();
  }
});

await section("composer: multi-line, reply, upload in progress, upload error", async () => {
  const a = ada.page;
  await openRoom(a, "Grace Hopper");
  await hoverAction(a, "Short version", "Reply");
  await a.locator("#composer").fill("Line one of a longer reply,\nline two with more detail,\nand a third line to show the composer growing.");
  const cdp = await ada.ctx.newCDPSession(a);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 50, downloadThroughput: 200_000, uploadThroughput: 40_000 });
  const big = Buffer.alloc(3_000_000, 7);
  await a.locator(".composer input[type=file]").setInputFiles({ name: "difference-engine-blueprints.zip", mimeType: "application/zip", buffer: big });
  await a.locator(".upload .progress").waitFor({ timeout: T });
  await shots(a, "composer", ["390", "1280"]);
  await a.getByRole("button", { name: /Cancel upload of/ }).click();
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await a.getByRole("button", { name: "Cancel reply" }).click();
  await a.locator("#composer").fill("");
});

await section("settings: every tab", async () => {
  const a = ada.page;
  await a.getByRole("button", { name: "Settings" }).click();
  for (const [tab, label] of [
    ["profile", "Profile"],
    ["appearance", "Appearance"],
    ["notifications", "Notifications"],
    ["calls", "Calls"],
    ["security", "Security & privacy"],
    ["sessions", "Sessions"],
    ["about", "About"],
  ]) {
    await a.getByRole("tab", { name: label }).click();
    if (tab === "sessions") await a.locator(".device.current").waitFor({ timeout: T });
    if (tab === "security") await a.locator(".status-list").first().waitFor({ timeout: T }).catch(() => undefined);
    await shots(a, `settings-${tab}`, ["390", "1280", "zoom200"]);
  }
  await a.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  // notifications blocked by the browser
  const blocked = await newPage("1280", {
    init: () => {
      if (window.Notification) Object.defineProperty(window.Notification, "permission", { get: () => "denied" });
    },
  });
  await passwordSignIn(blocked.page, origin, E);
  await blocked.page.getByRole("button", { name: "Settings" }).click();
  await blocked.page.getByRole("tab", { name: "Notifications" }).click();
  await shots(blocked.page, "settings-notifications-blocked", ["1280"], ["light"]);
  await blocked.ctx.close();
});

await section("verification: emoji (SAS) with Grace, new device", async () => {
  const g = grace.page;
  const a = ada.page;
  await g.getByRole("button", { name: "Settings" }).click();
  await g.getByRole("tab", { name: "Security & privacy" }).click();
  await g.getByRole("dialog").getByRole("button", { name: "Set up secure backup", exact: true }).click();
  await setUpBackup(g);
  await g.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  await openRoom(a, "Grace Hopper");
  await a.locator(".room-header").getByRole("button", { name: /Not verified/ }).click();
  await a.getByText(/Waiting for .* to accept/).waitFor({ timeout: T });
  await shot(a, "verify-waiting", "1280", "light");
  await g.getByRole("button", { name: "Verify", exact: true }).click({ timeout: T });
  await g.getByRole("button", { name: "Compare emoji" }).click({ timeout: T });
  await a.locator(".sas-grid .sas-name").first().waitFor({ timeout: T });
  await shots(a, "verify-sas", ["360", "1280"]);
  await a.getByRole("button", { name: "They match" }).click();
  await g.getByRole("button", { name: "They match" }).click();
  await a.getByText(/is verified/).waitFor({ timeout: T });
  await shot(a, "verify-done", "1280", "light");
  await a.getByRole("button", { name: "Done" }).click();
  await g.getByRole("button", { name: "Done" }).click();
  await a.locator(".room-header .badge", { hasText: "Verified" }).waitFor({ timeout: T });
  await shots(a, "dm-verified", ["390", "1280"], ["light"]);
  // a new device of Ada's: "Verify this device"
  const ada2 = await newPage("390");
  await passwordSignIn(ada2.page, origin, A);
  await ada2.page.getByRole("heading", { name: "Verify this device" }).waitFor({ timeout: T });
  await shots(ada2.page, "verify-device", ["390", "1280"]);
  await ada2.page.getByRole("button", { name: /Use your recovery key/ }).click();
  await shot(ada2.page, "verify-recovery-key", "1280", "light");
  await ada2.page.getByLabel("Recovery key (or security phrase)").fill(adaKey);
  await ada2.page.getByRole("button", { name: "Verify", exact: true }).click();
  await ada2.page.getByText(/Restored \d+ of \d+ message keys?|This device is verified/).first().waitFor({ timeout: 60_000 });
  await shot(ada2.page, "verify-restored", "1280", "light");
  await ada2.ctx.close();
});

await section("calls on the dev homeserver: header, incoming card, lobby", async () => {
  const a = ada.page;
  await openRoom(a, "Grace Hopper");
  await shots(a, "header-call-buttons", ["360", "1280"], ["light"]);
  // Grace starts a call: "Join call" in the header and an incoming ring card
  const m = await joinCall(B, dmId, "GRACEPHONE2", "video");
  await a.locator(".room-header").getByRole("button", { name: /Join the call/ }).waitFor({ timeout: T });
  await ring(B, dmId, m, A, "video", { live: true });
  await a.locator(".incoming-call").waitFor({ timeout: T });
  await shots(a, "incoming", ["390", "1280"]);
  await a.locator(".incoming-call").getByRole("button", { name: "Decline" }).click();
  await shots(a, "join-call-header", ["390", "1280"], ["light"]);
  await leaveCall(B, dmId, "GRACEPHONE2");
  await a.locator(".room-header").getByRole("button", { name: "Video call" }).waitFor({ timeout: T });
  // lobby: video (fake camera) and voice
  await a.locator(".room-header").getByRole("button", { name: "Video call" }).click();
  const lobby = a.getByRole("dialog");
  await lobby.waitFor({ timeout: T });
  const allow = lobby.getByRole("button", { name: /^Allow/ });
  if (await allow.count()) {
    await shot(a, "lobby-first-call", "1280", "light");
    await allow.click();
  }
  await lobby.locator("video").waitFor({ timeout: T }).catch(() => undefined);
  await a.waitForTimeout(800);
  await shots(a, "lobby-video", ["390", "1280"]);
  await lobby.getByRole("button", { name: "Cancel" }).click();
  await a.locator(".room-header").getByRole("button", { name: "Voice call" }).click();
  await lobby.waitFor({ timeout: T });
  await a.waitForTimeout(800);
  await shots(a, "lobby-voice", ["390", "1280"]);
  await lobby.getByRole("button", { name: "Cancel" }).click();
});

await section("offline banner", async () => {
  const a = ada.page;
  await ada.ctx.setOffline(true);
  await a.getByText("You're offline.").waitFor({ timeout: T });
  await shots(a, "offline", ["390", "1280"]);
  await ada.ctx.setOffline(false);
  await a.getByText("You're offline.").waitFor({ state: "detached", timeout: T });
});

await section("call widget page (mobile apps)", async () => {
  const dist = WIDGET_DIST;
  if (!existsSync(path.join(dist, "index.html"))) throw new Error("no dist-widget: run npm run build:widget");
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/widget\/call\//, "/");
    let f = path.normalize(path.join(dist, p));
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/widget/call/`;
  const q = (theme) =>
    "?" +
    new URLSearchParams({ widgetId: "w1", roomId: "!room:chatdev.test", userId: "@ada:chatdev.test", deviceId: "PHONE", baseUrl: "https://matrix.chatdev.test", parentUrl: base.replace(/\/widget\/call\/$/, ""), theme, intent: "start_call", video: "true", notify: "ring" });
  // inside the app (a native host object exists): "Joining the call…" while the app connects it
  const w = await newPage("390", { init: () => (window.lumenNative = { postMessage: () => undefined }) });
  for (const theme of ["light", "dark"]) {
    await w.page.goto(base + q(theme));
    await w.page.getByText("Joining the call…").first().waitFor({ timeout: T });
    await shot(w.page, "widget-joining", "390", theme);
  }
  // opened outside the app: an error
  const w2 = await newPage("390");
  await w2.page.goto(base + q("dark"));
  await w2.page.getByText("Couldn't open the call").waitFor({ timeout: T });
  await shot(w2.page, "widget-error", "390", "dark");
  await w.ctx.close();
  await w2.ctx.close();
  srv.close();
});

// ---------------------------------------------------------------------------------------
// In-call screens against the deployed stack, with the page served from the local build
// ---------------------------------------------------------------------------------------
if (WITH_CALLS) {
  await section("in-call screens (deployed stack, local build)", async () => {
    process.env.LUMEN_NO_NETNS = "1";
    process.env.LUMEN_SERVER_IP ||= "127.0.0.1";
    const lab = await import("../calls/lib/lab.mjs");
    const ui = await import("../calls/lib/callui.mjs");
    const dist = DIST;
    const local = async (client) => {
      await client.context.route(/^https:\/\/app\.[^/]+\//, async (route) => {
        const url = new URL(route.request().url());
        const p = decodeURIComponent(url.pathname);
        if (p === "/config.json" || p.startsWith("/brand/") || p.startsWith("/_matrix/") || p.startsWith("/widget/")) return route.continue();
        const f = path.normalize(path.join(dist, p));
        if (f.startsWith(dist + path.sep) && existsSync(f) && statSync(f).isFile()) {
          const ext = path.extname(f);
          const type = { ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" }[ext] ?? "application/octet-stream";
          return route.fulfill({ status: 200, headers: { "content-type": type, "cache-control": "no-store" }, body: readFileSync(f) });
        }
        // the page itself: the deployed response headers (CSP etc.), the local HTML
        const real = await route.fetch();
        const headers = { ...real.headers() };
        delete headers["content-encoding"];
        delete headers["content-length"];
        delete headers["etag"];
        return route.fulfill({ status: 200, headers: { ...headers, "content-type": "text/html; charset=utf-8" }, body: readFileSync(path.join(dist, "index.html")) });
      });
    };
    const X = await lab.launchClient({ ns: "host", label: "gallery-ada", tone: 440 });
    const Y = await lab.launchClient({ ns: "host", label: "gallery-grace", tone: 660 });
    try {
      await local(X);
      await local(Y);
      await lab.signIn(X, "gallery-ada", "Ada Lovelace");
      await lab.signIn(Y, "gallery-grace", "Grace Hopper");
      const room = await lab.createDm(X, Y);
      await lab.openRoom(X, room);
      await lab.openRoom(Y, room);
      const cshot = (c, name, vp, theme) => shot(c.page, name, vp, theme);
      // voice call
      await ui.startFromHeader(X, "audio");
      await Y.page.locator(".incoming-call").waitFor({ timeout: T });
      await cshot(Y, "call-incoming-deployed", "1280", "light");
      await ui.acceptIncoming(Y, "audio");
      await ui.waitPhase(X, "connected");
      await ui.waitE2EE(X).catch(() => undefined);
      await X.page.waitForTimeout(1500);
      for (const [vp, theme] of [["1280", "dark"], ["1280", "light"], ["390", "dark"], ["360", "light"], ["768", "dark"]]) await cshot(X, "call-voice", vp, theme);
      await ui.openPanel(X, /Participants/);
      await cshot(X, "call-people", "1280", "dark");
      await ui.openPanel(X, "Call diagnostics");
      await cshot(X, "call-diagnostics", "1280", "light");
      await X.page.locator(".call-panel").getByRole("button", { name: "Close panel" }).click();
      // video: both turn their cameras on
      await X.page.getByRole("button", { name: "Turn camera on" }).click();
      await Y.page.getByRole("button", { name: "Turn camera on" }).click();
      await X.page.locator(".call-stage video").first().waitFor({ timeout: T });
      await X.page.waitForTimeout(2500);
      for (const [vp, theme] of [["1280", "light"], ["1920", "dark"], ["390", "dark"], ["1024", "light"]]) await cshot(X, "call-video", vp, theme);
      await X.page.getByRole("button", { name: /Minimise call/ }).click();
      await X.page.locator(".call-mini").waitFor({ timeout: T });
      await cshot(X, "call-mini", "1280", "light");
      await cshot(X, "call-mini", "390", "dark");
      await ui.leave(Y);
      await X.page.getByRole("button", { name: "Leave call" }).click().catch(() => undefined);
    } catch (e) {
      for (const c of [X, Y]) await c.page.screenshot({ path: path.join(RAW, `debug-calls-${c.label}.png`) }).catch(() => undefined);
      for (const c of [X, Y]) console.log(`${c.label}: ${c.page.url()}\n  ${[...c.problems, ...c.logs.slice(-8)].join("\n  ")}`);
      throw e;
    } finally {
      await ui.hangUpAll(X, Y).catch(() => undefined);
      await lab.signOutServer(X);
      await lab.signOutServer(Y);
      await X.browser.close();
      await Y.browser.close();
    }
  });
}

await browser.close();
server.close();

// ---------------------------------------------------------------------------------------
// Curated copy (each PNG under ~300 KB: large ones are palette-quantised with sharp)
// ---------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
let sharp = null;
try {
  sharp = createRequire(path.join(REPO, "apps/desktop/package.json"))("sharp");
} catch {
  /* no sharp: copy as is */
}
const copied = [];
for (const name of CURATED) {
  const src = path.join(RAW, `${name}.png`);
  if (!existsSync(src)) continue;
  const dst = path.join(OUT, `${name}.png`);
  if (sharp && statSync(src).size > 280_000) writeFileSync(dst, await sharp(src).png({ palette: true, quality: 92, effort: 8, compressionLevel: 9 }).toBuffer());
  else copyFileSync(src, dst);
  copied.push(name);
}
const missing = CURATED.filter((n) => !copied.includes(n));
console.log(`\n${readdirSync(RAW).length} screenshots in ${path.relative(REPO, RAW)}; ${copied.length} curated → ${path.relative(REPO, OUT)}`);
if (missing.length) console.log(`curated but not taken: ${missing.join(", ")}`);
if (problems.length) console.log(`page problems:\n  ${problems.slice(0, 20).join("\n  ")}`);
console.log(failures.length ? `FAILED sections: ${failures.join("; ")}` : "all sections passed");
process.exit(failures.length ? 1 : 0);
