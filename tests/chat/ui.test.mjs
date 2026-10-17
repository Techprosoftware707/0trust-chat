/**
 * Browser test of the production build, served with the production CSP.
 *
 * Two users sign in (through "Sign in to another Matrix server" + password,
 * against the disposable dev homeserver) in two browser contexts and exercise
 * the real app: secure-backup set-up, encrypted DM, formatting, replies,
 * reactions, edits, typing, read receipts, an encrypted image attachment,
 * emoji (SAS) verification, deletion and search. Screenshots (desktop + 390px
 * mobile, light + dark) go to tests/chat/screenshots/.
 *
 * Run: npm run test:ui   (from services/chat; needs `npm run devserver:up`)
 */
import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, rmSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { after, before, test } from "node:test";
import { importChatDep } from "./lib/deps.mjs";
import { startServer } from "./lib/serve.mjs";
import { devServerInfo, ensureReachable, registerUser } from "./lib/synapse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const pw = await importChatDep("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

const info = devServerInfo();
let server;
let origin;
let browser;
let A; // Ada (account)
let B; // Grace (account)
let ada; // { ctx, page, logs }
let grace;
let dmName;
let adaKey;
let ada2; // Ada's second device
let ada3; // Ada's third device
let C; // a third account, for deep links

const T = 30_000;

/** A small valid PNG (solid colour), built with zlib — just test data. */
function makePng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function signIn(user, { width = 1280, height = 800 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: "light" });
  // Count permission prompts: the app must only ask from the settings toggle, never on load.
  await ctx.addInitScript(() => {
    window.__permissionRequests = 0;
    if (window.Notification) {
      const orig = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = (...a) => {
        window.__permissionRequests++;
        return orig(...a);
      };
    }
  });
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
  return { ctx, page, logs };
}

async function setUpBackup(page) {
  await page.getByRole("button", { name: "Continue" }).click();
  const key = (await page.locator(".recovery-key").textContent()).trim();
  assert.match(key, /^([A-Za-z0-9]{4} ){11}[A-Za-z0-9]{4}$/, "recovery key is shown in groups");
  await page.getByLabel("I've saved my recovery key somewhere safe").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Recovery key").fill(key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"));
  await page.getByRole("button", { name: "Finish set-up" }).click();
  await page.getByText("That doesn't match the key shown").waitFor();
  await page.getByLabel("Recovery key").fill(key);
  await page.getByRole("button", { name: "Finish set-up" }).click();
  await page.getByText("Secure backup is set up").waitFor({ timeout: T });
  await page.getByRole("button", { name: "Done" }).click();
  return key;
}

const msg = (page, text) => page.locator("article.msg", { has: page.locator(".msg-body", { hasText: text }) });

async function hoverAction(page, text, action) {
  const m = msg(page, text).last();
  await m.hover();
  await m.getByRole("button", { name: action, exact: true }).click();
}

async function shot(page, name) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

before(async () => {
  await ensureReachable(info.baseUrl);
  A = await registerUser(info, { displayname: "Ada Lovelace" });
  B = await registerUser(info, { displayname: "Grace Hopper" });
  ({ server, origin } = await startServer({ port: 0, upstream: info.baseUrl }));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

test("login screen renders under the production CSP", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Continue with your Lumen account" }).waitFor();
  await shot(page, "desktop-light-login");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "mobile-dark-login");
  await ctx.close();
});

test("both users sign in; Ada sets up secure backup, Grace postpones", async () => {
  ada = await signIn(A);
  await ada.page.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: T });
  adaKey = await setUpBackup(ada.page);
  await ada.page.getByRole("img", { name: "This device is verified" }).waitFor({ timeout: T });

  grace = await signIn(B);
  await grace.page.getByRole("heading", { name: "Set up secure backup" }).waitFor({ timeout: T });
  await grace.page.getByRole("button", { name: "Later" }).click();
  await grace.page.getByRole("button", { name: /Set up secure backup/ }).waitFor();
});

