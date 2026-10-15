import { describe, expect, it, vi } from "vitest";
import { ConnectionQuality } from "livekit-client";
import type { CallParticipant, CallSnapshot } from "../../src/calls/CallSession";
import { callE2eeWire, callEncryptionLabel } from "../../src/calls/e2ee";
import { callActionOf, findNativeHost, installBridge, isForDriver, postCallState } from "../../src/widget/bridge";
import { toCallState } from "../../src/widget/callState";
import { widgetCapabilities } from "../../src/widget/capabilities";
import { parseWidgetParams, WidgetParamError } from "../../src/widget/params";

const ORIGIN = "https://appassets.androidplatform.net";
const U = "@alice:example.com";
const D = "ABCDEFGHIJ";

/** The URL the Android app builds (CallWidgetHost / CallWidgetUrl.rawUrl) after generateWebviewUrl. */
const androidSearch = (over: Record<string, string> = {}) =>
  "?" +
  new URLSearchParams({
    widgetId: "8a3f",
    parentUrl: ORIGIN,
    roomId: "!Wp9XYHD8Kcdce8McLrk82ioKyuvh5fn3Z5YnxCDtknw",
    userId: U,
    deviceId: D,
    baseUrl: "https://matrix.example.com/",
    lang: "de-DE",
    theme: "dark",
    intent: "start_call",
    video: "true",
    notify: "ring",
    ...over,
  }).toString();

describe("call widget URL parameters (integration.md §6.2)", () => {
  it("reads what generateWebviewUrl fills in (room v12 IDs have no server part)", () => {
    const p = parseWidgetParams(androidSearch(), ORIGIN, true);
    expect(p).toEqual({
      widgetId: "8a3f",
      parentOrigin: ORIGIN,
      roomId: "!Wp9XYHD8Kcdce8McLrk82ioKyuvh5fn3Z5YnxCDtknw",
      userId: U,
      deviceId: D,
      baseUrl: "https://matrix.example.com",
      serverName: "example.com",
      lang: "de-DE",
      theme: "dark",
      intent: "start_call",
      video: true,
      notify: "ring",
    });
  });

  it("refuses placeholders the SDK didn't substitute, and missing values", () => {
    expect(() => parseWidgetParams(androidSearch({ deviceId: "$org.matrix.msc3819.matrix_device_id" }), ORIGIN, true)).toThrow(/deviceId.*not filled in/);
    expect(() => parseWidgetParams(androidSearch({ roomId: "" }), ORIGIN, true)).toThrow(WidgetParamError);
    expect(() => parseWidgetParams(androidSearch({ userId: "alice" }), ORIGIN, true)).toThrow(/user ID/);
    expect(() => parseWidgetParams(androidSearch({ roomId: "#alias:example.com" }), ORIGIN, true)).toThrow(/room ID/);
  });

  it("in a native WebView the widget only talks to its own origin", () => {
    expect(() => parseWidgetParams(androidSearch({ parentUrl: "https://evil.example" }), ORIGIN, true)).toThrow(/parentUrl/);
    // inside an iframe the parent is someone else (not used by the apps, still well-defined)
    expect(parseWidgetParams(androidSearch({ parentUrl: "https://app.example.com/x" }), ORIGIN, false).parentOrigin).toBe("https://app.example.com");
  });

  it("requires an https homeserver URL (http only on loopback) without credentials", () => {
    expect(() => parseWidgetParams(androidSearch({ baseUrl: "http://matrix.example.com" }), ORIGIN, true)).toThrow(/https/);
    expect(() => parseWidgetParams(androidSearch({ baseUrl: "https://u:p@matrix.example.com" }), ORIGIN, true)).toThrow(/credentials/);
    expect(parseWidgetParams(androidSearch({ baseUrl: "http://localhost:8008" }), ORIGIN, true).baseUrl).toBe("http://localhost:8008");
  });

  it("falls back to safe defaults for the optional parameters", () => {
    const p = parseWidgetParams(androidSearch({ lang: "<script>", theme: "neon", intent: "x", video: "1", notify: "loud" }), ORIGIN, true);
    expect([p.lang, p.theme, p.intent, p.video, p.notify]).toEqual(["en-US", "light", "join_existing", false, "none"]);
  });
});

