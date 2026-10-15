/** Desktop-app integration (window.lumenDesktop) of the session store and sign-in helpers. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDb, idbGet, openDb } from "../../src/lib/idb";
import { clearSession, loadSession, saveSession } from "../../src/lib/session-store";
import { deviceDisplayName, startDesktopSso } from "../../src/matrix/login";
import { desktopApi } from "../../src/platform/desktop";
import type { LumenDesktopApi } from "../../src/platform/desktop-api";

function fakeDesktop(opts: { failCreate?: boolean } = {}) {
  let key: Uint8Array | null = null;
  const calls: string[] = [];
  const api: LumenDesktopApi = {
    version: 1,
    platform: "win32",
    storeKey: {
      create: async () => {
        calls.push("create");
        if (opts.failCreate) throw new Error("no safeStorage");
        key = crypto.getRandomValues(new Uint8Array(32));
        return new Uint8Array(key);
      },
      get: async () => {
        calls.push("get");
        if (!key) throw new Error("No store key");
        return new Uint8Array(key);
      },
      destroy: async () => {
        calls.push("destroy");
        key = null;
      },
    },
    storageProtection: async () => ({ level: "os", backend: "dpapi" }),
    sso: { start: async () => "token", cancel: () => undefined },
    notifications: { show: () => undefined, onClick: () => () => undefined },
    setUnreadCount: () => undefined,
    signedOut: async () => undefined,
    onSignOutRequest: () => () => undefined,
    reportRtcTransports: () => undefined,
  };
  return { api, calls, currentKey: () => key };
}

async function storedPickleKey(): Promise<unknown> {
  const db = await openDb("lumen-session", 1, ["pickle-keys", "secrets"]);
  try {
    return await idbGet(db, "pickle-keys", "@a:x|DEV");
  } finally {
    db.close();
  }
}

const META = { userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" };

describe("desktop store key", () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteDb("lumen-session");
  });
  afterEach(() => {
    delete window.lumenDesktop;
    vi.restoreAllMocks();
  });

  it("is absent in a browser: no desktop API, web sign-in unchanged", () => {
    expect(desktopApi()).toBeNull();
    expect(startDesktopSso("https://m.x", "oidc-lumen")).toBeNull();
    expect(deviceDisplayName("Lumen", "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0")).toBe("Lumen Web (Chrome on Linux)");
  });

  it("seals the session with the desktop key and never stores a key in IndexedDB", async () => {
    const d = fakeDesktop();
    window.lumenDesktop = d.api;
    const saved = await saveSession(META, "syt_desktop_token");
    expect(d.calls).toEqual(["create"]);
    expect(await storedPickleKey()).toBeUndefined();
    expect(await loadSession()).toEqual(saved);
    expect(d.calls).toContain("get");
  });

  it("can't open the session once the desktop key is gone", async () => {
    const d = fakeDesktop();
    window.lumenDesktop = d.api;
    await saveSession(META, "tok");
    await d.api.storeKey.destroy();
    await expect(loadSession()).rejects.toThrow(/keys|decrypted/);
  });

  it("sign-out destroys the desktop key", async () => {
    const d = fakeDesktop();
    window.lumenDesktop = d.api;
    await saveSession(META, "tok");
    await clearSession();
    expect(d.calls).toContain("destroy");
    expect(d.currentKey()).toBeNull();
  });

  it("stays compatible with a session saved by the browser build (key in IndexedDB)", async () => {
    const saved = await saveSession(META, "tok-web");
    expect(await storedPickleKey()).toBeDefined();
    window.lumenDesktop = fakeDesktop().api;
    expect(await loadSession()).toEqual(saved);
  });

  it("falls back to the browser key when the OS has no protected storage", async () => {
    const d = fakeDesktop({ failCreate: true });
    window.lumenDesktop = d.api;
    const saved = await saveSession(META, "tok");
    expect(await storedPickleKey()).toBeDefined();
    expect(await loadSession()).toEqual(saved);
  });

  it("names the device after the desktop platform and starts SSO through the app", async () => {
    window.lumenDesktop = fakeDesktop().api;
    expect(deviceDisplayName("Lumen")).toBe("Lumen Desktop (Windows)");
    await expect(startDesktopSso("https://m.x", "oidc-lumen")).resolves.toBe("token");
  });

  it("ignores an unknown API version", () => {
    window.lumenDesktop = { ...fakeDesktop().api, version: 2 } as unknown as LumenDesktopApi;
    expect(desktopApi()).toBeNull();
  });
});
