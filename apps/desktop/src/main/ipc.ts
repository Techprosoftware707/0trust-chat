/**
 * IPC between the preload scripts and the main process. Every handler first checks who is
 * calling: the expected web contents, its top-level frame, and the exact origin/page. The
 * web client's API (lumenDesktop) is only answered for app://lumen in the main window; each
 * desktop page only gets its own channels.
 */
import { randomBytes } from "node:crypto";
import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { SsoCoordinator } from "../core/sso.ts";
import { isSafeExternalUrl, validateLivekitUrl } from "../core/url.ts";
import { AUTO_LOCK_CHOICES, type DesktopSettings } from "../core/settings.ts";
import { brandOf } from "../core/discovery.ts";
import * as applock from "./applock.ts";
import { ctx, PAGE } from "./context.ts";
import * as flows from "./flows.ts";
import { log } from "./log.ts";
import { refreshTrayMenu, setUnreadCount, showNotification, parseNotification } from "./notify.ts";
import { WEB_ORIGIN } from "./protocol.ts";
import { pickerChoose, pickerInfo } from "./screenshare.ts";
import { createStoreKey, destroyStoreKey, getStoreKey, storageProtection } from "./secrets.ts";
import { getServerProfile, getSettings, isDebugBuild, readBuildConfig, updateSettings } from "./store.ts";
import { checkForUpdates, installUpdateNow, updateState, onUpdateState } from "./updates.ts";
import { originOfUrl, showMainWindow } from "./windows.ts";
import { appRoot } from "./context.ts";
import { parseBuildConfig } from "../core/discovery.ts";

type Ev = IpcMainEvent | IpcMainInvokeEvent;

function topFrameUrl(e: Ev): string | null {
  try {
    const f = e.senderFrame;
    if (!f || f.parent !== null) return null;
    return f.url;
  } catch {
    return null;
  }
}

function from(e: Ev, wc: WebContents | null | undefined): boolean {
  return !!wc && !wc.isDestroyed() && e.sender === wc;
}

export const isFromWebClient = (e: Ev) => from(e, ctx.mainWindow?.webContents) && originOfUrl(topFrameUrl(e)) === WEB_ORIGIN;
const isFromPage = (e: Ev, page: string, wc: WebContents | null | undefined) => from(e, wc) && topFrameUrl(e)?.split(/[?#]/)[0] === page;
const isFromSetup = (e: Ev) => isFromPage(e, PAGE.setup, ctx.mainWindow?.webContents);
const isFromLock = (e: Ev) => isFromPage(e, PAGE.lock, ctx.lockView?.webContents);
const isFromSettings = (e: Ev) => isFromPage(e, PAGE.settings, ctx.settingsWindow?.webContents);
const isFromPicker = (e: Ev) => isFromPage(e, PAGE.picker, ctx.pickerWindow?.webContents);

class Refused extends Error {
  override name = "Refused";
}

function handle(channel: string, check: (e: Ev) => boolean, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!check(e)) {
      log.warn(`refused IPC ${channel} from an unexpected sender`);
      throw new Refused("Not allowed");
    }
    return fn(e, ...args);
  });
}

function on(channel: string, check: (e: Ev) => boolean, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!check(e)) {
      log.warn(`refused IPC ${channel} from an unexpected sender`);
      return;
    }
    fn(e, ...args);
  });
}

export const sso = new SsoCoordinator({
  openExternal: async (url) => {
    if (!isSafeExternalUrl(url)) throw new Error("not an https URL");
    await shell.openExternal(url, { activate: true });
  },
  newNonce: () => randomBytes(24).toString("base64url"),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  log: (m) => log.info(m),
});

/** An io.lumen.secure: link from the OS (argv on Windows/Linux, open-url on macOS). */
export function handleAppLink(url: string): void {
  if (sso.handleCallback(url)) {
    log.info("sign-in callback accepted");
    showMainWindow();
  }
}

export function settingsView() {
  const s = getSettings();
  const p = getServerProfile();
  return {
    platform: process.platform,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    packaged: app.isPackaged,
    brand: brandOf(p),
    server: p
      ? { serverName: p.serverName, homeserverUrl: p.homeserverUrl, accountUrl: p.lumen?.account_url ?? null, accountDeleteUrl: p.lumen?.account_delete_url ?? null }
      : null,
    settings: {
      closeToTray: s.closeToTray,
      openAtLogin: s.openAtLogin,
      doNotDisturb: s.doNotDisturb,
      autoLockMinutes: s.autoLockMinutes,
      lockOnSuspend: s.lockOnSuspend,
      touchId: s.touchId,
    },
    autoLockChoices: [0, ...AUTO_LOCK_CHOICES],
    lockEnabled: applock.lockEnabled(),
    touchIdAvailable: applock.touchIdAvailable(),
    openAtLoginSupported: process.platform === "win32" || process.platform === "darwin",
    storage: storageProtection(),
    update: updateState(),
  };
}

function pushSettingsView(): void {
  const w = ctx.settingsWindow;
  if (w && !w.isDestroyed()) w.webContents.send("settings:changed", settingsView());
}

