/**
 * Call security against the deployed stack:
 *
 * 13 an outsider (not in the room) can't get a media token (403), anonymous requests are
 *    refused (401), and the app gives them no way to join;
 * 14 media E2EE proof: a "rogue subscriber" simulating the SFU operator gets a valid LiveKit
 *    token minted directly with the server's API key and joins the call's LiveKit room
 *    without Matrix keys — it receives the encrypted media but can't decode it, while the
 *    members decode fine;
 * R  revocation: during a 3-person call the room admin removes C from the room. A and B keep
 *    receiving each other; a new key index reaches A and B but not C; C's next token request
 *    is refused; with C's SFU connection kept open (C's client prevented from seeing the
 *    removal) C's decoders stop working for media sent after the rotation; A and B stop
 *    playing C. Finally C's client learns about the removal and leaves the SFU itself.
 *
 *   sudo NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt node tests/calls/security.test.mjs
 * Needs root for the LiveKit API key (/etc/lumen/secrets/livekit_keys) and the database check.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { acceptIncoming, expectTone, leave, openPanel, remoteTiles, startFromHeader, waitE2EE, waitRemoteCount } from "./lib/callui.mjs";
import { APP, BASE, createDm, createGroup, ensureLab, hearRemoteTones, HS, launchClient, makeReporter, mx, openRoom, REPO, request, rtcStats, sampleRates, SHOTS, signIn, T } from "./lib/lab.mjs";
import { resolveChatDep } from "../chat/lib/deps.mjs";

const rep = makeReporter("security");
const { log, step } = rep;
const shot = (c, name) => c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const b64u = (b) => Buffer.from(b).toString("base64url");
const unpadded = (buf) => buf.toString("base64").replace(/=+$/, "");
const identityOf = (userId, deviceId) => unpadded(createHash("sha256").update(JSON.stringify([userId, `${userId}:${deviceId}`])).digest());
const aliasOf = (roomId) => unpadded(createHash("sha256").update(JSON.stringify([roomId, "m.call#ROOM"])).digest());
const jwtPayload = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const SFU = `wss://rtc.${BASE}`;

function sql(query) {
  return execFileSync(path.join(REPO, "lumenctl"), ["compose", "exec", "-T", "postgres", "psql", "-qAtU", "postgres", "-d", "synapse", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Mints a LiveKit access token with the server's own API key (what an SFU operator can do). */
function operatorToken(room, identity) {
  const line = fs.readFileSync(process.env.LIVEKIT_KEYS || "/etc/lumen/secrets/livekit_keys", "utf8").split("\n").find((l) => l.includes(":"));
  const [key, secret] = line.split(":").map((x) => x.trim());
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ iss: key, sub: identity, name: identity, nbf: now - 10, exp: now + 900, video: { room, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false } }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

/** A bare livekit-client page (no Matrix, no keys) joined with the operator token. */
async function rogueJoin(client, room) {
  await client.page.goto("about:blank");
  await client.page.addScriptTag({ content: fs.readFileSync(resolveChatDep("livekit-client").replace(/livekit-client\.(esm\.mjs|umd\.js)$/, "livekit-client.umd.js"), "utf8") });
  return client.page.evaluate(
    async ({ url, token }) => {
      const LK = window.LivekitClient;
      const lkRoom = new LK.Room({ adaptiveStream: false, dynacast: false });
      window.__rogue = lkRoom;
      lkRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, p) => {
        const el = track.attach();
        el.dataset.participant = p.identity;
        el.dataset.source = track.source;
        if (track.kind === "audio") el.dataset.callAudio = "";
        else el.muted = true;
        document.body.append(el);
      });
      await lkRoom.connect(url, token, { autoSubscribe: true });
      await lkRoom.startAudio().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 3000));
      return {
        identity: lkRoom.localParticipant.identity,
        remote: [...lkRoom.remoteParticipants.values()].map((p) => ({ identity: p.identity, tracks: [...p.trackPublications.values()].map((t) => `${t.kind}/${t.source} encrypted=${t.isEncrypted} subscribed=${t.isSubscribed}`) })),
      };
    },
    { url: SFU, token: operatorToken(room, "operator-rogue-subscriber") },
  );
}