describe("native bridge (widget side)", () => {
  const req = { api: "fromWidget", widgetId: "w", requestId: "r1", action: "send_event", data: {} };
  it("forwards exactly fromWidget requests and toWidget responses", () => {
    expect(isForDriver(req)).toBe(true);
    expect(isForDriver({ ...req, response: {} })).toBe(false); // the driver's own answer coming back
    expect(isForDriver({ ...req, api: "toWidget", action: "capabilities", response: { capabilities: [] } })).toBe(true);
    expect(isForDriver({ ...req, api: "toWidget", action: "capabilities" })).toBe(false); // the driver's request
    expect(isForDriver({ ...req, requestId: undefined })).toBe(false);
    expect(isForDriver({ api: "toWidget", widgetId: "w", requestId: "r", action: "io.lumen.call_action", response: {} })).toBe(false);
    expect(isForDriver("{\"api\":\"fromWidget\"}")).toBe(false);
  });

  it("accepts the call actions the apps send ({type, action}, not a widget-API message)", () => {
    expect(callActionOf({ type: "io.lumen.call_action", action: "hangup" })).toBe("hangup");
    expect(callActionOf({ type: "io.lumen.call_action", action: "switch_camera" })).toBe("switch_camera");
    expect(callActionOf({ type: "io.lumen.call_action", data: { action: "mute" } })).toBe("mute");
    expect(callActionOf({ type: "io.lumen.call_action", api: "toWidget", action: "mute" })).toBeNull();
    expect(callActionOf({ type: "io.lumen.call_action", action: "format_disk" })).toBeNull();
    expect(callActionOf({ type: "other", action: "hangup" })).toBeNull();
  });

  it("finds the Android and iOS native objects", () => {
    const post = vi.fn();
    expect(findNativeHost({ lumenNative: { postMessage: post } } as unknown as Window)?.kind).toBe("android");
    expect(findNativeHost({ webkit: { messageHandlers: { lumenNative: { postMessage: post } } } } as unknown as Window)?.kind).toBe("ios");
    expect(findNativeHost({} as Window)).toBeNull();
  });

  it("forwards only this window's own messages to native and dispatches actions", () => {
    const sent: string[] = [];
    const actions: string[] = [];
    const off = installBridge({ kind: "android", postMessage: (j) => sent.push(j) }, (a) => actions.push(a));
    const fire = (data: unknown, origin = window.location.origin, source: MessageEventSource | null = window) => window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    fire(req);
    fire({ ...req, requestId: "other-origin" }, "https://evil.example");
    fire({ ...req, requestId: "other-source" }, window.location.origin, null);
    fire({ ...req, api: "toWidget", action: "notify_capabilities" }); // a driver request delivered by native
    fire({ type: "io.lumen.call_action", action: "hangup" });
    fire({ type: "io.lumen.call_action", action: "hangup" }, "https://evil.example");
    off();
    fire(req);
    expect(sent.map((s) => JSON.parse(s).requestId)).toEqual(["r1"]);
    expect(actions).toEqual(["hangup"]);
  });

  it("sends call state in the envelope of integration.md §6.2", () => {
    const sent: string[] = [];
    postCallState({ kind: "ios", postMessage: (j) => sent.push(j) }, { state: "connected", video: true, muted: false, e2ee: "encrypted" });
    expect(JSON.parse(sent[0])).toEqual({ type: "io.lumen.call_state", state: "connected", video: true, muted: false, e2ee: "encrypted" });
    expect(() => postCallState(null, { state: "connected" })).not.toThrow();
  });
});

