/**
 * Preload of the main window (sandboxed, context-isolated). Depending on the page it exposes
 * exactly one narrow API:
 *   app://lumen/...            window.lumenDesktop (contract: services/chat/src/platform/desktop-api.ts)
 *   app://desktop/setup.html   window.lumenSetup  (server picker)
 * Nothing else: no ipcRenderer, no Node.js. The main process re-checks every call's sender.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopNotification, LumenDesktopApi } from "../../../../services/chat/src/platform/desktop-api.ts";

function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  // "Error invoking remote method 'x': SsoError: Sign-in was cancelled." -> "Sign-in was cancelled."
  return new Error(msg.replace(/^Error invoking remote method '[^']+': /, "").replace(/^\w*Error: /, ""));
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
  throw cleanError(e);
}) as Promise<T>;

const href = window.location.href;
const origin = window.location.origin;

if (origin === "app://lumen") {
  // ---- hide and disable the page while the app is locked ----
  const applyLock = (locked: boolean) => {
    const root = document.documentElement;
    if (!root) return;
    if (locked) {
      root.style.setProperty("visibility", "hidden", "important");
      root.setAttribute("data-lumen-locked", "");
      document.body?.setAttribute("inert", "");
    } else {
      root.style.removeProperty("visibility");
      root.removeAttribute("data-lumen-locked");
      document.body?.removeAttribute("inert");
    }
  };
  ipcRenderer.on("lumen:lock", (_e, locked: boolean) => applyLock(locked === true));
  const syncLock = () => void ipcRenderer.invoke("lumen:lock-state").then((l: boolean) => applyLock(l === true)).catch(() => undefined);
  syncLock();
  document.addEventListener("DOMContentLoaded", syncLock);

  // ---- input activity for the auto-lock timer (throttled) ----
  let last = 0;
  const activity = () => {
    const now = Date.now();
    if (now - last < 10_000) return;
    last = now;
    ipcRenderer.send("lumen:activity");
  };
  for (const t of ["keydown", "pointerdown", "wheel", "touchstart"]) window.addEventListener(t, activity, { capture: true, passive: true });

  const clickListeners = new Set<(roomId: string) => void>();
  ipcRenderer.on("lumen:notification-click", (_e, roomId: unknown) => {
    if (typeof roomId === "string") for (const l of clickListeners) l(roomId);
  });

  let signOutHandler: (() => Promise<void>) | null = null;
  ipcRenderer.on("lumen:sign-out-request", (_e, id: unknown) => {
    const h = signOutHandler;
    const p = h ? h() : Promise.resolve();
    p.then(
      () => ipcRenderer.send("lumen:sign-out-result", id, true),
      (e: unknown) => ipcRenderer.send("lumen:sign-out-result", id, false, e instanceof Error ? e.message : String(e)),
    );
  });

  const api: LumenDesktopApi = {
    version: 1,
    platform: process.platform as LumenDesktopApi["platform"],
    storeKey: {
      create: () => invoke<Uint8Array>("lumen:store-key:create"),
      get: () => invoke<Uint8Array>("lumen:store-key:get"),
      destroy: () => invoke<void>("lumen:store-key:destroy"),
    },
    storageProtection: () => invoke("lumen:storage-protection"),
    sso: {
      start: (baseUrl: string, idpId: string | null) => invoke<string>("lumen:sso:start", String(baseUrl), idpId === null ? null : String(idpId)),
      cancel: () => ipcRenderer.send("lumen:sso:cancel"),
    },
    notifications: {
      show: (n: DesktopNotification) =>
        ipcRenderer.send("lumen:notify", { title: String(n.title), body: String(n.body), roomId: String(n.roomId), silent: n.silent === true }),
      onClick: (cb: (roomId: string) => void) => {
        clickListeners.add(cb);
        return () => clickListeners.delete(cb);
      },
    },
    setUnreadCount: (n: number) => ipcRenderer.send("lumen:unread", Number(n) | 0),
    signedOut: () => invoke<void>("lumen:signed-out"),
    onSignOutRequest: (handler: () => Promise<void>) => {
      signOutHandler = handler;
      return () => {
        if (signOutHandler === handler) signOutHandler = null;
      };
    },
    reportRtcTransports: (urls: string[]) => ipcRenderer.send("lumen:rtc-transports", Array.isArray(urls) ? urls.map(String).slice(0, 8) : []),
  };
  contextBridge.exposeInMainWorld("lumenDesktop", api);
} else if (href.split(/[?#]/)[0] === "app://desktop/setup.html") {
  contextBridge.exposeInMainWorld("lumenSetup", {
    init: () => invoke("setup:init"),
    discover: (input: string) => invoke("setup:discover", String(input)),
    connect: () => invoke("setup:connect"),
    openSignup: () => ipcRenderer.send("setup:open-signup"),
  });
}
