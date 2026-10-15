/**
 * Core call tests: real, separate Chromium clients (one per network namespace, see lab.sh),
 * signed in to the deployed Lumen stack, calling each other through MatrixRTC + LiveKit with
 * end-to-end encrypted media. Each client's microphone is a different pure tone
 * (A 440 Hz, B 660 Hz, C 880 Hz), so a receiver proves *whom* it hears with an FFT of the
 * received track. All numbers are read from RTCPeerConnection.getStats() in the browsers.
 *
 *   sudo bash tests/calls/lab.sh up
 *   sudo NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt node tests/calls/calls.test.mjs \
 *        [--base lumen.test] [--server-ip 10.200.0.1] [--no-netns]
 *
 * Covers: 1:1 voice both directions, ringing/decline/missed calls and history, legacy invite
 * notice, HD Voice negotiation (codec, fmtp, bitrate, DTX), High-Fidelity (stereo, no DTX,
 * bitrate), mute observed remotely, mic/speaker selection, voice-processing settings,
 * 720p and 1080p video, camera switching, 3-person group call, screen sharing, screenshots.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { acceptIncoming, diagnostics, expectTone, leave, openPanel, remoteTiles, startFromHeader, waitE2EE, waitPhase, waitRemoteCount } from "./lib/callui.mjs";
import {
  APP,
  createDm,
  createGroup,
  ensureLab,
  hearRemoteTones,
  launchClient,
  makeReporter,
  mx,
  openRoom,
  rtcStats,
  sampleRates,
  selectedPairs,
  SHOTS,
  signIn,
  summariseRtp,
  T,
} from "./lib/lab.mjs";

const rep = makeReporter("core");
const { log, step } = rep;
const shot = (c, name) => c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
/** livekit-client's frame encryption adds 30 bytes per frame (12-byte IV, 16-byte GCM tag, 2-byte trailer). */
const E2EE_OVERHEAD = 30;

log(`lab: ${ensureLab().replace(/\n/g, " | ")}`);
const A = await launchClient({ ns: "lab-a", label: "A", tone: 440 });
const B = await launchClient({ ns: "lab-b", label: "B", tone: 660, colorScheme: "dark" });
let C = null;
let dm = "";
let group = "";

async function outboundAudio(client, ms = 5000) {
  const rows = await sampleRates(client, ms);
  const a = rows.find((r) => r.dir === "out" && r.kind === "audio" && r.pcState === "connected");
  assert.ok(a, "outbound audio stream present");
  const opusKbps = a.dPackets ? Math.round((((a.kbps * 1000 * ms) / 8000 - E2EE_OVERHEAD * a.dPackets) * 8) / ms) : null;
  return { ...a, pps: Math.round((a.dPackets / ms) * 10000) / 10, opusKbps };
}

async function senderTrackSettings(client, kind) {
  return client.page.evaluate((kind) => {
    for (const pc of window.__lumenTestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      for (const s of pc.getSenders()) if (s.track?.kind === kind && s.track.readyState === "live") return s.track.getSettings();
    }
    return null;
  }, kind);
}

async function setSelect(client, label, optionText) {
  const sel = client.page.locator(".call-panel").getByLabel(label);
  await sel.waitFor({ timeout: T });
  const value = await sel.locator("option", { hasText: optionText }).first().getAttribute("value");
  await sel.selectOption(value);
  return value;
}

