import { describe, expect, it } from "vitest";
import { MatrixEvent } from "matrix-js-sdk";
import { classifyNetwork, describeCandidate, QUALITY_THRESHOLDS, summariseStream, transportInfo, type StatRecord } from "../../src/calls/stats";
import { buildCallHistory, callMarkers, outcomeFor, unseenMissedCall } from "../../src/calls/history";
import { DEFAULT_CALL_PREFS, effectiveProcessing, parseCallPrefs } from "../../src/calls/prefs";
import { audioPublishOptions, describeMediaError, HD_VOICE_MAX_BITRATE, HIFI_MONO_MAX_BITRATE, HIFI_STEREO_MAX_BITRATE, resolveVideoProfile, VIDEO_PROFILES } from "../../src/calls/media";
import { CALL_MEMBER_EVENT, memberIdFor, parseJwt, RTC_DECLINE_EVENT, RTC_NOTIFICATION_EVENT, selectFocus, validLivekitUrl, validateNotification } from "../../src/calls/rtc";
import { buildTimeline } from "../../src/matrix/timeline";
import { formatDuration } from "../../src/lib/format";

const ev = (type: string, sender: string, ts: number, content: object, extra: object = {}) =>
  new MatrixEvent({ type, sender, origin_server_ts: ts, content, event_id: `$${ts}`, room_id: "!r:x", ...extra });
const join = (sender: string, ts: number, device = "D") =>
  ev(CALL_MEMBER_EVENT, sender, ts, { application: "m.call", call_id: "", device_id: device, scope: "m.room", "m.call.intent": "video", focus_active: { type: "livekit", focus_selection: "multi_sfu" }, foci_preferred: [] }, { state_key: `_${sender}_${device}_m.call` });
const leaveEv = (sender: string, ts: number, device = "D") => ev(CALL_MEMBER_EVENT, sender, ts, {}, { state_key: `_${sender}_${device}_m.call` });
const ring = (sender: string, ts: number) => ev(RTC_NOTIFICATION_EVENT, sender, ts, { "m.mentions": { room: true, user_ids: [] }, notification_type: "ring", sender_ts: ts, lifetime: 45000, "m.call.intent": "audio" });

describe("network quality label (from measured RTT/loss/jitter)", () => {
  it("uses the documented thresholds; the worst metric wins and is named", () => {
    expect(QUALITY_THRESHOLDS.good).toEqual({ rttMs: 150, lossPct: 2, jitterMs: 30 });
    expect(classifyNetwork({ rttMs: 40, lossPct: 0, jitterMs: 5 })).toEqual({ label: "good", reasons: [] });
    const fair = classifyNetwork({ rttMs: 200, lossPct: 0.5, jitterMs: 5 });
    expect(fair.label).toBe("fair");
    expect(fair.reasons[0]).toMatch(/Round-trip time 200 ms/);
    expect(classifyNetwork({ rttMs: 40, lossPct: 7.5, jitterMs: 5 }).label).toBe("poor");
    expect(classifyNetwork({ rttMs: null, lossPct: null, jitterMs: null })).toEqual({ label: "unknown", reasons: [] });
  });
});

