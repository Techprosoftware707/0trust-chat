/**
 * The narrow API that the Lumen desktop app (apps/desktop, Electron) gives the bundled web
 * client as `window.lumenDesktop`. The desktop app's preload script creates it with
 * `contextBridge`, and only for the app's own origin (`app://lumen`). In a normal browser it
 * does not exist.
 *
 * This file is the only definition of that contract. The desktop preload
 * (apps/desktop/src/preload/app.ts) is type-checked against it. It contains types only, no
 * code, so importing it has no effect on the web build.
 */

export interface DesktopNotification {
  title: string;
  body: string;
  /** Room to open when the notification is clicked. */
  roomId: string;
  silent: boolean;
}

/** How the desktop app protects the store key on disk. */
export interface DesktopStorageProtection {
  /**
   * "os": wrapped by the OS (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux).
   * "basic": Linux without a keyring: Chromium's fixed fallback key, i.e. effectively unprotected.
   * "unavailable": no protected storage; the web client falls back to its browser-only key.
   */
  level: "os" | "basic" | "unavailable";
  /** e.g. "dpapi", "keychain", "gnome_libsecret", "kwallet5", "basic_text". */
  backend: string;
}

export interface LumenDesktopApi {
  readonly version: 1;
  readonly platform: "win32" | "darwin" | "linux";
  /**
   * The 256-bit store key (raw bytes) that seals the session secrets (access token, crypto
   * store passphrase). The desktop app keeps it encrypted with the OS (Electron `safeStorage`).
   */
  readonly storeKey: {
    /** Creates a new random key, replacing any previous one (a new sign-in). */
    create(): Promise<Uint8Array>;
    /** The current key. Rejects if there is none. */
    get(): Promise<Uint8Array>;
    /** Deletes the key (sign-out). */
    destroy(): Promise<void>;
  };
  storageProtection(): Promise<DesktopStorageProtection>;
  readonly sso: {
    /**
     * Opens `<baseUrl>/_matrix/client/v3/login/sso/redirect[/<idpId>]` in the system browser
     * and resolves with the `loginToken` that comes back through the
     * `io.lumen.secure:/sso-callback` redirect (checked against a per-attempt nonce).
     */
    start(baseUrl: string, idpId: string | null): Promise<string>;
    /** Abandons the pending attempt (its callback will be ignored). */
    cancel(): void;
  };
  readonly notifications: {
    show(n: DesktopNotification): void;
    /** Called with the room ID when the user clicks one of our notifications. Returns an unsubscribe function. */
    onClick(cb: (roomId: string) => void): () => void;
  };
  /** Unread conversations, for the dock/taskbar badge. */
  setUnreadCount(n: number): void;
  /**
   * The web client has wiped its local data (sign-out): the app deletes the store key and
   * clears the browser storage of the app origin. Resolves when that is done.
   */
  signedOut(): Promise<void>;
  /**
   * Registers what the app runs before it switches servers ("Change server…"): sign out on
   * the server and wipe local data. Returns an unsubscribe function.
   */
  onSignOutRequest(handler: () => Promise<void>): () => void;
  /** The LiveKit transport URLs the homeserver advertised after sign-in (MSC4143 `/rtc/transports`). */
  reportRtcTransports(urls: string[]): void;
}
