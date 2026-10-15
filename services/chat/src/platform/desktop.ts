/**
 * Integration with the Lumen desktop app (apps/desktop). In a normal browser
 * `window.lumenDesktop` does not exist and everything here is a no-op, so the web app's
 * behaviour is unchanged.
 */
import { useEffect } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { LumenDesktopApi } from "./desktop-api";

export type { LumenDesktopApi } from "./desktop-api";

declare global {
  interface Window {
    lumenDesktop?: LumenDesktopApi;
  }
}

/** The desktop app's API, or null when running in a browser. */
export function desktopApi(): LumenDesktopApi | null {
  if (typeof window === "undefined") return null;
  const d = window.lumenDesktop;
  return d && d.version === 1 ? d : null;
}

export function isDesktop(): boolean {
  return desktopApi() !== null;
}

/**
 * Imports the desktop store key (32 raw bytes) as a non-extractable AES-GCM key and wipes
 * the copies of the raw bytes.
 */
export async function importDesktopStoreKey(raw: Uint8Array): Promise<CryptoKey> {
  const bytes = new Uint8Array(raw);
  raw.fill(0);
  try {
    if (bytes.byteLength !== 32) throw new Error("Invalid store key");
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Desktop wiring for the signed-in app: unread badge, "Change server…" sign-out, and the
 * call transports the homeserver advertises (they extend the app's Content-Security-Policy).
 */
export function useDesktopIntegration(client: MatrixClient, unreadConversations: number, signOutAndWipe: () => Promise<void>): void {
  const d = desktopApi();
  useEffect(() => {
    d?.setUnreadCount(unreadConversations);
  }, [d, unreadConversations]);
  useEffect(() => (d ? d.onSignOutRequest(signOutAndWipe) : undefined), [d, signOutAndWipe]);
  useEffect(() => {
    if (!d) return;
    let alive = true;
    client
      ._unstable_getRTCTransports()
      .then((transports) => {
        const urls = (transports ?? []).filter((t) => t?.type === "livekit" && typeof t.url === "string").map((t) => t.url as string);
        if (alive && urls.length) d.reportRtcTransports(urls);
      })
      .catch(() => undefined); // not advertised: calls use the configured fallback, if any
    return () => {
      alive = false;
      d.setUnreadCount(0);
    };
  }, [d, client]);
}
