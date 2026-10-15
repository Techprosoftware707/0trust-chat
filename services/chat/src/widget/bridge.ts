/**
 * The widget side of the native bridge (docs/apps/integration.md §6.2), the scheme Element X
 * uses, so it works with stock matrix-widget-api:
 *
 *  - widget → native: the widget API posts its messages to `window.parent`, which in a
 *    top-level WebView is this page. Every message that is a `fromWidget` request or a
 *    `toWidget` response is forwarded, as JSON text, to the native object:
 *      Android  window.lumenNative.postMessage(json)                (addWebMessageListener)
 *      iOS      window.webkit.messageHandlers.lumenNative.postMessage(json)
 *    Native hands it to `WidgetDriverHandle.send`.
 *  - native → widget: native delivers each `WidgetDriverHandle.recv` string with
 *    `window.postMessage(<json>, "<widget origin>")`; the widget API picks those up itself.
 *  - `io.lumen.call_state` (widget → native, posted to the native object:
 *    `{"type": "io.lumen.call_state", "state", "video", "muted", "e2ee", …}`) and
 *    `io.lumen.call_action` (native → widget via window.postMessage:
 *    `{"type": "io.lumen.call_action", "action"}`) carry call state and native controls
 *    (CallKit / ConnectionService, headset buttons). Neither is a widget-API message, and
 *    neither ever contains keys or tokens.
 */

export interface NativeHost {
  kind: "android" | "ios";
  postMessage(json: string): void;
}

type PostTarget = { postMessage: (m: string) => void };

export function findNativeHost(w: Window = window): NativeHost | null {
  const android = (w as unknown as { lumenNative?: PostTarget }).lumenNative;
  if (android && typeof android.postMessage === "function") return { kind: "android", postMessage: (j) => android.postMessage(j) };
  const ios = (w as unknown as { webkit?: { messageHandlers?: { lumenNative?: PostTarget } } }).webkit?.messageHandlers?.lumenNative;
  if (ios && typeof ios.postMessage === "function") return { kind: "ios", postMessage: (j) => ios.postMessage(j) };
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const CALL_STATE_TYPE = "io.lumen.call_state";
export const CALL_ACTION_TYPE = "io.lumen.call_action";

/** A widget-API message the native side must pass to the widget driver. */
export function isForDriver(data: unknown): boolean {
  if (!isObj(data) || typeof data.action !== "string" || typeof data.requestId !== "string" || typeof data.widgetId !== "string") return false;
  // Lumen's own messages (and the widget API's replies to them) are not the driver's business.
  if (data.action.startsWith("io.lumen.")) return false;
  const isResponse = data.response !== undefined;
  return (data.api === "fromWidget" && !isResponse) || (data.api === "toWidget" && isResponse);
}

export const CALL_ACTIONS = ["hangup", "mute", "unmute", "video_on", "video_off", "switch_camera"] as const;
export type CallAction = (typeof CALL_ACTIONS)[number];

/**
 * A native call action: `{"type": "io.lumen.call_action", "action": …}` (integration.md §6.2;
 * the action may also be nested under `data`, as the apps accept for call state).
 */
export function callActionOf(data: unknown): CallAction | null {
  if (!isObj(data) || data.type !== CALL_ACTION_TYPE || data.api !== undefined) return null;
  const a = typeof data.action === "string" ? data.action : isObj(data.data) ? data.data.action : undefined;
  return typeof a === "string" && (CALL_ACTIONS as readonly string[]).includes(a) ? (a as CallAction) : null;
}

/**
 * Forwards widget-API traffic to the native host and dispatches native call actions. Only
 * messages this window posted to itself are considered (the widget API and native's
 * evaluateJavascript both post from this window); other windows and frames are ignored.
 */
export function installBridge(host: NativeHost | null, onAction: (a: CallAction) => void, w: Window = window): () => void {
  const listener = (ev: MessageEvent) => {
    if (ev.source !== w || ev.origin !== w.location.origin) return;
    if (host && isForDriver(ev.data)) {
      host.postMessage(JSON.stringify(ev.data));
      return;
    }
    const action = callActionOf(ev.data);
    if (action) onAction(action);
  };
  w.addEventListener("message", listener);
  return () => w.removeEventListener("message", listener);
}

/** `{"type": "io.lumen.call_state", "state", "video", "muted", "e2ee", …}` to the native object. */
export function postCallState(host: NativeHost | null, state: object): void {
  host?.postMessage(JSON.stringify({ type: CALL_STATE_TYPE, ...state }));
}