test("Ada starts an encrypted DM; Grace accepts and both exchange messages", async () => {
  await ada.page.getByRole("button", { name: "Start a conversation" }).click();
  await ada.page.getByRole("menuitem", { name: "New direct message" }).click();
  await ada.page.getByLabel("Find people").fill(B.user_id);
  await ada.page.locator(".user-result").first().click();
  await ada.page.getByRole("button", { name: "Start conversation" }).click();
  await ada.page.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor({ timeout: T });
  await ada.page.locator("#composer").fill("Hello **Grace**, this is `end-to-end encrypted` — https://matrix.org");
  await ada.page.keyboard.press("Enter");
  await msg(ada.page, "Hello").waitFor();

  await grace.page.getByRole("button", { name: "Accept" }).first().click({ timeout: T });
  const first = msg(grace.page, "Hello");
  await first.waitFor({ timeout: T });
  assert.equal(await first.locator(".msg-body strong").textContent(), "Grace");
  assert.equal(await first.locator(".msg-body code").textContent(), "end-to-end encrypted");
  assert.equal(await first.locator(".msg-body a").getAttribute("href"), "https://matrix.org/");
  assert.equal(await first.locator(".msg-body a").getAttribute("rel"), "noopener noreferrer nofollow");
  await grace.page.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor();

  // Typing indicator (real m.typing via the server)
  await grace.page.locator("#composer").fill("Hi Ada");
  await ada.page.getByText("Grace Hopper is typing…").waitFor({ timeout: T });
  await grace.page.keyboard.press("Enter");
  await msg(ada.page, "Hi Ada").waitFor({ timeout: T });
  await ada.page.getByText("Grace Hopper is typing…").waitFor({ state: "detached", timeout: T });

  // Read receipt: Grace has read Ada's message -> Ada sees "Seen by Grace Hopper"
  await msg(ada.page, "Hello").getByRole("img", { name: /Seen by Grace Hopper/ }).waitFor({ timeout: T });
  dmName = "Grace Hopper";
});

test("reply, reaction and edit round-trip", async () => {
  await hoverAction(grace.page, "Hello", "Reply");
  await grace.page.getByText("Replying to Ada Lovelace").waitFor();
  await grace.page.locator("#composer").fill("This is a reply");
  await grace.page.keyboard.press("Enter");
  const reply = msg(ada.page, "This is a reply");
  await reply.waitFor({ timeout: T });
  await reply.locator(".reply-quote", { hasText: "Ada Lovelace" }).waitFor({ timeout: T });

  await hoverAction(ada.page, "This is a reply", "React");
  await ada.page.getByRole("button", { name: "React with 👍" }).click();
  await msg(grace.page, "This is a reply").getByRole("button", { name: /👍 1/ }).waitFor({ timeout: T });

  await hoverAction(ada.page, "Hello", "Edit");
  await ada.page.getByText("Editing message").waitFor();
  await ada.page.locator("#composer").fill("Hello **Grace** (now edited)");
  await ada.page.keyboard.press("Enter");
  const edited = msg(grace.page, "(now edited)");
  await edited.waitFor({ timeout: T });
  await edited.locator(".edited").waitFor();
});

test("encrypted image attachment is decrypted and shown inline by the receiver", async () => {
  const png = makePng(64, 40, [34, 180, 214]);
  await ada.page.locator(".composer input[type=file]").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  const img = grace.page.locator(".att-image img");
  await img.waitFor({ timeout: T });
  assert.match(await img.getAttribute("src"), /^blob:/, "image is shown from a local blob URL (decrypted in the browser)");
  const size = await img.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
  assert.deepEqual(size, [64, 40]);
  await grace.page.locator(".att-meta", { hasText: "encrypted" }).first().waitFor();
});

