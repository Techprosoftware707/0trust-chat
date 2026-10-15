/**
 * Content-Security-Policy for the bundled web client and the desktop's own pages.
 *
 * The web client's policy mirrors the web deployment's (deploy/lib/render.py `chat_csp`) with
 * one deliberate difference: `connect-src` is not "https: wss:" but only the app origin, the
 * configured homeserver, the call SFU(s) and the portal. `form-action` is 'none' (the client
 * submits no HTML forms to a server).
 */
import { originOf } from "./url.ts";

export interface CspOrigins {
  homeserverUrl: string | null;
  /** wss:// LiveKit URLs */
  livekitUrls: string[];
  portalUrl: string | null;
}

/** For a wss:// SFU: the wss origin plus its https twin (LiveKit's HTTP validate/region endpoints). */
function sfuOrigins(url: string): string[] {
  const u = new URL(url);
  const https = `${u.protocol === "ws:" ? "http:" : "https:"}//${u.host}`;
  return [`${u.protocol}//${u.host}`, https];
}

export function connectSources(o: CspOrigins): string[] {
  const out = ["'self'"];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (o.homeserverUrl) add(originOf(o.homeserverUrl));
  for (const l of o.livekitUrls) for (const s of sfuOrigins(l)) add(s);
  if (o.portalUrl) add(originOf(o.portalUrl));
  // Attachments and media are decrypted into blob: URLs, which the client may fetch.
  add("blob:");
  return out;
}

export function buildWebClientCsp(o: CspOrigins): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connectSources(o).join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The desktop pages (server picker, lock screen, settings, screen picker): no network at all. */
export function buildDesktopPageCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export const PERMISSIONS_POLICY =
  "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=()";
