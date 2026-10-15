/**
 * Entry point of the Lumen call widget (docs/apps/integration.md §6.2): the web client's call
 * implementation (CallSession, MatrixRTC, livekit-client with frame encryption, call screen)
 * running in the mobile apps' WebView on matrix-js-sdk's RoomWidgetClient. The native app
 * connects it to the user's session through the Matrix Rust SDK's widget driver, so this page
 * never holds an access token or the account's keys: it can do exactly what the driver's
 * capabilities allow (call membership in this room, media keys as encrypted to-device
 * messages, delayed leave events, RTC transports, the SFU token).
 */
import { createRoot } from "react-dom/client";
import { WidgetApi } from "matrix-widget-api";
import { createRoomWidgetClient, KnownMembership, RoomEvent, type Room } from "matrix-js-sdk";
import "../styles/app.css";
import "./widget.css";
import { startCall } from "../calls/controller";
import { setCallPrefsUser } from "../calls/prefs";
import { getActiveCall } from "../calls/store";
import type { AppConfig } from "../config";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { errorMessage } from "../lib/errors";
import { configureSdkLogging } from "../lib/logger";
import { findNativeHost, installBridge, postCallState, type CallAction } from "./bridge";
import { applyCallAction, type CallStateMessage } from "./callState";
import { widgetCapabilities } from "./capabilities";
import { parseWidgetParams, type WidgetParams } from "./params";
import { WidgetApp, WidgetStatus } from "./WidgetApp";

configureSdkLogging(import.meta.env.PROD ? "error" : "warn");

/** How long the native side may take to negotiate capabilities and send the room state. */
const STARTUP_TIMEOUT_MS = 30_000;

/** The web app reads its deployment settings from /config.json; the widget has them from its URL. */
function widgetConfig(p: WidgetParams): AppConfig {
  return {
    brand: { name: "Lumen Secure", shortName: "Lumen" },
    homeserver: { baseUrl: p.baseUrl, serverName: p.serverName },
    sso: null,
    portalUrl: null,
    allowCustomHomeserver: false,
    calls: { enabled: true, rtcDomain: null },
    privacyUrl: null,
    helpUrl: null,
  };
}

const host = findNativeHost();
const root = createRoot(document.getElementById("root")!);
let hangUpBeforeStart = false;

const emit = (m: CallStateMessage) => postCallState(host, m);
const startupState = (state: "connecting" | "ended", reason: string | null = null, video = false, error = false): CallStateMessage => ({
  state,
  video,
  muted: false,
  e2ee: "unknown",
  e2eeLabel: "none",
  remoteTotal: 0,
  remoteEncrypted: 0,
  ringing: false,
  reason,
  error,
});

function fail(title: string, detail: string, error = true): void {
  root.render(<WidgetStatus title={title} detail={detail} />);
  emit(startupState("ended", detail, false, error));
}

installBridge(host, (action: CallAction) => {
  const session = getActiveCall();
  if (session && session.getSnapshot().phase !== "ended") void applyCallAction(session, action).catch(() => undefined);
  else if (action === "hangup") hangUpBeforeStart = true;
});

/**
 * matrix-widget-api 1.20's transport console.logs every message object it posts, including
 * to-device payloads with media keys. The widget posts them unlogged (same postMessage call).
 */
function quietTransport(api: WidgetApi): void {
  const t = api.transport as unknown as { sendInternal?: unknown; transportWindow?: Window; targetOrigin?: string };
  if (typeof t.sendInternal !== "function" || !t.transportWindow || typeof t.targetOrigin !== "string") return;
  const target = t.transportWindow;
  const origin = t.targetOrigin;
  t.sendInternal = (message: unknown) => target.postMessage(message, origin);
}

/**
 * RoomWidgetClient.startClient() resolves on the driver's first `update_state` before its own
 * handler has applied it, so our membership may not be known yet: wait for it (briefly).
 */
function joined(room: Room, ms: number): Promise<boolean> {
  if (room.getMyMembership() === KnownMembership.Join) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      room.off(RoomEvent.MyMembership, on);
      resolve(ok);
    };
    const on = (_r: Room, membership: string) => {
      if (membership === KnownMembership.Join) done(true);
    };
    const t = setTimeout(() => done(room.getMyMembership() === KnownMembership.Join), ms);
    room.on(RoomEvent.MyMembership, on);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function boot(): Promise<void> {
  const topLevel = window.parent === window;
  let p: WidgetParams;
  try {
    p = parseWidgetParams(location.search, location.origin, topLevel);
  } catch (e) {
    fail("Couldn't open the call", errorMessage(e));
    return;
  }
  document.documentElement.setAttribute("data-theme", p.theme);
  document.documentElement.lang = p.lang;
  if (topLevel && !host) {
    fail("Couldn't open the call", "This page only works inside the Lumen app.");
    return;
  }
  root.render(<WidgetStatus title="Joining the call…" busy />);
  emit(startupState("connecting", null, p.video));

  const api = new WidgetApi(p.widgetId, p.parentOrigin);
  quietTransport(api);
  // The apps create the driver with initAfterContentLoad = true: `sendContentLoaded` (last
  // argument) sends `content_loaded` once the widget API is listening, which starts the
  // capability negotiation.
  const client = createRoomWidgetClient(api, widgetCapabilities(p), p.roomId, { baseUrl: p.baseUrl, userId: p.userId, deviceId: p.deviceId, timelineSupport: true }, true);
  setCallPrefsUser(p.userId);
  try {
    await withTimeout(client.startClient(), STARTUP_TIMEOUT_MS, "The app didn't connect the call to your account in time.");
  } catch (e) {
    fail("Couldn't open the call", errorMessage(e));
    return;
  }
  const room = client.getRoom(p.roomId);
  if (!room) {
    fail("Couldn't open the call", "The conversation isn't available.");
    return;
  }
  root.render(
    <ErrorBoundary>
      <WidgetApp client={client} config={widgetConfig(p)} onCallState={emit} />
    </ErrorBoundary>,
  );
  await joined(room, 10_000);
  if (hangUpBeforeStart) {
    fail("Call ended", "You left the call.", false);
    return;
  }
  await startCall(client, widgetConfig(p), room, { intent: p.video ? "video" : "audio", notify: p.intent === "start_call" && p.notify !== "none" });
}

void boot();