test("Grace sets up backup from Settings, then they verify each other with emoji", async () => {
  await grace.page.getByRole("button", { name: "Settings" }).click();
  await grace.page.getByRole("tab", { name: "Security & privacy" }).click();
  await grace.page.getByRole("dialog").getByRole("button", { name: "Set up secure backup", exact: true }).click();
  await setUpBackup(grace.page);
  await shot(grace.page, "desktop-light-settings-security");
  await grace.page.getByRole("button", { name: "Close" }).first().click();

  // Ada starts verification from the DM header.
  await ada.page.locator(".room-header").getByRole("button", { name: /Not verified/ }).click();
  await ada.page.getByText(/Waiting for .* to accept/).waitFor({ timeout: T });
  await grace.page.getByRole("button", { name: "Verify", exact: true }).click({ timeout: T });
  await grace.page.getByRole("button", { name: "Compare emoji" }).click({ timeout: T });
  const sasGrace = grace.page.locator(".sas-grid .sas-name");
  const sasAda = ada.page.locator(".sas-grid .sas-name");
  await sasGrace.first().waitFor({ timeout: T });
  await sasAda.first().waitFor({ timeout: T });
  const namesGrace = await sasGrace.allTextContents();
  const namesAda = await sasAda.allTextContents();
  assert.equal(namesGrace.length, 7);
  assert.deepEqual(namesAda, namesGrace, "both sides show the same 7 emoji");
  await shot(ada.page, "desktop-light-verification");
  await ada.page.getByRole("button", { name: "They match" }).click();
  await grace.page.getByRole("button", { name: "They match" }).click();
  await ada.page.getByText(/is verified/).waitFor({ timeout: T });
  await grace.page.getByText(/is verified/).waitFor({ timeout: T });
  await ada.page.getByRole("button", { name: "Done" }).click();
  await grace.page.getByRole("button", { name: "Done" }).click();
  await ada.page.locator(".room-header .badge", { hasText: "Verified" }).waitFor({ timeout: T });
  // Messages from the verified user now carry the green shield from getEncryptionInfoForEvent.
  await grace.page.locator("#composer").fill("Now we're verified");
  await grace.page.keyboard.press("Enter");
  await msg(ada.page, "Now we're verified").getByRole("img", { name: "Encrypted, verified sender" }).waitFor({ timeout: T });
});

test("deleting a message removes it for the other side", async () => {
  await ada.page.locator("#composer").fill("Oops, wrong chat");
  await ada.page.keyboard.press("Enter");
  await msg(grace.page, "Oops, wrong chat").waitFor({ timeout: T });
  await hoverAction(ada.page, "Oops, wrong chat", "Delete");
  await ada.page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await msg(grace.page, "Oops, wrong chat").waitFor({ state: "detached", timeout: T });
  await grace.page.getByText("Message deleted").last().waitFor();
});

test("on-device search finds decrypted messages", async () => {
  await ada.page.locator(".room-header").getByRole("button", { name: "Search messages" }).click();
  await ada.page.getByRole("searchbox", { name: "Search messages" }).fill("reply");
  await ada.page.locator(".search-hit", { hasText: "This is a reply" }).waitFor({ timeout: T });
  await ada.page.getByText("Search runs on this device").waitFor();
  await ada.page.getByRole("button", { name: "Close search" }).click();
});

test("screenshots: desktop and 390px mobile, light and dark", async () => {
  const p = ada.page;
  await shot(p, "desktop-light-room");
  await p.emulateMedia({ colorScheme: "dark" });
  await shot(p, "desktop-dark-room");
  await p.locator(".room-header").getByRole("button", { name: "Conversation details" }).click();
  await p.locator(".member-row").first().waitFor();
  await shot(p, "desktop-dark-details");
  await p.getByRole("button", { name: "Close details" }).click();
  await p.emulateMedia({ colorScheme: "light" });
  await p.setViewportSize({ width: 390, height: 844 });
  await shot(p, "mobile-light-room");
  await p.getByRole("link", { name: "Back to conversations" }).click();
  await p.locator(".room-item").first().waitFor();
  await shot(p, "mobile-light-list");
  await p.emulateMedia({ colorScheme: "dark" });
  await shot(p, "mobile-dark-list");
  await p.locator(".room-item", { hasText: dmName }).click();
  await p.locator("#composer").waitFor();
  await shot(p, "mobile-dark-room");
  await p.getByRole("button", { name: "Settings" }).waitFor({ state: "detached" }).catch(() => undefined);
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.emulateMedia({ colorScheme: "light" });
});