const participant = (over: Partial<CallParticipant>): CallParticipant => ({
  identity: "id",
  userId: "@bob:example.com",
  deviceId: "B",
  name: "Bob",
  isLocal: false,
  pending: false,
  micTrack: null,
  micMuted: false,
  cameraTrack: null,
  cameraMuted: true,
  screenTrack: null,
  screenAudioTrack: null,
  speaking: false,
  quality: ConnectionQuality.Good,
  encryption: "encrypted",
  keyIndex: 0,
  keyOverdue: false,
  ...over,
});

const snap = (over: Partial<CallSnapshot> = {}, e2ee: Partial<CallSnapshot["e2ee"]> = {}): CallSnapshot => ({
  roomId: "!r",
  intent: "video",
  isDm: true,
  phase: "connected",
  connectedAt: 1,
  error: null,
  endReason: null,
  notice: null,
  ringing: false,
  focusUrl: "wss://rtc.example.com",
  localIdentity: "me",
  participants: [],
  mic: { state: "on", error: null, label: null },
  camera: { state: "on", error: null, label: null },
  screen: { active: false, error: null, hasAudio: false },
  speakerDeviceId: null,
  audioPlaybackBlocked: false,
  e2ee: { enabled: true, ownKey: true, ownKeyIndex: 0, remoteTotal: 1, remoteEncrypted: 1, remoteWaiting: 0, unknownConnections: 0, ...e2ee },
  events: [],
  reconnects: 0,
  stats: null,
  codec: null,
  videoProfile: null,
  audioMode: "voice",
  ...over,
});

describe("call encryption label (shared by the call screen and io.lumen.call_state)", () => {
  it("is 'encrypted' only when every remote participant's media decrypts with a Matrix key", () => {
    expect([callEncryptionLabel(snap()), callE2eeWire(snap())]).toEqual(["encrypted", "encrypted"]);
    expect([callEncryptionLabel(snap({}, { remoteEncrypted: 0, remoteWaiting: 1 })), callE2eeWire(snap({}, { remoteEncrypted: 0, remoteWaiting: 1 }))]).toEqual(["exchanging-keys", "waiting-for-key"]);
    expect([callEncryptionLabel(snap({}, { ownKey: false })), callE2eeWire(snap({}, { ownKey: false }))]).toEqual(["setting-up", "waiting-for-key"]);
    expect([callEncryptionLabel(snap({}, { remoteTotal: 0, remoteEncrypted: 0 })), callE2eeWire(snap({}, { remoteTotal: 0, remoteEncrypted: 0 }))]).toEqual(["ready", "waiting-for-key"]);
    expect([callEncryptionLabel(snap({}, { enabled: false })), callE2eeWire(snap({}, { enabled: false }))]).toEqual(["not-encrypted", "not-encrypted"]);
    expect(callE2eeWire(snap({ phase: "connecting" }, { enabled: false }))).toBe("unknown");
    expect([callEncryptionLabel(snap({ phase: "ended" })), callE2eeWire(snap({ phase: "ended" }))]).toEqual(["none", "unknown"]);
  });

  it("names the reason when a remote participant's media isn't decrypting", () => {
    const incomplete = (encryption: CallParticipant["encryption"]) => snap({ participants: [participant({ encryption })] }, { remoteEncrypted: 0 });
    expect(callEncryptionLabel(incomplete("decrypt-error"))).toBe("incomplete");
    expect(callE2eeWire(incomplete("decrypt-error"))).toBe("decrypt-error");
    expect(callE2eeWire(incomplete("not-encrypted"))).toBe("not-encrypted");
    expect(callE2eeWire(incomplete("waiting-for-key"))).toBe("waiting-for-key");
  });
});