describe("getStats summaries", () => {
  const send = (bytes: number, packets: number, ts: number): StatRecord[] => [
    { id: "OT1", type: "outbound-rtp", kind: "audio", ssrc: 1, codecId: "C1", bytesSent: bytes, packetsSent: packets, timestamp: ts },
    { id: "C1", type: "codec", mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "minptime=10;usedtx=1;useinbandfec=1" },
    { id: "RI1", type: "remote-inbound-rtp", localId: "OT1", ssrc: 1, fractionLost: 0.05, jitter: 0.012, roundTripTime: 0.034 },
    { id: "T1", type: "transport", selectedCandidatePairId: "P1", iceState: "connected", dtlsState: "connected" },
    { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", currentRoundTripTime: 0.021, state: "succeeded" },
    { id: "L1", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls" },
    { id: "R1", type: "remote-candidate", candidateType: "host", protocol: "udp" },
  ];
  it("computes bitrate from two samples and reads the SFU's receiver report", () => {
    const s = summariseStream(send(26000, 500, 12000), send(1000, 0, 2000), "send")!;
    expect(s.codec).toBe("audio/opus");
    expect(s.kbps).toBe(20);
    expect(s.packetsPerSecond).toBe(50);
    expect(s.lossPct).toBe(5);
    expect(s.jitterMs).toBe(12);
    expect(s.rttMs).toBe(34);
    expect(summariseStream(send(1, 1, 1), null, "send")!.kbps).toBeNull();
  });
  it("detects a TURN relay and describes the path", () => {
    const t = transportInfo(send(1, 1, 1))!;
    expect(t.relayed).toBe(true);
    expect(t.rttMs).toBe(21);
    expect(describeCandidate(t.local)).toBe("TURN relay (TLS)");
    expect(describeCandidate({ type: "host", protocol: "udp", relayProtocol: null })).toBe("Direct (UDP)");
  });
  it("reports receive-side loss, concealment and decoded frames", () => {
    const recv = (lost: number, rx: number, dec: number, conc: number, total: number, ts: number): StatRecord[] => [
      { id: "IN", type: "inbound-rtp", kind: "video", codecId: "C", packetsLost: lost, packetsReceived: rx, bytesReceived: rx * 1000, framesDecoded: dec, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, jitter: 0.005, timestamp: ts },
      { id: "C", type: "codec", mimeType: "video/VP8", clockRate: 90000 },
    ];
    const s = summariseStream(recv(10, 190, 120, 0, 0, 4000), recv(0, 0, 60, 0, 0, 2000), "receive")!;
    expect(s.lossPct).toBe(5);
    expect(s.framesDecodedDelta).toBe(60);
    expect(s.width).toBe(1280);
    expect(s.jitterMs).toBe(5);
  });
});

describe("call preferences", () => {
  it("validate stored values and fall back to defaults", () => {
    expect(parseCallPrefs(null)).toEqual(DEFAULT_CALL_PREFS);
    expect(parseCallPrefs({ audioMode: "bogus", micDeviceId: 5, videoQuality: "8k", ringtone: "no" })).toEqual({ ...DEFAULT_CALL_PREFS, ringtone: true });
    expect(parseCallPrefs({ audioMode: "hifi", echoCancellation: true }).audioMode).toBe("hifi");
  });
  it("processing defaults: on for HD Voice, off for High-Fidelity, overridable", () => {
    expect(effectiveProcessing(DEFAULT_CALL_PREFS)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(effectiveProcessing({ ...DEFAULT_CALL_PREFS, audioMode: "hifi" })).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(effectiveProcessing({ ...DEFAULT_CALL_PREFS, audioMode: "hifi", echoCancellation: true }).echoCancellation).toBe(true);
  });
});

describe("media presets", () => {
  it("HD Voice: 40 kbit/s, DTX, mono; High-Fidelity: no DTX, stereo only with two captured channels", () => {
    expect(audioPublishOptions(DEFAULT_CALL_PREFS, 1)).toMatchObject({ audioPreset: { maxBitrate: HD_VOICE_MAX_BITRATE }, dtx: true, forceStereo: false });
    const hifi = { ...DEFAULT_CALL_PREFS, audioMode: "hifi" as const, hifiStereo: true };
    expect(audioPublishOptions(hifi, 2)).toMatchObject({ audioPreset: { maxBitrate: HIFI_STEREO_MAX_BITRATE }, dtx: false, forceStereo: true });
    expect(audioPublishOptions(hifi, 1)).toMatchObject({ audioPreset: { maxBitrate: HIFI_MONO_MAX_BITRATE }, forceStereo: false });
  });
  it("video quality profiles", () => {
    expect(resolveVideoProfile("standard")).toBe(VIDEO_PROFILES.standard);
    expect(VIDEO_PROFILES.hd.capture).toEqual({ width: 1280, height: 720, frameRate: 30 });
    expect([VIDEO_PROFILES.hd, VIDEO_PROFILES.highest]).toContain(resolveVideoProfile("auto"));
  });
  it("maps getUserMedia errors to actionable text", () => {
    expect(describeMediaError({ name: "NotAllowedError" }, "microphone")).toMatch(/blocked/);
    expect(describeMediaError({ name: "NotFoundError" }, "camera")).toMatch(/No camera was found/);
    expect(describeMediaError({ name: "NotReadableError" }, "microphone")).toMatch(/Another app/);
    expect(describeMediaError({ name: "OverconstrainedError" }, "camera")).toMatch(/can't provide/);
  });
});

describe("MatrixRTC helpers", () => {
  it("accepts only wss SFU URLs (ws only on loopback)", () => {
    expect(validLivekitUrl("wss://rtc.example.com")).toBe("wss://rtc.example.com");
    expect(validLivekitUrl("ws://rtc.example.com")).toBeNull();
    expect(validLivekitUrl("ws://127.0.0.1:7880")).toBe("ws://127.0.0.1:7880");
    expect(validLivekitUrl("https://rtc.example.com")).toBeNull();
    expect(validLivekitUrl(5)).toBeNull();
  });
  it("member id and JWT parsing", () => {
    expect(memberIdFor("@a:x", "DEV")).toBe("@a:x:DEV");
    const payload = btoa(JSON.stringify({ sub: "id", exp: 10, video: { room: "r" } })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(parseJwt(`h.${payload}.s`)).toEqual({ sub: "id", exp: 10, video: { room: "r" } });
  });
  it("focus = the oldest membership's LiveKit transport, else our own", () => {
    const own = { url: "wss://own", serverName: "own.org" };
    const m = (userId: string, ts: number, t: object | undefined) => ({ userId, createdTs: () => ts, getTransport: () => t }) as never;
    expect(selectFocus([], own).focus).toBe(own);
    const r = selectFocus([m("@b:new.org", 20, { type: "livekit", url: "wss://new" }), m("@a:old.org", 10, { type: "livekit", url: "wss://old" })], own);
    expect(r.focus).toEqual({ url: "wss://old", serverName: "old.org" });
    expect(selectFocus([m("@a:old.org", 10, { type: "livekit", livekit_service_url: "https://jwt" })], own).focus).toBe(own);
  });
  it("validates incoming ring notifications (expiry, sender, mentions, declines, membership)", () => {
    const now = Date.now();
    const n = ring("@a:x", now - 1000);
    const room = { roomId: "!r:x", getUnfilteredTimelineSet: () => ({ relations: { getChildEventsForEvent: () => undefined } }), getLiveTimeline: () => ({ getEvents: () => [] }) } as never;
    const session = (members: string[]) => ({ memberships: members.map((userId) => ({ userId })) }) as never;
    expect(validateNotification(n, room, "@b:x", session(["@a:x"]), now)).toMatchObject({ type: "ring", intent: "audio", sender: "@a:x" });
    expect(validateNotification(n, room, "@a:x", session(["@a:x"]), now)).toBeNull(); // own
    expect(validateNotification(n, room, "@b:x", session([]), now)).toBeNull(); // call already over
    expect(validateNotification(n, room, "@b:x", session(["@a:x", "@b:x"]), now)).toBeNull(); // already in it
    expect(validateNotification(n, room, "@b:x", session(["@a:x"]), now + 60_000)).toBeNull(); // expired
    const declined = { ...(room as object), getLiveTimeline: () => ({ getEvents: () => [ev(RTC_DECLINE_EVENT, "@b:x", now, { "m.relates_to": { rel_type: "m.reference", event_id: n.getId() } })] }) } as never;
    expect(validateNotification(n, declined, "@b:x", session(["@a:x"]), now)).toBeNull();
  });
});

describe("call history from the timeline", () => {
  it("groups membership events into calls and classifies them per user", () => {
    const events = [join("@a:x", 1000), ring("@a:x", 1100), join("@b:x", 5000), join("@a:x", 6000) /* renewal */, leaveEv("@b:x", 60_000), leaveEv("@a:x", 61_000)];
    const calls = buildCallHistory(events, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ startedBy: "@a:x", startTs: 1000, endTs: 61_000, participants: ["@a:x", "@b:x"], intent: "video", ongoing: false });
    expect(outcomeFor(calls[0], "@a:x")).toBe("outgoing");
    expect(outcomeFor(calls[0], "@b:x")).toBe("answered");
    expect(formatDuration((calls[0].endTs! - calls[0].startTs) / 1000)).toBe("1:00");
  });
  it("missed and declined calls; markers for the timeline", () => {
    const r = ring("@a:x", 1100);
    const missed = [join("@a:x", 1000), r, leaveEv("@a:x", 20_000)];
    const c = buildCallHistory(missed, 0)[0];
    expect(outcomeFor(c, "@b:x")).toBe("missed");
    const declinedEvents = [...missed.slice(0, 2), ev(RTC_DECLINE_EVENT, "@b:x", 3000, { "m.relates_to": { rel_type: "m.reference", event_id: r.getId() } }), missed[2]];
    expect(outcomeFor(buildCallHistory(declinedEvents, 0)[0], "@b:x")).toBe("declined");
    const markers = callMarkers(declinedEvents, buildCallHistory(declinedEvents, 0));
    const items = buildTimeline(declinedEvents, (u) => u, markers);
    expect(items.filter((i) => i.kind === "call").map((i) => (i.kind === "call" ? i.marker.kind : ""))).toEqual(["call-started", "call-declined", "call-ended"]);
    expect(unseenMissedCall(missed, "@b:x", 0, null)?.startTs).toBe(1000);
    expect(unseenMissedCall(missed, "@b:x", 0, missed[2].getId()!)).toBeNull(); // read past it
  });
  it("a call with no leave event but no live members is not ongoing", () => {
    expect(buildCallHistory([join("@a:x", 1000)], 0)[0].ongoing).toBe(false);
    expect(buildCallHistory([join("@a:x", 1000)], 1)[0].ongoing).toBe(true);
  });
});