async function api(method, pathname, token, body) {
  const r = await fetch(`${info.baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${pathname} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function openSettings(page, tab) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: tab }).click();
}

const closeDialog = (page) => page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).first().click();

test("profile: display name and avatar upload", async () => {
  const p = ada.page;
  await openSettings(p, "Profile");
  await p.getByLabel("Display name").fill("Ada King");
  await p.getByRole("button", { name: "Save" }).click();
  await p.getByText("Display name saved.").waitFor({ timeout: T });
  await p.locator(".user-chip-name", { hasText: "Ada King" }).waitFor({ timeout: T });
  await p.locator("input[type=file][accept^='image/']").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: makePng(96, 96, [134, 118, 244]) });
  await p.getByText("Profile picture updated.").waitFor({ timeout: T });
  await p.locator(".user-chip .avatar img[src^='blob:']").waitFor({ timeout: T });
  await msg(grace.page, "Now we're verified").waitFor();
  await grace.page.getByText("Ada Lovelace changed their name to Ada King").waitFor({ timeout: T });
  await p.getByLabel("Display name").fill("Ada Lovelace");
  await p.getByRole("button", { name: "Save" }).click();
  await p.locator(".user-chip-name", { hasText: "Ada Lovelace" }).waitFor({ timeout: T });
  await grace.page.getByText("Ada King changed their name to Ada Lovelace").waitFor({ timeout: T });
  await closeDialog(p);
});

let lobbyId;
test("groups: encrypted by default; an unencrypted group is labelled honestly; history pagination; upload limit", async () => {
  const p = ada.page;
  // Encrypted group with Grace.
  await p.getByRole("button", { name: "Start a conversation" }).click();
  await p.getByRole("menuitem", { name: "New group" }).click();
  await p.getByLabel("Group name").fill("Project Lumen");
  await p.getByLabel("Invite people").fill(B.user_id);
  await p.locator(".user-result").first().click();
  assert.equal(await p.getByLabel(/End-to-end encryption/).isChecked(), true, "encryption is on by default");
  await p.getByRole("button", { name: "Create group" }).click();
  await p.locator(".room-header .room-title", { hasText: "Project Lumen" }).waitFor({ timeout: T });
  await p.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor({ timeout: T });
  const invite = grace.page.locator(".invite-item", { hasText: "Project Lumen" });
  await invite.waitFor({ timeout: T });
  await invite.getByRole("button", { name: "Accept" }).click();
  await grace.page.locator(".room-header .room-title", { hasText: "Project Lumen" }).waitFor({ timeout: T });
  await grace.page.locator("#composer").fill("Group hello");
  await grace.page.keyboard.press("Enter");
  await msg(p, "Group hello").waitFor({ timeout: T });

  // This homeserver encrypts every new room (encryption_enabled_by_default_for_room_type: all,
  // advertised as io.element.e2ee_forced.*): the dialog says so instead of offering a choice it can't honour.
  await p.getByRole("button", { name: "Start a conversation" }).click();
  await p.getByRole("menuitem", { name: "New group" }).click();
  await p.getByLabel("Group name").fill("Open lobby");
  await p.getByText("Your server encrypts all new conversations.").waitFor({ timeout: T });
  assert.equal(await p.getByLabel(/End-to-end encryption/).isDisabled(), true);
  await p.getByRole("button", { name: "Create group" }).click();
  await p.locator(".room-header .room-title", { hasText: "Open lobby" }).waitFor({ timeout: T });
  await p.locator(".room-header .badge", { hasText: "Encrypted" }).waitFor({ timeout: T });
  lobbyId = decodeURIComponent((await p.evaluate(() => location.hash)).replace("#/room/", ""));

  // The upload size limit comes from /_matrix/client/v1/media/config and is enforced before uploading.
  const limit = (await api("GET", "/_matrix/client/v1/media/config", A.access_token))["m.upload.size"];
  const huge = path.join(HERE, "output", "huge.bin");
  mkdirSync(path.dirname(huge), { recursive: true });
  closeSync(openSync(huge, "w"));
  truncateSync(huge, limit + 1024 * 1024); // sparse file just over the limit
  await p.locator(".composer input[type=file]").setInputFiles(huge);
  rmSync(huge, { force: true });
  await p.locator(".upload-error", { hasText: "but the server accepts files up to" }).waitFor({ timeout: T });
  await p.getByRole("button", { name: "Dismiss huge.bin" }).click();

  // Seed history from Ada's other (registration) session, then page back through it.
  for (let i = 1; i <= 70; i++) {
    await api("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(lobbyId)}/send/m.room.message/seed${i}`, A.access_token, {
      msgtype: "m.text",
      body: `seed message ${String(i).padStart(3, "0")}`,
    });
  }
  await msg(p, "seed message 070").waitFor({ timeout: T });
  // These were sent in plaintext through the raw API into an encrypted room: each one is flagged.
  const plain = msg(p, "seed message 070").locator(".shield-red[aria-label='Not encrypted']");
  await plain.waitFor();
  await shot(p, "desktop-light-plaintext-in-encrypted-room");
  const timeline = p.locator(".timeline");
  for (let i = 0; i < 20 && !(await msg(p, "seed message 001").count()); i++) {
    await timeline.evaluate((el) => (el.scrollTop = 0));
    await p.waitForTimeout(400);
  }
  await msg(p, "seed message 001").waitFor({ timeout: T });
  await p.getByText("This is the beginning of the conversation.").waitFor({ timeout: T });
});