describe("io.lumen.call_state", () => {
  it("maps the session snapshot without keys, names or IDs", () => {
    const m = toCallState(snap({ participants: [participant({})], mic: { state: "muted", error: null, label: "Mic" } }));
    expect(m).toEqual({ state: "connected", video: true, muted: true, e2ee: "encrypted", e2eeLabel: "encrypted", remoteTotal: 1, remoteEncrypted: 1, ringing: false, reason: null, error: false });
    expect(toCallState(snap({ phase: "starting" })).state).toBe("connecting");
    expect(toCallState(snap({ phase: "ended", endReason: "The other person left the call" }))).toMatchObject({ state: "ended", reason: "The other person left the call", error: false });
    expect(toCallState(snap({ phase: "ended", endReason: "x", error: "x" })).error).toBe(true);
    expect(JSON.stringify(toCallState(snap({ participants: [participant({})] })))).not.toMatch(/@bob|Bob|id"/);
  });
});

describe("widget capabilities", () => {
  /** getElementCallRequiredPermissions(userId, deviceId) of matrix-sdk-ffi (rev 2a3db80e), as strings */
  const granted = (u: string, d: string) => {
    const ss = "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#";
    const rs = ["org.matrix.rageshake_request", "io.element.call.encryption_keys", "io.element.call.reaction", "m.reaction", "m.room.redaction", "org.matrix.msc4310.rtc.decline"];
    return new Set([
      ...["org.matrix.msc3401.call.member", "m.room.name", "m.room.member", "m.room.encryption", "m.room.create"].map((t) => `org.matrix.msc2762.receive.state_event:${t}`),
      ...rs.map((t) => `org.matrix.msc2762.receive.event:${t}`),
      ...rs.map((t) => `org.matrix.msc2762.send.event:${t}`),
      "org.matrix.msc2762.send.event:org.matrix.msc4075.rtc.notification",
      "org.matrix.msc2762.send.event:org.matrix.msc4075.call.notify",
      ...[u, `${u}_${d}`, `${u}_${d}_m.call`, `_${u}_${d}`, `_${u}_${d}_m.call`].map((k) => ss + k),
      "org.matrix.msc3819.receive.to_device:io.element.call.encryption_keys",
      "org.matrix.msc3819.send.to_device:io.element.call.encryption_keys",
    ]);
  };

  it("asks only for what the apps grant (plus the SFU token the native layer serves)", () => {
    const c = widgetCapabilities({ userId: U, deviceId: D });
    const asked = [
      ...(c.receiveState ?? []).map((s) => `org.matrix.msc2762.receive.state_event:${s.eventType}${s.stateKey === undefined ? "" : `#${s.stateKey}`}`),
      ...(c.sendState ?? []).map((s) => `org.matrix.msc2762.send.state_event:${s.eventType}${s.stateKey === undefined ? "" : `#${s.stateKey}`}`),
      ...(c.sendEvent ?? []).map((t) => `org.matrix.msc2762.send.event:${t}`),
      ...(c.receiveEvent ?? []).map((t) => `org.matrix.msc2762.receive.event:${t}`),
      ...(c.sendToDevice ?? []).map((t) => `org.matrix.msc3819.send.to_device:${t}`),
      ...(c.receiveToDevice ?? []).map((t) => `org.matrix.msc3819.receive.to_device:${t}`),
    ];
    const g = granted(U, D);
    expect(asked.filter((x) => !g.has(x))).toEqual([]);
    expect(c.sendMessage).toBeUndefined();
    expect(c.receiveMessage).toBeUndefined();
    expect(c.turnServers).toBeFalsy();
    expect(c.rtcLivekitDelegateDelayedLeave).toBeFalsy();
    expect([c.sendDelayedEvents, c.updateDelayedEvents, c.rtcTransports, c.rtcLivekitGetToken]).toEqual([true, true, true, true]);
    // never someone else's membership
    expect((c.sendState ?? []).every((s) => s.stateKey?.includes(`${U}_${D}`))).toBe(true);
  });
});