export function registerIpc(): void {
  // ---- web client (window.lumenDesktop) ----
  handle("lumen:store-key:create", isFromWebClient, () => new Uint8Array(createStoreKey()));
  handle("lumen:store-key:get", isFromWebClient, () => new Uint8Array(getStoreKey()));
  handle("lumen:store-key:destroy", isFromWebClient, () => destroyStoreKey());
  handle("lumen:storage-protection", (e) => isFromWebClient(e) || isFromSetup(e), () => storageProtection());
  handle("lumen:sso:start", isFromWebClient, async (_e, baseUrl, idpId) => {
    const p = getServerProfile();
    if (!p) throw new Error("No server configured.");
    const token = await sso.start(baseUrl as string, (idpId ?? null) as string | null, p.homeserverUrl);
    return token;
  });
  on("lumen:sso:cancel", isFromWebClient, () => sso.cancel());
  on("lumen:notify", isFromWebClient, (_e, raw) => {
    const n = parseNotification(raw);
    if (n) showNotification(n);
  });
  on("lumen:unread", isFromWebClient, (_e, n) => setUnreadCount(typeof n === "number" ? n : 0));
  handle("lumen:signed-out", isFromWebClient, () => flows.wipeAfterSignOut());
  on("lumen:sign-out-result", isFromWebClient, (_e, id, ok, error) => flows.signOutResult(id, ok, error));
  on("lumen:rtc-transports", isFromWebClient, (_e, urls) => {
    if (!Array.isArray(urls)) return;
    const valid = urls.slice(0, 8).map((u) => validateLivekitUrl(u, { debug: isDebugBuild() })).filter((u): u is string => !!u);
    if (valid.length) flows.rtcTransportsReported(valid);
  });
  on("lumen:activity", isFromWebClient, () => applock.noteActivity());
  handle("lumen:lock-state", isFromWebClient, () => ctx.locked);

  // ---- server picker ----
  handle("setup:init", isFromSetup, () => ({
    defaultServer: parseBuildConfig(readBuildConfig(appRoot())).defaultServer,
    storage: storageProtection(),
  }));
  handle("setup:discover", isFromSetup, (_e, input) => flows.setupDiscover(input));
  handle("setup:connect", isFromSetup, () => flows.setupConnect());
  on("setup:open-signup", isFromSetup, () => {
    const u = flows.pendingSignupUrl();
    if (u && isSafeExternalUrl(u)) void shell.openExternal(u);
  });

  // ---- lock screen ----
  handle("lock:state", isFromLock, () => ({
    brand: brandOf(getServerProfile()).name,
    touchId: getSettings().touchId && applock.touchIdAvailable(),
    retryAfterMs: applock.retryAfterMs(),
  }));
  handle("lock:unlock", isFromLock, (_e, pin) => applock.unlockWithPin(pin));
  handle("lock:touch-id", isFromLock, () => applock.unlockWithTouchId());

  // ---- desktop settings ----
  handle("settings:get", isFromSettings, () => settingsView());
  handle("settings:set", isFromSettings, (_e, patch) => {
    if (typeof patch !== "object" || patch === null) return settingsView();
    const p = patch as Record<string, unknown>;
    const next: Partial<DesktopSettings> = {};
    for (const k of ["closeToTray", "doNotDisturb", "lockOnSuspend"] as const) if (typeof p[k] === "boolean") next[k] = p[k];
    if (typeof p.autoLockMinutes === "number") next.autoLockMinutes = p.autoLockMinutes;
    if (typeof p.touchId === "boolean") next.touchId = p.touchId && applock.touchIdAvailable() && applock.lockEnabled();
    if (typeof p.openAtLogin === "boolean" && (process.platform === "win32" || process.platform === "darwin")) {
      next.openAtLogin = p.openAtLogin;
      app.setLoginItemSettings({ openAtLogin: p.openAtLogin, args: p.openAtLogin && process.platform === "win32" ? ["--hidden"] : [] });
    }
    updateSettings(next);
    refreshTrayMenu();
    return settingsView();
  });
  handle("settings:set-pin", isFromSettings, async (_e, current, next) => {
    const r = await applock.setPin(current, next);
    refreshTrayMenu();
    return r;
  });
  handle("settings:remove-pin", isFromSettings, async (_e, current) => {
    const r = await applock.removePin(current);
    refreshTrayMenu();
    return r;
  });
  handle("settings:lock-now", isFromSettings, () => {
    const ok = applock.lock("user");
    if (ok) ctx.settingsWindow?.close();
    return ok;
  });
  handle("settings:change-server", isFromSettings, () => {
    ctx.settingsWindow?.close();
    void flows.changeServer();
  });
  handle("settings:check-updates", isFromSettings, () => checkForUpdates());
  handle("settings:install-update", isFromSettings, () => installUpdateNow());
  on("settings:open-account", isFromSettings, () => {
    const u = getServerProfile()?.lumen?.account_url;
    if (u && isSafeExternalUrl(u)) void shell.openExternal(u);
  });
  on("settings:open-account-delete", isFromSettings, () => {
    const u = getServerProfile()?.lumen?.account_delete_url;
    if (u && isSafeExternalUrl(u)) void shell.openExternal(u);
  });
  onUpdateState(() => pushSettingsView());
  applock.onLockChanged(() => {
    pushSettingsView();
    refreshTrayMenu();
  });

  // ---- screen-share picker ----
  handle("picker:sources", isFromPicker, () => pickerInfo());
  on("picker:choose", isFromPicker, (_e, id, audio) => pickerChoose(id, audio));
  on("picker:open-privacy-settings", isFromPicker, () => {
    if (process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });
}