test("deep links: existing DM opens directly; a new contact needs confirmation; reload restores the session", async () => {
  const p = ada.page;
  C = await registerUser(info, { displayname: "Charles Babbage" });
  await p.evaluate((h) => (location.hash = h), `#/dm/${encodeURIComponent(B.user_id)}`);
  await p.locator(".room-header .room-title", { hasText: "Grace Hopper" }).waitFor({ timeout: T });
  await p.evaluate((h) => (location.hash = h), `#/dm/${encodeURIComponent(C.user_id)}`);
  const dlg = p.getByRole("dialog");
  await dlg.getByText(`Start an end-to-end encrypted conversation with ${C.user_id}?`).waitFor({ timeout: T });
  await dlg.getByRole("button", { name: "Start conversation" }).click();
  await p.locator(".room-header .room-title", { hasText: "Charles Babbage" }).waitFor({ timeout: T });

  // Reload: the session (sealed token + crypto store password) is restored from this browser.
  await p.evaluate((h) => (location.hash = h), `#/dm/${encodeURIComponent(B.user_id)}`);
  await p.locator(".room-header .room-title", { hasText: "Grace Hopper" }).waitFor({ timeout: T });
  await p.reload();
  await msg(p, "Now we're verified").waitFor({ timeout: 60_000 });
  const stored = await p.evaluate(() => localStorage.getItem("lumen-session"));
  assert.ok(stored && !stored.includes("syt_"), "no access token in localStorage");
});

