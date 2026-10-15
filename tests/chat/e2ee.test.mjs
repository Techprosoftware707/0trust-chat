/**
 * End-to-end encryption integration test (Node, real homeserver).
 *
 * Uses matrix-js-sdk with its Rust crypto (vodozemac via matrix-sdk-crypto-wasm)
 * exactly as the web client does, against the disposable dev homeserver
 * (`npm run devserver:up` in services/chat). It:
 *   1. registers two users (plus an admin for the admin API),
 *   2. creates an encrypted DM and exchanges messages both ways,
 *   3. checks each side decrypts them,
 *   4. proves the server never saw plaintext: raw /messages (as a member) and the
 *      Synapse admin API only contain m.room.encrypted events and never the marker,
 *   5. sends an encrypted attachment (AES-CTR per spec, matrix-encrypt-attachment),
 *      checks the bytes stored on the server don't contain the marker, and that the
 *      receiver can download (authenticated media) and decrypt them.
 *
 * Run: npm run test:e2ee   (from services/chat)
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { importChatDep } from "./lib/deps.mjs";
import { devServerInfo, ensureReachable, registerUser } from "./lib/synapse.mjs";

const sdk = await importChatDep("matrix-js-sdk");
const loglevel = (await importChatDep("loglevel")).default;
const { logger: sdkLogger } = await importChatDep("matrix-js-sdk/lib/logger.js");

// Keep the SDK (and Rust crypto) quiet: only real failures should show up in test output.
const silent = () => () => undefined;
loglevel.methodFactory = silent;
for (const l of [sdkLogger, ...Object.values(loglevel.getLoggers())]) {
  l.methodFactory = silent;
  l.rebuild?.();
}
const attachments = await importChatDep("matrix-encrypt-attachment");
const { encryptAttachment, decryptAttachment } = attachments.default ?? attachments;

const MARK = `PLAINTEXT-MARKER-${randomBytes(6).toString("hex")}`;
const info = devServerInfo();
const base = info.baseUrl;

const quietLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quietLogger;
  },
};

async function waitFor(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

async function startClient(user) {
  const client = sdk.createClient({
    baseUrl: base,
    accessToken: user.access_token,
    userId: user.user_id,
    deviceId: user.device_id,
    logger: quietLogger,
  });
  await client.initRustCrypto({ useIndexedDB: false });
  const ready = new Promise((resolve) => {
    client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === sdk.SyncState.Prepared || state === sdk.SyncState.Syncing) resolve();
    });
  });
  await client.startClient({ initialSyncLimit: 30 });
  await ready;
  return client;
}

async function rawJson(path, token) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  assert.equal(r.status, 200, `${path} -> ${r.status} ${text.slice(0, 200)}`);
  return { text, json: JSON.parse(text) };
}

/** Finds a decrypted m.room.message in `client`'s view of the room with the given body. */
function findDecrypted(client, roomId, body) {
  const room = client.getRoom(roomId);
  if (!room) return null;
  return room.getLiveTimeline().getEvents().find((e) => e.getType() === "m.room.message" && e.getContent()?.body === body) ?? null;
}

let alice;
let bob;
let admin;
let aliceClient;
let bobClient;
let roomId;
const sentBodies = [];

before(async () => {
  await ensureReachable(base);
  admin = await registerUser(info, { admin: true });
  alice = await registerUser(info, { displayname: "Alice E2EE" });
  bob = await registerUser(info, { displayname: "Bob E2EE" });
  aliceClient = await startClient(alice);
  bobClient = await startClient(bob);
});

after(() => {
  aliceClient?.stopClient();
  bobClient?.stopClient();
});

test("creates an encrypted DM and both users join", async () => {
  const res = await aliceClient.createRoom({
    is_direct: true,
    invite: [bob.user_id],
    preset: sdk.Preset.TrustedPrivateChat,
    initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
  });
  roomId = res.room_id;
  await waitFor("bob's invite", () => bobClient.getRoom(roomId)?.getMyMembership() === "invite");
  await bobClient.joinRoom(roomId);
  await waitFor("alice to see bob join", () => aliceClient.getRoom(roomId)?.getMember(bob.user_id)?.membership === "join");
  // Both crypto layers learn the room's encryption settings from the synced state.
  await waitFor("alice's crypto to treat the room as encrypted", () => aliceClient.getCrypto().isEncryptionEnabledInRoom(roomId));
  await waitFor("bob's crypto to treat the room as encrypted", () => bobClient.getCrypto().isEncryptionEnabledInRoom(roomId));
  assert.equal(bobClient.getRoom(roomId).hasEncryptionStateEvent(), true);
});

test("alice -> bob message is encrypted on the wire and decrypted by bob", async () => {
  const body = `${MARK} hello from alice`;
  sentBodies.push(body);
  await aliceClient.sendMessage(roomId, { msgtype: "m.text", body });
  const ev = await waitFor("bob to decrypt alice's message", () => findDecrypted(bobClient, roomId, body));
  assert.equal(ev.isEncrypted(), true, "event must have been encrypted");
  assert.equal(ev.getWireType(), "m.room.encrypted");
  assert.equal(ev.isDecryptionFailure(), false);
  assert.equal(ev.getSender(), alice.user_id);
  const info = await bobClient.getCrypto().getEncryptionInfoForEvent(ev);
  assert.ok(info, "encryption info must be available for a decrypted event");
});

