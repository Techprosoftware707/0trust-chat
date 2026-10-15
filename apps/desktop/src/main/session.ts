/**
 * Session-level policy: permission handlers, device access, downloads, and wiping the web
 * client's browser storage on sign-out.
 */
import path from "node:path";
import { app, systemPreferences, webContents as WebContentsStatic, type Session, type WebContents } from "electron";
import { allowPermissionCheck, allowPermissionRequest } from "../core/permissions.ts";
import { ctx } from "./context.ts";
import { log } from "./log.ts";

function isAppWindow(wc: WebContents | null | undefined): boolean {
  return !!wc && !!ctx.mainWindow && !ctx.mainWindow.isDestroyed() && wc === ctx.mainWindow.webContents;
}

export function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const isMainFrame = (details as { isMainFrame?: boolean }).isMainFrame !== false;
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    const allowed =
      !ctx.locked &&
      allowPermissionRequest({
        permission,
        origin: details.requestingUrl ?? null,
        fromAppWindow: isAppWindow(wc),
        isMainFrame,
        ...(mediaTypes ? { mediaTypes } : {}),
      });
    if (!allowed) {
      log.warn(`denied permission "${permission}"`);
      callback(false);
      return;
    }
    if (permission === "media" && process.platform === "darwin") {
      // macOS privacy prompt (TCC) for the app itself; the web permission follows the OS answer.
      const kinds = mediaTypes?.length ? mediaTypes : ["audio", "video"];
      void Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k === "video" ? "camera" : "microphone")))
        .then((r) => callback(r.every(Boolean)))
        .catch(() => callback(false));
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowPermissionCheck({ permission, origin: requestingOrigin, fromAppWindow: isAppWindow(wc) }),
  );
  // No WebHID / WebUSB / Web Serial / Bluetooth devices.
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (e, _d, cb) => {
    e.preventDefault();
    cb("");
  });
  ses.on("select-serial-port", (e, _d, _wc, cb) => {
    e.preventDefault();
    cb("");
  });
  ses.on("select-usb-device", (e, _d, cb) => {
    e.preventDefault();
    cb();
  });
  ses.setUSBProtectedClassesHandler(() => []);
}

/** Downloads (attachments): always through a save dialog, defaulting to the Downloads folder. */
export function installDownloadHandler(ses: Session): void {
  ses.on("will-download", (_e, item, wc) => {
    if (!isAppWindow(wc)) {
      item.cancel();
      return;
    }
    const name = path.basename(item.getFilename() || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "download";
    item.setSaveDialogOptions({ title: "Save file", defaultPath: path.join(app.getPath("downloads"), name) });
    item.once("done", (_ev, state) => log.info(`download ${state}`));
  });
}

/** Deletes everything the web client stored in the browser profile (sign-out, change server). */
export async function clearWebStorage(ses: Session): Promise<void> {
  await ses.clearStorageData({
    storages: ["cookies", "filesystem", "indexdb", "localstorage", "shadercache", "serviceworkers", "cachestorage"],
  });
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearCodeCaches({});
  ses.flushStorageData();
  log.info("cleared the web client's local storage");
}

export function allWebContents(): WebContents[] {
  return WebContentsStatic.getAllWebContents();
}