test("notifications: only requested from settings, follow push rules, previews off by default", async () => {
  const p = ada.page;
  assert.equal(await p.evaluate(() => window.__permissionRequests), 0, "notification permission is never requested on load");
  assert.notEqual(await p.evaluate(() => Notification.permission), "granted");
  // Record notifications and pretend the tab is in the background.
  await p.evaluate(() => {
    window.__notes = [];
    class FakeNotification {
      static permission = "default";
      static async requestPermission() {
        FakeNotification.permission = "granted";
        return "granted";
      }
      constructor(title, opts) {
        window.__notes.push({ title, body: opts?.body });
      }
      close() {}
    }
    window.Notification = FakeNotification;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  });
  const dmNotes = () => p.evaluate(() => window.__notes.filter((n) => n.title === "Grace Hopper"));
  try {
    await openSettings(p, "Notifications");
    const toggle = p.getByRole("switch", { name: "Desktop notifications" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await p.getByRole("switch", { name: "Show message previews" }).getAttribute("aria-checked"), "false");
    await toggle.click();
    await p.waitForFunction(() => document.querySelector("[role=switch]")?.getAttribute("aria-checked") === "true");
    await closeDialog(p);
    await grace.page.locator(".room-item", { hasText: "Ada Lovelace" }).click();
    await grace.page.locator(".room-header .room-title", { hasText: "Ada Lovelace" }).waitFor();
    await grace.page.locator("#composer").fill("Ping for notification");
    await grace.page.keyboard.press("Enter");
    await p.waitForFunction(() => window.__notes.some((n) => n.title === "Grace Hopper"), null, { timeout: T });
    const [n1] = await dmNotes();
    assert.equal(n1.body, "New encrypted message", `no message text without previews: ${JSON.stringify(await p.evaluate(() => window.__notes))}`);
    await openSettings(p, "Notifications");
    await p.getByRole("switch", { name: "Show message previews" }).click();
    await closeDialog(p);
    await grace.page.locator("#composer").fill("Second ping");
    await grace.page.keyboard.press("Enter");
    await p.waitForFunction(() => window.__notes.filter((n) => n.title === "Grace Hopper").length >= 2, null, { timeout: T });
    const notes = await dmNotes();
    assert.equal(notes[1].body, "Second ping");
  } finally {
    await p.evaluate(() => {
      delete document.hidden;
    });
  }
});

test("offline: banner, failed send with retry after reconnecting", async () => {
  const p = ada.page;
  await ada.ctx.setOffline(true);
  await p.getByText("You're offline.").waitFor({ timeout: T });
  await shot(p, "desktop-light-offline");
  await p.locator("#composer").fill("Sent while offline");
  await p.keyboard.press("Enter");
  const m = msg(p, "Sent while offline");
  await m.getByText("Not sent.").waitFor({ timeout: 60_000 }).catch(async (e) => {
    await shot(p, "debug-offline");
    throw e;
  });
  await ada.ctx.setOffline(false);
  await p.getByText("You're offline.").waitFor({ state: "detached", timeout: T });
  await m.getByRole("button", { name: "Retry" }).click();
  await msg(grace.page, "Sent while offline").waitFor({ timeout: T });
  await m.getByText("Not sent.").waitFor({ state: "detached" });
  // Caught up (the latest event is ours): a real read receipt clears the server's unread count.
  await p.locator(".room-item", { hasText: "Grace Hopper" }).locator(".unread-badge").waitFor({ state: "detached", timeout: T });
});

test("new device: history is unreadable until verified with the recovery key, then restored from backup", async () => {
  // Wait until Ada's first device has uploaded its room keys to the backup.
  await waitForBackup(A.access_token, 2);
  ada2 = await signIn(A);
  const p = ada2.page;
  await p.getByRole("heading", { name: "Verify this device" }).waitFor({ timeout: T });
  await p.getByRole("button", { name: "Later" }).click();
  await p.locator(".room-item", { hasText: "Grace Hopper" }).click();
  // calm wording: the key isn't on this device; verifying it restores the history from the backup
  await p.locator(".msg-utd").first().waitFor({ timeout: T });
  await shot(p, "desktop-light-new-device-utd");
  await p.getByRole("button", { name: /Verify this device/ }).first().click();
  await p.getByRole("button", { name: /Use your recovery key/ }).click();
  await p.getByLabel("Recovery key (or security phrase)").fill(adaKey);
  await p.getByRole("button", { name: "Verify", exact: true }).click();
  await p.getByText(/Restored \d+ of \d+ message keys? from your backup/).waitFor({ timeout: 60_000 });
  await p.getByRole("button", { name: "Done" }).click();
  await msg(p, "(now edited)").waitFor({ timeout: T });
  await p.getByRole("img", { name: "This device is verified" }).waitFor({ timeout: T });
});

async function waitForBackup(token, minKeys) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const v = await api("GET", "/_matrix/client/v3/room_keys/version", token);
    if (v.count >= minKeys) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("room keys were not backed up");
}

test("self-verification: a new device is verified by an existing one with emoji", async () => {
  ada3 = await signIn(A);
  const p3 = ada3.page;
  await p3.getByRole("heading", { name: "Verify this device" }).waitFor({ timeout: T });
  await p3.getByRole("button", { name: /Use another device/ }).click();
  await p3.getByText(/Waiting for your other device to accept/).waitFor({ timeout: T });
  const toast = ada.page.locator(".toast", { hasText: "Verify this device?" });
  await toast.waitFor({ timeout: T });
  await toast.getByRole("button", { name: "Verify" }).click();
  await p3.getByRole("button", { name: "Compare emoji" }).click({ timeout: T });
  const e3 = p3.locator(".sas-grid .sas-name");
  const e1 = ada.page.locator(".sas-grid .sas-name");
  await e3.first().waitFor({ timeout: T });
  await e1.first().waitFor({ timeout: T });
  assert.deepEqual(await e1.allTextContents(), await e3.allTextContents());
  await p3.getByRole("button", { name: "They match" }).click();
  await ada.page.getByRole("button", { name: "They match" }).click();
  await p3.getByText("This device is verified.").waitFor({ timeout: T });
  await p3.getByRole("button", { name: "Done" }).click();
  await ada.page.getByRole("button", { name: "Done" }).click();
  await p3.getByRole("img", { name: "This device is verified" }).waitFor({ timeout: T });
});