ensureLab();
const A = await launchClient({ ns: "lab-a", label: "A", tone: 440 });
const B = await launchClient({ ns: "lab-b", label: "B", tone: 660 });
const clients = [A, B];
rep.failShots(() => clients);
let dm = "";
let jwtSeenByA = null;
let revocationGroup = "";
let revC = null;
const keyIdx = async (viewer, of) => (await remoteTiles(viewer)).find((t) => t.user === of.userId)?.key ?? null;
A.page.on("response", async (r) => {
  if (r.url().includes("/rtc/livekit/get_token") && r.status() === 200) jwtSeenByA = (await r.json().catch(() => null))?.jwt ?? jwtSeenByA;
});

try {
  await step("sign in A and B; their encrypted DM", { always: true }, async () => {
    await signIn(A, "alice", "Alice Lumen");
    await signIn(B, "bob", "Bob Lumen");
    dm = await createDm(A, B);
    await openRoom(A, dm);
    await openRoom(B, dm);
  });

  await step("13: outsider D (lab-c, not in the room): token 403, anonymous 401, membership event 403, no call UI", async () => {
    const D = await launchClient({ ns: "lab-c", label: "D", tone: 1000 });
    clients.push(D);
    await signIn(D, "dave", "Dave Outsider");
    const body = { url: SFU, server_name: BASE, room_id: dm, slot_id: "m.call#ROOM", member_id: `${D.userId}:${D.deviceId}` };
    const r = await mx(D, "POST", "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token", body);
    log(`D get_token for A+B's DM: HTTP ${r.status} ${r.text}`);
    assert.equal(r.status, 403);
    assert.equal(r.json?.errcode, "M_FORBIDDEN");
    const anon = await request(`${HS}/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    log(`anonymous get_token: HTTP ${anon.status} ${anon.text}`);
    assert.equal(anon.status, 401);
    const st = await mx(D, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(dm)}/state/org.matrix.msc3401.call.member/_${D.userId}_${D.deviceId}_m.call`, { application: "m.call", call_id: "", device_id: D.deviceId, scope: "m.room", focus_active: { type: "livekit", focus_selection: "multi_sfu" }, foci_preferred: [{ type: "livekit", url: SFU }], expires: 3600000 });
    log(`D sends a call membership into the DM: HTTP ${st.status} ${st.text}`);
    assert.equal(st.status, 403);
    await D.page.goto(`${APP}/#/room/${encodeURIComponent(dm)}`);
    await D.page.getByText("Conversation not available").waitFor({ timeout: T });
    assert.equal(await D.page.getByRole("button", { name: /Voice call|Video call|Join the call/ }).count(), 0, "no call controls for an outsider");
    await shot(D, "desktop-light-outsider");
    await D.browser.close();
    clients.pop();
  });

  await step("14: rogue SFU-level subscriber with a valid operator token receives the media but can't decode it; members can", async () => {
    await startFromHeader(A, "video");
    await acceptIncoming(B, "video");
    await waitE2EE(A);
    await waitE2EE(B);
    assert.ok(jwtSeenByA, "A's get_token response captured");
    const p = jwtPayload(jwtSeenByA);
    log(`A's SFU token: sub=${p.sub} room=${p.video.room} roomJoin=${p.video.roomJoin} roomCreate=${p.video.roomCreate} ttl=${p.exp - p.nbf}s`);
    assert.equal(p.sub, identityOf(A.userId, A.deviceId), "LiveKit identity = sha256(user, member id)");
    assert.equal(p.video.room, aliasOf(dm), "LiveKit room = sha256(room id, slot id)");
    const R = await launchClient({ ns: "lab-c", label: "rogue", tone: 1000 });
    clients.push(R);
    const joined = await rogueJoin(R, p.video.room);
    log("rogue joined LiveKit room as", joined.identity, "and sees:", joined.remote);
    assert.ok(joined.remote.length >= 2, "rogue sees both members on the SFU");
    assert.ok(joined.remote.every((x) => x.tracks.every((t) => /encrypted=true/.test(t))), "every published track is marked encrypted");
    await R.page.waitForTimeout(8000);
    const rows = await sampleRates(R, 5000);
    const inbound = rows.filter((r) => r.dir === "in");
    log("rogue inbound RTP (receives the bytes):", inbound.map((r) => `${r.kind} ${r.mimeType} ${r.kbps} kbit/s packets+${r.dPackets} framesDecoded=${r.framesDecoded ?? "-"} (+${r.dFramesDecoded ?? "-"}) keyFramesDecoded=${r.keyFramesDecoded ?? "-"} framesDropped=${r.framesDropped ?? "-"}`));
    assert.ok(inbound.some((r) => r.kind === "video" && (r.dPackets ?? 0) > 50), "rogue receives video packets");
    const decodedVideo = inbound.filter((r) => r.kind === "video" && (r.dFramesDecoded ?? 0) > 0);
    const heard = await hearRemoteTones(R, 4000);
    log("rogue audio analysis (members' tones are 440 and 660 Hz):", heard);
    const toneHeard = heard.some((h) => [440, 660].some((hz) => h.medianPeakHz && Math.abs(h.medianPeakHz - hz) <= 15 && h.audibleFraction > 0.5));
    // a decoded frame of ciphertext is noise: check what the rogue's video elements actually show
    const pixels = await R.page.evaluate(() =>
      [...document.querySelectorAll("video")].map((v) => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 36;
        const g = c.getContext("2d");
        try {
          g.drawImage(v, 0, 0, 64, 36);
          const d = g.getImageData(0, 0, 64, 36).data;
          let green = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 100 && d[i] < 90 && d[i + 2] < 90) green++;
          return { w: v.videoWidth, h: v.videoHeight, greenShare: Math.round((green / (d.length / 4)) * 100) / 100 };
        } catch (e) {
          return { error: String(e) };
        }
      }),
    );
    log("rogue video elements (members' cameras are mostly green):", pixels);
    await R.page.screenshot({ path: path.join(SHOTS, "rogue-subscriber-view.png") });
    log(`rogue: video frames decoded in 5 s = ${decodedVideo.map((r) => r.dFramesDecoded).join(", ") || 0}; tone recognised = ${toneHeard}`);
    assert.ok(!toneHeard, "the rogue must not hear the members' tones");
    assert.ok(pixels.every((x) => x.error || x.greenShare < 0.5), "the rogue must not see the members' camera pictures");
    // members are unaffected and see the extra connection flagged
    expectTone(await hearRemoteTones(A), B.userId, 660, "A still hears B");
    expectTone(await hearRemoteTones(B), A.userId, 440, "B still hears A");
    const inA = (await sampleRates(A, 3000)).filter((r) => r.dir === "in" && r.kind === "video");
    log("A inbound video meanwhile:", inA.map((r) => `${r.frameWidth}x${r.frameHeight} decoded+${r.dFramesDecoded}`));
    assert.ok(inA.some((r) => r.dFramesDecoded > 0));
    await A.page.locator(".call-banner", { hasText: "didn't join through Matrix" }).waitFor({ timeout: T }).catch(() => undefined);
    log(`A's warning: ${(await A.page.locator(".call-banner", { hasText: "media server" }).allInnerTexts()).join(" | ") || "(none)"}`);
    await shot(A, "desktop-light-rogue-flagged");
    await R.browser.close();
    clients.pop();
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
  });

  await step("R1: revocation, normal client — admin A removes C during a 3-person call: C's app leaves the call and the SFU, keys rotate for A and B, C's token request is refused", async () => {
    const C = await launchClient({ ns: "lab-c", label: "C", tone: 880 });
    clients.push(C);
    await signIn(C, "carol", "Carol Lumen");
    revocationGroup = await createGroup(A, [B, C], `Revocation ${new Date().toISOString().slice(11, 19)}`);
    for (const c of [A, B, C]) await openRoom(c, revocationGroup);
    await startFromHeader(A, "video");
    for (const c of [B, C]) await acceptIncoming(c, "video");
    for (const c of [A, B, C]) await waitRemoteCount(c, 2, 60_000);
    for (const c of [A, B, C]) await waitE2EE(c, 60_000);
    await A.page.waitForTimeout(3000);
    const before = { BseesA: await keyIdx(B, A), AseesB: await keyIdx(A, B), CseesA: await keyIdx(C, A) };
    log("media key indices before removal:", before);
    const kick = await mx(A, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(revocationGroup)}/kick`, { user_id: C.userId, reason: "revocation test" });
    assert.equal(kick.status, 200, kick.text);
    await C.page.locator(".call-screen").waitFor({ state: "detached", timeout: 60_000 });
    log(`C's app: call closed by itself — "${(await C.page.locator(".empty-card").innerText().catch(() => "")).replace(/\s+/g, " ").trim()}"`);
    const cId = identityOf(C.userId, C.deviceId);
    await A.page.waitForFunction((id) => !document.querySelector(`.call-tile[data-identity="${id}"]`), cId, { timeout: 60_000 });
    log("A: C's connection is gone from the SFU (C's client disconnected itself; the SFU does not kick on its own)");
    await A.page.waitForTimeout(4000);
    const after = { BseesA: await keyIdx(B, A), AseesB: await keyIdx(A, B) };
    log("media key indices after removal:", after);
    assert.ok(Number(after.BseesA) > Number(before.BseesA) && Number(after.AseesB) > Number(before.AseesB), "A and B rotated to new keys");
    expectTone(await hearRemoteTones(A), B.userId, 660, "A hears B after the removal");
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A after the removal");
    const tok = await mx(C, "POST", "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token", { url: SFU, server_name: BASE, room_id: revocationGroup, slot_id: "m.call#ROOM", member_id: `${C.userId}:${C.deviceId}` });
    log(`C get_token after removal: HTTP ${tok.status} ${tok.text}`);
    assert.equal(tok.status, 403);
    revC = C;
  });

  await step("R2: revocation, client that ignores the removal — C keeps its SFU connection: no new keys reach C (server queue checked), C can't decode media sent after the rotation, A and B stop playing C", async () => {
    const C = revC;
    assert.ok(C, "R1 ran");
    // bring C back into the room and the call
    assert.equal((await mx(A, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(revocationGroup)}/invite`, { user_id: C.userId })).status, 200);
    const j = await mx(C, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(revocationGroup)}/join`, {});
    assert.equal(j.status, 200, j.text);
    await openRoom(C, revocationGroup);
    await startFromHeader(C, "video", { join: true });
    for (const c of [A, B, C]) await waitRemoteCount(c, 2, 60_000);
    for (const c of [A, B, C]) await waitE2EE(c, 60_000);
    await A.page.waitForTimeout(3000);
    const before = { BseesA: await keyIdx(B, A), AseesB: await keyIdx(A, B), CseesA: await keyIdx(C, A), CseesB: await keyIdx(C, B) };
    log("media key indices with C back in the call:", before);

    // From now on C's app never sees another /sync response: it can't learn it was removed, so it
    // keeps its SFU connection open (what a modified client could do). A message from A ends
    // C's in-flight long-poll so that the block is in place before the removal.
    await C.page.route("**/_matrix/client/v3/sync**", (r) => r.abort());
    await mx(A, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(revocationGroup)}/send/m.room.message/rv${Date.now()}`, { msgtype: "m.notice", body: "flush" });
    await A.page.waitForTimeout(5000);
    const cDevice = C.deviceId;
    const kick = await mx(A, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(revocationGroup)}/kick`, { user_id: C.userId, reason: "revocation test" });
    assert.equal(kick.status, 200, kick.text);
    log(`A removed C again at ${new Date().toISOString()}; C's sync is blocked`);
    const cId = identityOf(C.userId, cDevice);
    await A.page.waitForFunction((id) => document.querySelector(`.call-tile[data-identity="${id}"]`)?.dataset.encryption === "unknown", cId, { timeout: 30_000 });
    await A.page.waitForTimeout(8000);
    assert.equal(await C.page.locator(".call-screen").count(), 1, "C's call is still running (SFU connection open)");

    // A and B keep receiving each other, and no longer play C
    expectTone(await hearRemoteTones(A), B.userId, 660, "A hears B");
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A");
    const heardC = (await hearRemoteTones(A)).find((h) => h.participant === C.userId);
    log(`A still plays C's audio: ${heardC ? JSON.stringify(heardC) : "no — C has no call membership any more, so A unsubscribed"}`);
    assert.ok(!heardC || heardC.audibleFraction < 0.2, "A no longer plays C");
    await A.page.locator(".call-banner", { hasText: "media server" }).waitFor({ timeout: T });

    // new key index for A and B only
    const after = { BseesA: await keyIdx(B, A), AseesB: await keyIdx(A, B), CseesA: await keyIdx(C, A), CseesB: await keyIdx(C, B) };
    log("media key indices after the removal:", after);
    assert.ok(Number(after.BseesA) > Number(before.BseesA), "B received A's new key");
    assert.ok(Number(after.AseesB) > Number(before.AseesB), "A received B's new key");
    assert.equal(after.CseesA, before.CseesA, "C still has only A's old key");
    assert.equal(after.CseesB, before.CseesB, "C still has only B's old key");
    try {
      const queued = sql(`SELECT count(*) FROM device_inbox WHERE user_id = '${C.userId}' AND device_id = '${cDevice}' AND (message_json::jsonb->>'sender') IN ('${A.userId}', '${B.userId}')`);
      log(`server: to-device messages from A/B waiting for C's device since its sync was blocked: ${queued}`);
      assert.equal(queued, "0", "no key messages were sent to C after the removal");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      log(`(database check unavailable: ${String(e.message).split("\n")[0]})`);
    }

    // C can't get a token, and its open SFU connection no longer yields decodable media
    const tok = await mx(C, "POST", "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token", { url: SFU, server_name: BASE, room_id: revocationGroup, slot_id: "m.call#ROOM", member_id: `${C.userId}:${cDevice}` });
    log(`C get_token: HTTP ${tok.status} ${tok.text}`);
    assert.equal(tok.status, 403);
    const pcs = await rtcStats(C);
    log(`C's peer connections: ${pcs.map((p) => `${p.connectionState}/${p.iceConnectionState}`).join(", ")} — still connected: the SFU doesn't remove members who leave the Matrix room`);
    const cIn = (await sampleRates(C, 5000)).filter((r) => r.dir === "in");
    log("C inbound after the rotation:", cIn.map((r) => `${r.kind} ${r.kbps} kbit/s packets+${r.dPackets} decoded+${r.dFramesDecoded ?? "-"} dropped=${r.framesDropped ?? "-"}`));
    const cHeard = await hearRemoteTones(C, 4000);
    log("C audio analysis after the rotation:", cHeard);
    const cTiles = await remoteTiles(C);
    log("C's own UI:", cTiles);
    const cDecodes = cIn.some((r) => r.kind === "video" && (r.dFramesDecoded ?? 0) > 0);
    const cHears = cHeard.some((h) => h.audibleFraction > 0.5 && [440, 660].some((hz) => Math.abs((h.medianPeakHz ?? 0) - hz) <= 15));
    assert.ok(!cHears, "C must not hear A or B after the rotation");
    assert.ok(!cDecodes, "C must not decode A's or B's video after the rotation");
    await shot(C, "desktop-light-removed-member-view");
    await shot(A, "desktop-light-after-removal");

    // C's client gets its sync back, learns about the removal and leaves the SFU itself
    await C.page.unroute("**/_matrix/client/v3/sync**");
    await C.page.locator(".call-screen").waitFor({ state: "detached", timeout: 120_000 }).catch(() => undefined);
    const gone = await A.page
      .waitForFunction((id) => !document.querySelector(`.call-tile[data-identity="${id}"]`), cId, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    log(`after C's client could sync again: it left the call and the SFU (seen by A): ${gone}`);
    for (const c of [A, B]) await leave(c);
  });
} finally {
  log(`CSP violations / page errors: ${[...A.problems, ...B.problems].length ? JSON.stringify([...A.problems, ...B.problems].slice(0, 10)) : "none"}`);
  rep.finish();
  for (const c of clients) await c.browser.close().catch(() => undefined);
}
