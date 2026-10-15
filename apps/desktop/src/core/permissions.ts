/**
 * Permission policy for web content (Electron session permission handlers).
 *
 * Granted only to the bundled web client (origin app://lumen, top-level frame of the main
 * window):
 *   - media                       camera and microphone (calls)
 *   - notifications               message notifications
 *   - clipboard-sanitized-write   "Copy" buttons (recovery key, IDs); write only, never read
 *   - fullscreen                  the call screen's full-screen button
 *   - speaker-selection           choosing the audio output device in calls
 * Screen sharing goes through the display-media handler (a source picker the user drives).
 * Everything else (geolocation, clipboard read, MIDI, HID/USB/serial, idle detection,
 * window management, storage access, openExternal, ...) is denied, and every other origin
 * (including the desktop's own pages) gets nothing.
 */

export const APP_ORIGIN = "app://lumen";
export const DESKTOP_PAGES_ORIGIN = "app://desktop";

const GRANTED = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen", "speaker-selection"]);

export interface PermissionRequest {
  permission: string;
  /** Origin of the requesting frame (Electron `details.requestingUrl` / `requestingOrigin`). */
  origin: string | null;
  /** The request comes from the main window's web contents. */
  fromAppWindow: boolean;
  /** The requesting frame is the top-level frame. */
  isMainFrame: boolean;
  /** For "media": which kinds ("audio", "video"). */
  mediaTypes?: readonly string[];
}

function normaliseOrigin(o: string | null): string | null {
  if (!o) return null;
  try {
    const u = new URL(o);
    // Node's URL gives "null" as the origin of schemes it doesn't know as special; Chromium
    // treats app: as a standard scheme (registered privileged), whose origin is scheme://host.
    if (u.origin !== "null") return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

export function isAppOrigin(o: string | null): boolean {
  return normaliseOrigin(o) === APP_ORIGIN;
}

export function allowPermissionRequest(r: PermissionRequest): boolean {
  if (!r.fromAppWindow || !r.isMainFrame || !isAppOrigin(r.origin)) return false;
  if (!GRANTED.has(r.permission)) return false;
  if (r.permission === "media") {
    const types = r.mediaTypes ?? [];
    // An empty list means "unspecified" in some Electron versions: still camera/mic only.
    return types.every((t) => t === "audio" || t === "video");
  }
  return true;
}

/** Synchronous permission checks (navigator.permissions.query, enumerateDevices labels, Notification.permission). */
export function allowPermissionCheck(r: Omit<PermissionRequest, "isMainFrame"> & { isMainFrame?: boolean }): boolean {
  if (!r.fromAppWindow || !isAppOrigin(r.origin)) return false;
  return GRANTED.has(r.permission);
}

/** getDisplayMedia: only the web client's top-level frame, only with a user gesture. */
export function allowDisplayMediaRequest(r: { origin: string | null; fromAppWindow: boolean; isMainFrame: boolean; userGesture: boolean }): boolean {
  return r.fromAppWindow && r.isMainFrame && r.userGesture && isAppOrigin(r.origin);
}