test("sessions: rename, and sign out other devices with password confirmation", async () => {
  const p = ada.page;
  const id2 = await ada2.page.evaluate(() => JSON.parse(localStorage.getItem("lumen-session")).deviceId);
  const id3 = await ada3.page.evaluate(() => JSON.parse(localStorage.getItem("lumen-session")).deviceId);
  await openSettings(p, "Sessions");
  const current = p.locator(".device.current");
  await current.waitFor({ timeout: T });
  await current.getByRole("button", { name: /^Rename/ }).click();
  await p.getByLabel("Session name").fill("Ada's laptop");
  await p.getByRole("button", { name: "Save name" }).click();
  await p.locator(".device.current", { hasText: "Ada's laptop" }).waitFor({ timeout: T });
  for (const id of [id2, id3]) {
    const row = p.locator(".device", { hasText: id });
    await row.locator(".device-trust", { hasText: "Verified" }).waitFor({ timeout: T });
    await row.locator("input[type=checkbox]").check();
  }
  await p.getByRole("button", { name: /Sign out 2 selected/ }).click();
  const uia = p.getByRole("dialog", { name: "Confirm it's you" });
  await uia.getByLabel("Password").fill("definitely-wrong");
  await uia.getByRole("button", { name: "Confirm" }).click();
  await p.getByRole("dialog", { name: "Confirm it's you" }).getByText("That password is incorrect.").waitFor({ timeout: T });
  await p.getByRole("dialog", { name: "Confirm it's you" }).getByLabel("Password").fill(A.password);
  await p.getByRole("dialog", { name: "Confirm it's you" }).getByRole("button", { name: "Confirm" }).click();
  await p.locator(".device", { hasText: id2 }).waitFor({ state: "detached", timeout: T });
  await p.locator(".device", { hasText: id3 }).waitFor({ state: "detached", timeout: T });
  await closeDialog(p);
  await ada2.page.getByText("this session was ended on the server").waitFor({ timeout: 60_000 });
  await ada3.page.getByText("this session was ended on the server").waitFor({ timeout: 60_000 });
});

async function resetIdentity(g, password) {
  await openSettings(g, "Security & privacy");
  await g.getByRole("button", { name: "Reset encryption…" }).click();
  await g.getByLabel(/Type RESET to confirm/).fill("RESET");
  await g.getByRole("button", { name: "Continue to reset" }).click();
  const key = (await g.locator(".recovery-key").textContent()).trim();
  await g.getByLabel("I've saved my recovery key somewhere safe").check();
  await g.getByRole("button", { name: "Continue" }).click();
  await g.getByLabel("Recovery key").fill(key);
  await g.getByRole("button", { name: "Reset encryption", exact: true }).click();
  // Replacing cross-signing keys requires confirming with the account password (UIA).
  const uia = g.getByRole("dialog", { name: "Confirm it's you" });
  await uia.getByLabel("Password").fill(password, { timeout: T });
  await uia.getByRole("button", { name: "Confirm" }).click();
  await g.getByText("Your encryption has been reset").waitFor({ timeout: 60_000 });
  await g.getByRole("button", { name: "Done" }).click();
  await closeDialog(g);
}

test("identity reset: a verified contact's new identity triggers a warning", async () => {
  await resetIdentity(grace.page, B.password);
  const p = ada.page;
  await p.locator(".room-item", { hasText: "Grace Hopper" }).click();
  const banner = p.locator(".identity-banner");
  await banner.getByText("verified identity has changed").waitFor({ timeout: 60_000 });
  await p.locator(".room-header .badge", { hasText: "Identity changed" }).waitFor({ timeout: T });
  await shot(p, "desktop-light-identity-warning");
  await banner.getByRole("button", { name: "Withdraw verification" }).click();
  await banner.waitFor({ state: "detached", timeout: T });
  await p.locator(".room-header .badge", { hasText: "Not verified" }).waitFor({ timeout: T });
});

test("identity change of an unverified contact: 'I understand' pins the new identity", async () => {
  await resetIdentity(grace.page, B.password);
  const p = ada.page;
  const banner = p.locator(".identity-banner");
  await banner.getByText("identity appears to have changed").waitFor({ timeout: 60_000 });
  await banner.getByRole("button", { name: "I understand" }).click();
  await banner.waitFor({ state: "detached", timeout: T });
});