test("bob -> alice message is encrypted and decrypted by alice", async () => {
  const body = `${MARK} reply from bob`;
  sentBodies.push(body);
  await bobClient.sendMessage(roomId, { msgtype: "m.text", body });
  const ev = await waitFor("alice to decrypt bob's message", () => findDecrypted(aliceClient, roomId, body));
  assert.equal(ev.isEncrypted(), true);
  assert.equal(ev.getWireType(), "m.room.encrypted");
  assert.equal(ev.getSender(), bob.user_id);
});

let attachment;
test("encrypted attachment: ciphertext on the server, plaintext only after decryption", async () => {
  const plaintext = Buffer.from(`${MARK}\n`.repeat(200) + "end of file\n", "utf8");
  const { data, info: keyInfo } = await encryptAttachment(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength));
  assert.ok(!Buffer.from(data).includes(Buffer.from(MARK)), "ciphertext must not contain the marker");
  const { content_uri } = await aliceClient.uploadContent(Buffer.from(data), { type: "application/octet-stream", includeFilename: false });
  attachment = { contentUri: content_uri, plaintext };
  const body = "secret-notes.txt";
  await aliceClient.sendMessage(roomId, {
    msgtype: "m.file",
    body,
    filename: body,
    info: { mimetype: "text/plain", size: plaintext.length },
    file: { ...keyInfo, url: content_uri },
  });
  const ev = await waitFor("bob to decrypt the file event", () => findDecrypted(bobClient, roomId, body));
  assert.equal(ev.getWireType(), "m.room.encrypted");
  const file = ev.getContent().file;
  assert.equal(file.url, content_uri);
  assert.equal(file.v, "v2");
  // Bob downloads through authenticated media with his own token, like the web client.
  const [, serverName, mediaId] = /^mxc:\/\/([^/]+)\/(.+)$/.exec(content_uri);
  const r = await fetch(`${base}/_matrix/client/v1/media/download/${serverName}/${mediaId}`, {
    headers: { Authorization: `Bearer ${bob.access_token}` },
  });
  assert.equal(r.status, 200);
  const stored = Buffer.from(await r.arrayBuffer());
  assert.equal(stored.length, plaintext.length, "AES-CTR ciphertext has the same length as the plaintext");
  assert.ok(!stored.includes(Buffer.from(MARK)), "bytes stored on the server must not contain the plaintext marker");
  const decrypted = Buffer.from(await decryptAttachment(stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength), file));
  assert.ok(decrypted.equals(plaintext), "receiver must recover the exact plaintext");
  // Unauthenticated download must be refused (authenticated media is enabled).
  const anon = await fetch(`${base}/_matrix/client/v1/media/download/${serverName}/${mediaId}`);
  assert.ok(anon.status === 401 || anon.status === 403, `anonymous download must fail, got ${anon.status}`);
  // Tampering is detected (SHA-256 of the ciphertext is checked before decrypting).
  const tampered = Buffer.from(stored);
  tampered[0] ^= 0xff;
  await assert.rejects(() => decryptAttachment(tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength), file));
});

test("the server never saw plaintext: /messages and the admin API only hold ciphertext", async () => {
  // As a room member (exactly what the server would hand any client).
  const { text, json } = await rawJson(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`, alice.access_token);
  assert.ok(!text.includes(MARK), "member's raw /messages response must not contain the marker");
  assert.ok(!text.includes("secret-notes.txt"), "file names are encrypted too");
  const messageLike = json.chunk.filter((e) => !("state_key" in e));
  assert.ok(messageLike.length >= 3, `expected at least 3 timeline events, got ${messageLike.length}`);
  for (const e of messageLike) {
    assert.equal(e.type, "m.room.encrypted", `non-state event ${e.event_id} has type ${e.type}`);
    assert.equal(e.content.algorithm, "m.megolm.v1.aes-sha2");
    assert.equal(typeof e.content.ciphertext, "string");
    assert.equal(e.content.body, undefined);
  }
  // As a server administrator (what the operator could see in the database).
  const adminView = await rawJson(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`, admin.access_token);
  assert.ok(!adminView.text.includes(MARK), "admin API must not reveal the marker");
  const adminMessages = adminView.json.chunk.filter((e) => !("state_key" in e));
  assert.ok(adminMessages.length >= 3);
  for (const e of adminMessages) assert.equal(e.type, "m.room.encrypted");
  // And the raw sync stream for a member.
  const sync = await rawJson(`/_matrix/client/v3/sync?timeout=0`, bob.access_token);
  assert.ok(!sync.text.includes(MARK), "raw /sync must not contain the marker");
  assert.ok(sentBodies.length === 2 && attachment, "previous steps ran");
});
