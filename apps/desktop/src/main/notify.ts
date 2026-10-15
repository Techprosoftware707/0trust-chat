/**
 * OS notifications for the web client, badge / overlay unread count, tray icon.
 * The web client decides whether to notify and whether the text is included (its
 * "Show message previews" preference, off by default). This side additionally drops
 * everything while "Do not disturb" is on and strips content while the app is locked.
 */
import { app, Menu, nativeImage, Notification, Tray } from "electron";
import type { DesktopNotification } from "../../../../services/chat/src/platform/desktop-api.ts";
import { ctx, iconPath } from "./context.ts";
import { log } from "./log.ts";
import { getSettings, updateSettings } from "./store.ts";
import { brandName, showMainWindow } from "./windows.ts";

const live = new Set<Notification>();
// "!opaque:server" (room versions ≤ 11) or "!opaque" (room version 12: no server part).
const ROOM_ID = /^![^\s:/?#]{1,255}(:[A-Za-z0-9.\-:[\]]{1,255})?$/;

export function isRoomId(s: string): boolean {
  return s.length <= 300 && ROOM_ID.test(s);
}

export function parseNotification(raw: unknown): DesktopNotification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || typeof r.body !== "string" || typeof r.roomId !== "string" || !isRoomId(r.roomId)) return null;
  return { title: r.title.slice(0, 200), body: r.body.slice(0, 1000), roomId: r.roomId, silent: r.silent === true };
}

export function showNotification(n: DesktopNotification): void {
  if (getSettings().doNotDisturb) return;
  if (!Notification.isSupported()) {
    log.warn("OS notifications are not supported here");
    return;
  }
  const locked = ctx.locked;
  const notification = new Notification({
    title: locked ? brandName() : n.title,
    body: locked ? "New message" : n.body,
    silent: n.silent,
    icon: process.platform === "linux" ? iconPath("icon-256.png") : undefined,
  });
  live.add(notification);
  const done = () => live.delete(notification);
  notification.on("click", () => {
    done();
    showMainWindow();
    ctx.mainWindow?.webContents.send("lumen:notification-click", n.roomId);
  });
  notification.on("close", done);
  notification.on("failed", (_e, err) => {
    done();
    log.warn(`notification failed: ${err}`);
  });
  notification.show();
}

// ---------------------------------------------------------------------------------------
// Unread badge
// ---------------------------------------------------------------------------------------

export function setUnreadCount(n: number): void {
  const count = Number.isInteger(n) && n >= 0 ? Math.min(n, 9999) : 0;
  ctx.unread = count;
  if (process.platform === "win32") {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) {
      win.setOverlayIcon(count > 0 ? nativeImage.createFromPath(iconPath("badge-dot.png")) : null, count > 0 ? `${count} unread` : "");
    }
  } else {
    app.setBadgeCount(count);
  }
  ctx.tray?.setToolTip(count > 0 ? `${brandName()} — ${count} unread` : brandName());
}

// ---------------------------------------------------------------------------------------
// Tray / menu-bar icon
// ---------------------------------------------------------------------------------------

export interface TrayActions {
  lockNow(): void;
  lockAvailable(): boolean;
  openSettings(): void;
  quit(): void;
}

let actions: TrayActions | null = null;

export function refreshTrayMenu(): void {
  if (!ctx.tray || !actions) return;
  const a = actions;
  ctx.tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${brandName()}`, click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "Do not disturb",
        type: "checkbox",
        checked: getSettings().doNotDisturb,
        click: (item) => {
          updateSettings({ doNotDisturb: item.checked });
        },
      },
      { label: "Lock now", enabled: a.lockAvailable() && !ctx.locked, click: () => a.lockNow() },
      { label: "Desktop settings…", click: () => a.openSettings() },
      { type: "separator" },
      { label: "Quit", click: () => a.quit() },
    ]),
  );
}

export function createTray(a: TrayActions): void {
  actions = a;
  const icon =
    process.platform === "darwin"
      ? nativeImage.createFromPath(iconPath("trayTemplate.png"))
      : nativeImage.createFromPath(iconPath(process.platform === "win32" ? "tray.ico" : "tray.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  try {
    ctx.tray = new Tray(icon);
  } catch (e) {
    log.warn(`no tray icon: ${(e as Error).message}`);
    return;
  }
  ctx.tray.setToolTip(brandName());
  if (process.platform !== "darwin") ctx.tray.on("click", () => showMainWindow());
  refreshTrayMenu();
}

/** First time the window is closed to the tray: tell the user the app is still running. */
export function trayHint(): void {
  if (getSettings().trayHintShown) return;
  updateSettings({ trayHintShown: true });
  const where = process.platform === "darwin" ? "menu bar" : "system tray";
  const body = `${brandName()} keeps running in the ${where} so you still get messages and calls. Quit it from the ${where} icon.`;
  if (process.platform === "win32" && ctx.tray) {
    ctx.tray.displayBalloon({ title: `${brandName()} is still running`, content: body, iconType: "info" });
  } else if (Notification.isSupported()) {
    new Notification({ title: `${brandName()} is still running`, body, silent: true }).show();
  }
}
