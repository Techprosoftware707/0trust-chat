/**
 * The call widget's URL parameters (docs/apps/integration.md §6.2), filled in by the native
 * app with the Rust SDK's `generateWebviewUrl`. Everything is validated before use; the
 * widget refuses to start with anything malformed or still unsubstituted.
 */
import { isLoopbackHost } from "../config";

export interface WidgetParams {
  widgetId: string;
  /** origin the widget API talks to (the page itself in a native WebView) */
  parentOrigin: string;
  roomId: string;
  userId: string;
  deviceId: string;
  /** homeserver base URL (for display / server name only: the widget never calls it) */
  baseUrl: string;
  serverName: string;
  lang: string;
  theme: "light" | "dark";
  intent: "start_call" | "join_existing";
  video: boolean;
  notify: "ring" | "notification" | "none";
}

export class WidgetParamError extends Error {
  override name = "WidgetParamError";
}

const PRINTABLE = /^[\x21-\x7e]+$/;

function required(q: URLSearchParams, key: string): string {
  const v = q.get(key);
  if (!v) throw new WidgetParamError(`Missing widget parameter "${key}".`);
  // `generateWebviewUrl` replaces `$placeholders`; one left over means the URL template is wrong.
  if (v.startsWith("$")) throw new WidgetParamError(`Widget parameter "${key}" was not filled in.`);
  if (v.length > 512 || !PRINTABLE.test(v)) throw new WidgetParamError(`Widget parameter "${key}" is invalid.`);
  return v;
}

/**
 * @param search    `location.search`
 * @param ownOrigin `location.origin`
 * @param topLevel  the page is the top-level document (a native WebView), not an iframe
 */
export function parseWidgetParams(search: string, ownOrigin: string, topLevel: boolean): WidgetParams {
  const q = new URLSearchParams(search);
  const widgetId = required(q, "widgetId");
  const roomId = required(q, "roomId");
  if (!/^![^\s]+$/.test(roomId)) throw new WidgetParamError("Widget parameter \"roomId\" is not a room ID.");
  const userId = required(q, "userId");
  const userMatch = /^@[^:\s]+:([A-Za-z0-9.\-:[\]]+)$/.exec(userId);
  if (!userMatch) throw new WidgetParamError("Widget parameter \"userId\" is not a Matrix user ID.");
  const deviceId = required(q, "deviceId");

  let base: URL;
  try {
    base = new URL(required(q, "baseUrl"));
  } catch (e) {
    if (e instanceof WidgetParamError) throw e;
    throw new WidgetParamError("Widget parameter \"baseUrl\" is not a URL.");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHost(base.hostname))) throw new WidgetParamError("The homeserver URL must use https.");
  if (base.username || base.password) throw new WidgetParamError("The homeserver URL must not contain credentials.");

  let parentOrigin: string;
  try {
    parentOrigin = new URL(required(q, "parentUrl")).origin;
  } catch (e) {
    if (e instanceof WidgetParamError) throw e;
    throw new WidgetParamError("Widget parameter \"parentUrl\" is not a URL.");
  }
  // In a native WebView the widget is the top-level page and talks to itself (the native
  // bridge listens there); any other parent origin would send widget messages elsewhere.
  if (topLevel && parentOrigin !== ownOrigin) throw new WidgetParamError("Widget parameter \"parentUrl\" doesn't match this page.");

  const lang = q.get("lang") && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(q.get("lang")!) ? q.get("lang")! : "en-US";
  const theme = q.get("theme") === "dark" ? "dark" : "light";
  const intent = q.get("intent") === "start_call" ? "start_call" : "join_existing";
  const video = q.get("video") === "true";
  const n = q.get("notify");
  const notify = n === "ring" || n === "notification" ? n : "none";
  return {
    widgetId,
    parentOrigin,
    roomId,
    userId,
    deviceId,
    baseUrl: base.toString().replace(/\/+$/, ""),
    serverName: userMatch[1],
    lang,
    theme,
    intent,
    video,
    notify,
  };
}