test("appearance: theme switch is stored like the website's", async () => {
  const p = ada.page;
  await openSettings(p, "Appearance");
  await p.locator(".theme-option", { hasText: "Dark" }).click();
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await p.evaluate(() => localStorage.getItem("lumen-theme")), "dark");
  await p.setViewportSize({ width: 390, height: 844 });
  await shot(p, "mobile-dark-settings");
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.locator(".theme-option", { hasText: "Match system" }).click();
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  assert.equal(await p.evaluate(() => localStorage.getItem("lumen-theme")), null);
  await closeDialog(p);
});

test("blocking: Ada blocks Grace; Grace's messages don't reach Ada while blocked; unblocking restores delivery", async () => {
  const a = ada.page;
  const g = grace.page;
  await a.locator(".room-item", { hasText: "Grace Hopper" }).click();
  await g.locator(".room-item", { hasText: "Ada Lovelace" }).click();
  await a.locator(".room-header").getByRole("button", { name: "Conversation details" }).click();
  await a.getByRole("button", { name: "Block Grace Hopper" }).click({ timeout: T });
  const confirm = a.getByRole("dialog", { name: "Block Grace Hopper?" });
  await confirm.getByText("They aren't told").waitFor();
  await confirm.getByRole("button", { name: "Block", exact: true }).click();
  await a.locator(".member-row", { hasText: "Grace Hopper" }).locator(".badge", { hasText: "Blocked" }).waitFor({ timeout: T });
  await shot(a, "desktop-light-blocked-member");
  await a.getByRole("button", { name: "Close details" }).click();

  // Grace's message is accepted by the server (her client shows it sent), but Ada's server no longer delivers it.
  await g.locator("#composer").fill("Sent while blocked");
  await g.keyboard.press("Enter");
  await msg(g, "Sent while blocked").getByRole("img", { name: /^Sent$|^Seen by/ }).waitFor({ timeout: T });
  // Ada then sends a message of her own. Its server echo ("Sent") arrives through Ada's sync,
  // which therefore has passed Grace's earlier message: absent now means not delivered.
  await a.locator("#composer").fill("Ada after the blocked message");
  await a.keyboard.press("Enter");
  await msg(a, "Ada after the blocked message").getByRole("img", { name: /^Sent$|^Seen by/ }).waitFor({ timeout: T });
  await msg(g, "Ada after the blocked message").waitFor({ timeout: T });
  assert.equal(await msg(a, "Sent while blocked").count(), 0, "a message sent while blocked must not be delivered");

  await openSettings(a, "Security & privacy");
  const row = a.locator(".blocked-row", { hasText: B.user_id });
  await row.waitFor({ timeout: T });
  await row.getByRole("button", { name: "Unblock" }).click();
  await a.getByText("You haven't blocked anyone.").waitFor({ timeout: T });
  await closeDialog(a);

  await g.locator("#composer").fill("Sent after unblock");
  await g.keyboard.press("Enter");
  await msg(a, "Sent after unblock").waitFor({ timeout: T });
  // Not asserted: after unblocking, loading history can bring back what Grace sent meanwhile
  // (the server stops filtering it); Settings says so.
});

test("sign out wipes local data", async () => {
  const g = grace.page;
  await g.locator(".user-chip").getByRole("button", { name: "Sign out" }).click();
  await g.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await g.getByText("You've signed out.").waitFor({ timeout: T });
  const dbs = await g.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  assert.deepEqual(dbs.filter((n) => /lumen|matrix/.test(n ?? "")), []);
  assert.equal(await g.evaluate(() => localStorage.getItem("lumen-session")), null);
});

test("no CSP violations or uncaught errors in any browser", async () => {
  const all = [ada, grace, ada2, ada3].filter(Boolean).flatMap((x) => x.logs);
  const csp = all.filter((l) => /Content Security Policy/i.test(l.text));
  assert.deepEqual(csp, [], "no CSP violations");
  const crashes = all.filter((l) => l.type === "pageerror");
  assert.deepEqual(crashes, [], "no uncaught page errors");
});