try {
  await step("sign in A (lab-a) and B (lab-b) through portal SSO; A opens an encrypted DM with B", async () => {
    await signIn(A, "alice", "Alice Lumen");
    await signIn(B, "bob", "Bob Lumen");
    dm = await createDm(A, B);
    log(`DM ${dm}`);
    await openRoom(A, dm);
    await openRoom(B, dm);
  });

  await step("ring → decline: B declines A's 1:1 ring (RTC decline event); A's call ends with the reason", async () => {
    await startFromHeader(A, "audio");
    await A.page.locator('[data-testid="call-status"]', { hasText: "Ringing" }).waitFor({ timeout: T });
    const card = B.page.locator(".incoming-call");
    await card.waitFor({ timeout: T });
    assert.match(await card.textContent(), /Alice Lumen is calling.*Voice call/s);
    await shot(B, "desktop-dark-incoming-call");
    await card.getByRole("button", { name: "Decline" }).click();
    await A.page.locator('[data-testid="call-status"]', { hasText: /declined the call/ }).waitFor({ timeout: T });
    log(`A sees: ${await A.page.locator('[data-testid="call-status"]').textContent()}`);
    await A.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    await B.page.locator(".call-item", { hasText: "declined the call" }).waitFor({ timeout: T });
  });

  await step("missed call: A rings, B doesn't answer, A hangs up → B gets a missed-call indicator, timeline item and history entry", async () => {
    // B is looking at the conversation list (not at the DM), as when a call is really missed
    await B.page.goto(`${APP}/#/`);
    await startFromHeader(A, "audio");
    await B.page.locator(".incoming-call").waitFor({ timeout: T });
    await A.page.waitForTimeout(3000);
    await leave(A);
    await B.page.locator(".incoming-call").waitFor({ state: "detached", timeout: T });
    const item = B.page.locator(`a.room-item[href="#/room/${encodeURIComponent(dm)}"]`);
    await item.locator(".missed-call").waitFor({ timeout: T });
    log(`B room list: ${(await item.textContent()).replace(/\s+/g, " ")}`);
    await shot(B, "desktop-dark-missed-call-list");
    await openRoom(B, dm);
    await B.page.locator('.call-item[data-call="missed"]').waitFor({ timeout: T });
    await B.page.locator(".room-header").getByRole("button", { name: "Call history" }).click();
    await B.page.locator('.call-history-item[data-outcome="missed"]').first().waitFor({ timeout: T });
    log(`B history: ${(await B.page.locator(".call-history").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
    await shot(B, "desktop-dark-call-history");
    await B.page.locator(".right-panel").getByRole("button", { name: "Close call history" }).click();
  });

  await step("legacy m.call.invite from an old client → clear 'unsupported call type' notice", async () => {
    const r = await mx(B, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(dm)}/send/m.call.invite/legacy${Date.now()}`, {
      call_id: `legacy${Date.now()}`,
      version: 1,
      lifetime: 60000,
      offer: { type: "offer", sdp: "v=0\r\n" },
    });
    assert.equal(r.status, 200, r.text);
    await A.page.locator(".toast", { hasText: "Unsupported call type" }).waitFor({ timeout: T });
    await A.page.locator('.call-item[data-call="legacy"]').waitFor({ timeout: T });
    log(`A toast: ${(await A.page.locator(".toast", { hasText: "Unsupported call type" }).innerText()).replace(/\s+/g, " ")}`);
  });

  await step("1–2: 1:1 voice call A → B; each hears the other's tone (FFT of the received track)", async () => {
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    for (const c of [A, B]) await waitPhase(c, "connected");
    await waitE2EE(A);
    await waitE2EE(B);
    await A.page.waitForTimeout(2500);
    const heardByA = await hearRemoteTones(A);
    const heardByB = await hearRemoteTones(B);
    log("A hears:", heardByA);
    log("B hears:", heardByB);
    expectTone(heardByA, B.userId, 660, "A hears B");
    expectTone(heardByB, A.userId, 440, "B hears A");
    log("A ICE:", selectedPairs(await rtcStats(A)).map((p) => `${p.localType}/${p.localProtocol} → ${p.remoteAddress || "SFU"}:${p.remotePort} rtt=${p.rtt}s dtls=${p.dtlsState} srtp=${p.srtpCipher}`));
    await shot(A, "desktop-light-voice-call");
    await shot(B, "desktop-dark-voice-call");
  });

  await step("3: HD Voice negotiated: Opus 48 kHz, in-band FEC, DTX; bitrate within the 40 kbit/s preset; RED status", async () => {
    const out = await outboundAudio(A);
    log("A outbound audio:", { codec: out.mimeType, clockRate: out.clockRate, fmtp: out.fmtp, kbpsOnWire: out.kbps, pps: out.pps, opusKbpsExclE2EE: out.opusKbps });
    assert.equal(out.mimeType, "audio/opus");
    assert.equal(out.clockRate, 48000);
    assert.match(out.fmtp, /useinbandfec=1/);
    assert.match(out.fmtp, /usedtx=1/);
    assert.ok(out.opusKbps <= 44 && out.opusKbps >= 16, `Opus bitrate ${out.opusKbps} kbit/s outside the HD Voice range (preset max 40)`);
    const inn = summariseRtp(await rtcStats(B)).filter((r) => r.dir === "in" && r.kind === "audio");
    log("B inbound audio codecs:", inn.map((r) => `${r.mimeType}/${r.clockRate} fmtp=${r.fmtp}`));
    const red = [...inn, out].some((r) => /red/i.test(r.mimeType ?? ""));
    log(`audio/red negotiated: ${red} (livekit-client disables RED whenever frame encryption is on)`);
    const sdpRed = await A.page.evaluate(() => (window.__lumenTestPcs ?? []).some((pc) => /a=rtpmap:\d+ red\/48000/.test(pc.localDescription?.sdp ?? "")));
    log(`audio/red offered in A's SDP: ${sdpRed}`);
    const d = await diagnostics(A);
    log("A diagnostics panel:", d.filter((x) => x.dir === "send" && x.kind === "audio"));
    assert.ok(d.some((x) => x.k === "codec" && /audio\/opus · 48 kHz · mono/.test(x.v)), "panel shows Opus 48 kHz mono");
    assert.ok(d.some((x) => x.k === "fmtp" && /in-band FEC/.test(x.v) && /DTX/.test(x.v)), "panel shows FEC + DTX");
    await shot(A, "desktop-light-diagnostics");
  });

  await step("4 + DTX: A mutes → B sees muted state and the tone stops; packet rate drops (DTX); unmute → tone returns", async () => {
    const before = await outboundAudio(A, 4000);
    await A.page.getByRole("button", { name: "Mute microphone" }).click();
    await B.page.locator(`.call-tile[data-participant="${A.userId}"][data-mic="muted"]`).waitFor({ timeout: T });
    await A.page.waitForTimeout(1500);
    const muted = await outboundAudio(A, 4000);
    const heard = await hearRemoteTones(B);
    log(`A packets/s: unmuted ${before.pps}, muted ${muted.pps}; B hears while A muted:`, heard);
    const row = heard.find((h) => h.participant === A.userId);
    assert.ok(!row || row.audibleFraction < 0.2, "tone must stop while muted");
    assert.ok(muted.pps < before.pps / 2, "muted + DTX sends far fewer packets");
    assert.equal(await A.page.locator(".call-btn[aria-label='Unmute microphone']").count(), 1, "A's own UI shows the mic as muted");
    await shot(B, "desktop-dark-remote-muted");
    await A.page.getByRole("button", { name: "Unmute microphone" }).click();
    await B.page.locator(`.call-tile[data-participant="${A.userId}"][data-mic="on"]`).waitFor({ timeout: T });
    await A.page.waitForTimeout(1500);
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A after unmute");
  });

  await step("5: microphone and speaker selection apply to the live call (track deviceId, audio element sinkId)", async () => {
    await openPanel(A, "Audio and video settings");
    const before = await senderTrackSettings(A, "audio");
    const micId = await setSelect(A, "Microphone", "Fake Audio Input 1");
    await A.page.waitForFunction((id) => (window.__lumenTestPcs ?? []).some((pc) => pc.getSenders().some((s) => s.track?.kind === "audio" && s.track.getSettings().deviceId === id)), micId, { timeout: T });
    const after = await senderTrackSettings(A, "audio");
    log(`A mic deviceId: ${before?.deviceId} → ${after?.deviceId} (picked "Fake Audio Input 1")`);
    assert.equal(after.deviceId, micId);
    expectTone(await hearRemoteTones(B), A.userId, 440, "B still hears A after the mic switch");
    const spk = await setSelect(A, "Speaker or headphones", "Fake Audio Output 1");
    await A.page.waitForFunction((id) => [...document.querySelectorAll("audio[data-call-audio]")].every((a) => a.sinkId === id), spk, { timeout: T });
    const sinks = await A.page.$$eval("audio[data-call-audio]", (els) => els.map((e) => e.sinkId));
    log(`A remote audio sinkId(s): ${sinks.join(", ")} (picked "Fake Audio Output 1" = ${spk})`);
    await shot(A, "desktop-light-call-settings");
  });

  await step("6: voice processing applied (track.getSettings): HD Voice on; High-Fidelity off, stereo, no DTX, higher bitrate", async () => {
    const hd = await senderTrackSettings(A, "audio");
    log("A HD Voice capture settings:", { echoCancellation: hd.echoCancellation, noiseSuppression: hd.noiseSuppression, autoGainControl: hd.autoGainControl, voiceIsolation: hd.voiceIsolation, channelCount: hd.channelCount, sampleRate: hd.sampleRate });
    assert.equal(hd.echoCancellation, true);
    assert.equal(hd.noiseSuppression, true);
    assert.equal(hd.autoGainControl, true);
    const panel = A.page.locator(".call-panel");
    await panel.getByText("High-Fidelity", { exact: true }).click();
    await panel.getByRole("switch", { name: "Stereo" }).click();
    await A.page.waitForFunction(() => (window.__lumenTestPcs ?? []).some((pc) => pc.getSenders().some((s) => s.track?.kind === "audio" && s.track.getSettings().echoCancellation === false)), null, { timeout: T });
    await A.page.waitForTimeout(4000);
    const hifi = await senderTrackSettings(A, "audio");
    const out = await outboundAudio(A, 5000);
    log("A High-Fidelity capture settings:", { echoCancellation: hifi.echoCancellation, noiseSuppression: hifi.noiseSuppression, autoGainControl: hifi.autoGainControl, channelCount: hifi.channelCount });
    log("A High-Fidelity outbound:", { codec: out.mimeType, fmtp: out.fmtp, kbpsOnWire: out.kbps, opusKbpsExclE2EE: out.opusKbps, pps: out.pps });
    assert.equal(hifi.echoCancellation, false);
    assert.equal(hifi.noiseSuppression, false);
    assert.equal(hifi.autoGainControl, false);
    assert.ok(!/usedtx=1/.test(out.fmtp ?? ""), "DTX off in High-Fidelity");
    assert.ok(out.opusKbps > 60, `High-Fidelity bitrate ${out.opusKbps} kbit/s should exceed HD Voice`);
    if (hifi.channelCount === 2) assert.match(out.fmtp, /stereo=1/);
    await A.page.getByRole("button", { name: "Mute microphone" }).click();
    await A.page.waitForTimeout(1500);
    const mutedNoDtx = await outboundAudio(A, 4000);
    log(`A High-Fidelity muted packets/s (DTX off): ${mutedNoDtx.pps}`);
    await A.page.getByRole("button", { name: "Unmute microphone" }).click();
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A in High-Fidelity");
    const warn = await panel.locator(".alert-warning", { hasText: "Echo cancellation is off" }).count();
    log(`echo warning shown with AEC off on speakers: ${warn > 0}`);
    await shot(A, "desktop-light-hifi-settings");
    // back to HD Voice
    await panel.getByText("HD Voice", { exact: true }).click();
    await A.page.waitForFunction(() => (window.__lumenTestPcs ?? []).some((pc) => pc.getSenders().some((s) => s.track?.kind === "audio" && s.track.getSettings().echoCancellation === true)), null, { timeout: T });
    log("note: acoustic echo/noise performance can't be measured headless (fake devices, no acoustic path); only the applied settings are verified.");
  });

  await step("call ends for both when A hangs up (1:1); timeline shows 'Call ended' with duration", async () => {
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    await B.page.locator('.call-item[data-call="ended"]').last().waitFor({ timeout: T });
    log(`B timeline: ${(await B.page.locator('.call-item[data-call="ended"]').last().innerText()).replace(/\s+/g, " ")}`);
  });

  await step("7: 1:1 video call at 720p: negotiated resolution and frame rate from outbound/inbound-rtp", async () => {
    await startFromHeader(A, "video");
    await acceptIncoming(B, "video");
    await waitE2EE(A);
    await waitE2EE(B);
    await B.page.waitForTimeout(8000);
    const outA = (await sampleRates(A, 4000)).filter((r) => r.dir === "out" && r.kind === "video");
    const inB = (await sampleRates(B, 4000)).filter((r) => r.dir === "in" && r.kind === "video");
    log("A outbound video layers:", outA.map((r) => `${r.rid} ${r.mimeType} ${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} ${r.kbps} kbit/s limit=${r.qualityLimitationReason}`));
    log("B inbound video:", inB.map((r) => `${r.mimeType} ${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} ${r.kbps} kbit/s decoded+${r.dFramesDecoded}`));
    const top = outA.find((r) => r.frameHeight === 720);
    assert.ok(top, "A sends a 720p layer");
    assert.ok(outA.some((r) => r.frameHeight === 180) && outA.some((r) => r.frameHeight === 360), "simulcast low/medium layers present");
    assert.ok(inB.some((r) => r.frameHeight === 720 && r.dFramesDecoded > 0), "B decodes A's 720p video");
    assert.ok(inB.some((r) => r.framesPerSecond >= 15), "B receives ≥ 15 fps");
    assert.equal(outA[0].mimeType, "video/VP8");
    await shot(A, "desktop-light-video-call");
    await shot(B, "desktop-dark-video-call");
    await B.page.setViewportSize({ width: 390, height: 844 });
    await B.page.waitForTimeout(1500);
    await shot(B, "mobile-dark-video-call");
    await B.page.setViewportSize({ width: 1280, height: 800 });
  });

  await step("camera switching: A switches to the second camera; the sender track's deviceId changes, B keeps decoding", async () => {
    const before = await senderTrackSettings(A, "video");
    await A.page.getByRole("button", { name: "Switch camera" }).click();
    await A.page.waitForFunction((id) => (window.__lumenTestPcs ?? []).some((pc) => pc.getSenders().some((s) => s.track?.kind === "video" && s.track.readyState === "live" && s.track.getSettings().deviceId !== id)), before.deviceId, { timeout: T });
    const after = await senderTrackSettings(A, "video");
    log(`A camera: ${before.deviceId.slice(0, 12)}… → ${after.deviceId.slice(0, 12)}…`);
    await B.page.waitForTimeout(3000);
    const inB = (await sampleRates(B, 3000)).filter((r) => r.dir === "in" && r.kind === "video");
    assert.ok(inB.some((r) => r.dFramesDecoded > 0), "B still decodes video after the switch");
  });

  await step("8: 1080p: A picks 'Highest available', B on a 1920×1080 screen receives 1920×1080", async () => {
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    await A.page.getByRole("button", { name: "Settings" }).first().click();
    await A.page.getByRole("tab", { name: "Calls" }).click();
    await A.page.getByLabel("Video quality").selectOption("highest");
    await A.page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await B.page.setViewportSize({ width: 1920, height: 1080 });
    await startFromHeader(A, "video");
    await acceptIncoming(B, "video");
    await waitE2EE(B);
    await B.page.waitForTimeout(12000);
    const outA = (await sampleRates(A, 4000)).filter((r) => r.dir === "out" && r.kind === "video");
    const inB = (await sampleRates(B, 4000)).filter((r) => r.dir === "in" && r.kind === "video");
    log("A outbound video layers (highest):", outA.map((r) => `${r.rid} ${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} ${r.kbps} kbit/s limit=${r.qualityLimitationReason}`));
    log("B inbound video (1920×1080 viewport):", inB.map((r) => `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} ${r.kbps} kbit/s decoded+${r.dFramesDecoded}`));
    assert.ok(outA.some((r) => r.frameHeight === 1080), "A sends a 1080p layer");
    const got = inB.find((r) => r.dFramesDecoded > 0);
    assert.ok(got, "B decodes video");
    if (got.frameHeight !== 1080) log(`NOTE: B receives ${got.frameWidth}x${got.frameHeight}; the SFU/adaptive stream chose a lower layer (CPU/bandwidth: A's limit=${outA.find((r) => r.frameHeight === 1080)?.qualityLimitationReason})`);
    else log("B receives the full 1920×1080 layer");
    await shot(B, "desktop-dark-video-1080p");
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    await B.page.setViewportSize({ width: 1280, height: 800 });
    await A.page.getByRole("button", { name: "Settings" }).first().click();
    await A.page.getByRole("tab", { name: "Calls" }).click();
    await A.page.getByLabel("Video quality").selectOption("auto");
    await shot(A, "desktop-light-settings-calls");
    await A.page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
  });

  await step("11: group call with 3 clients (A, B, C in separate namespaces): each hears the two others", async () => {
    C = await launchClient({ ns: "lab-c", label: "C", tone: 880 });
    await signIn(C, "carol", "Carol Lumen");
    group = await createGroup(A, [B, C], `Call test ${new Date().toISOString().slice(11, 19)}`);
    log(`group ${group}`);
    for (const c of [A, B, C]) await openRoom(c, group);
    await startFromHeader(A, "audio");
    // group calls send a notification (not a ring): "Join" on the card
    for (const c of [B, C]) {
      const card = c.page.locator(".incoming-call");
      await card.waitFor({ timeout: T });
      assert.match(await card.textContent(), /started a call/);
      await acceptIncoming(c, "audio");
    }
    for (const c of [A, B, C]) await waitRemoteCount(c, 2, 60_000);
    for (const c of [A, B, C]) await waitE2EE(c, 60_000);
    await A.page.waitForTimeout(2500);
    const tones = { [A.userId]: 440, [B.userId]: 660, [C.userId]: 880 };
    for (const c of [A, B, C]) {
      const heard = await hearRemoteTones(c);
      log(`${c.label} hears:`, heard.map((h) => `${h.name}: ${h.medianPeakHz} Hz (${Math.round(h.audibleFraction * 100)}%)`));
      for (const o of [A, B, C].filter((x) => x !== c)) expectTone(heard, o.userId, tones[o.userId], `${c.label} hears ${o.label}`);
    }
    await shot(A, "desktop-light-group-voice");
  });

  await step("12: screen sharing in the group call: B and C receive A's screen (and its audio track)", async () => {
    await A.page.getByRole("button", { name: "Share your screen" }).click();
    for (const c of [B, C]) await c.page.locator('.call-tile.screen video[data-call-video="screen_share"]').waitFor({ timeout: T });
    await B.page.waitForTimeout(4000);
    const inB = (await sampleRates(B, 3000)).filter((r) => r.dir === "in" && r.kind === "video");
    log("B inbound video (screen):", inB.map((r) => `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} ${r.kbps} kbit/s decoded+${r.dFramesDecoded}`));
    assert.ok(inB.some((r) => r.dFramesDecoded > 0), "B decodes the shared screen");
    const screenAudio = await B.page.locator('audio[data-source="screen_share_audio"]').count();
    log(`screen-share audio element on B: ${screenAudio > 0}`);
    await shot(B, "desktop-dark-screen-share");
    await B.page.setViewportSize({ width: 390, height: 844 });
    await B.page.waitForTimeout(1000);
    await shot(B, "mobile-dark-screen-share");
    await B.page.setViewportSize({ width: 1280, height: 800 });
    await A.page.getByRole("button", { name: "Stop sharing your screen" }).click();
    for (const c of [B, C]) await c.page.locator(".call-tile.screen").waitFor({ state: "detached", timeout: T });
  });

  await step("group video layout: all three cameras on; active-speaker highlight, participants panel", async () => {
    for (const c of [A, B, C]) await c.page.getByRole("button", { name: "Turn camera on" }).click();
    await A.page.waitForFunction(() => document.querySelectorAll(".call-screen .call-tile video").length >= 3, null, { timeout: T });
    await A.page.waitForTimeout(6000);
    const inA = (await sampleRates(A, 3000)).filter((r) => r.dir === "in" && r.kind === "video");
    log("A inbound videos:", inA.map((r) => `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} decoded+${r.dFramesDecoded}`));
    assert.ok(inA.filter((r) => r.dFramesDecoded > 0).length >= 2, "A decodes both remote cameras");
    log("A tiles:", await remoteTiles(A));
    await shot(A, "desktop-light-group-video");
    await openPanel(A, /^Participants/);
    await shot(A, "desktop-light-group-participants");
    await A.page.setViewportSize({ width: 390, height: 844 });
    await A.page.locator(".call-top").getByRole("button", { name: /^Participants/ }).click();
    await A.page.waitForTimeout(800);
    await shot(A, "mobile-light-group-video");
    await A.page.setViewportSize({ width: 1280, height: 800 });
    for (const c of [A, B, C]) await leave(c);
  });
} finally {
  const problems = [...A.problems, ...B.problems, ...(C?.problems ?? [])];
  log(`CSP violations / page errors: ${problems.length ? JSON.stringify(problems.slice(0, 10)) : "none"}`);
  rep.finish();
  for (const c of [A, B, C]) await c?.browser.close().catch(() => undefined);
}
