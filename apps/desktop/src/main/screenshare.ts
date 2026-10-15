/**
 * Screen sharing: getDisplayMedia from the web client opens the app's own source picker
 * (screens and windows from desktopCapturer, with thumbnails). Nothing is shared until the
 * user picks a source; closing the picker cancels. System audio ("loopback") is offered only
 * on Windows, where Chromium supports it.
 */
import { BrowserWindow, desktopCapturer, nativeTheme, systemPreferences, webContents, type Session } from "electron";
import { allowDisplayMediaRequest } from "../core/permissions.ts";
import { ctx, PAGE, preloadPath } from "./context.ts";
import { log } from "./log.ts";
import { originOfUrl, secureWebPreferences } from "./windows.ts";

export interface PickerSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
}

interface PendingPick {
  sources: Electron.DesktopCapturerSource[];
  audioRequested: boolean;
  resolve(choice: { id: string; audio: boolean } | null): void;
}

let pending: PendingPick | null = null;

export function pickerInfo(): { sources: PickerSource[]; audioSupported: boolean; screenPermission: string } {
  const sources = (pending?.sources ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
    thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
  }));
  const screenPermission = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";
  return { sources, audioSupported: process.platform === "win32" && !!pending?.audioRequested, screenPermission };
}

export function pickerChoose(id: unknown, audio: unknown): void {
  const p = pending;
  if (!p) return;
  pending = null;
  const chosen = typeof id === "string" ? p.sources.find((s) => s.id === id) : undefined;
  p.resolve(chosen ? { id: chosen.id, audio: audio === true } : null);
  ctx.pickerWindow?.close();
}

function openPicker(): Promise<void> {
  const parent = ctx.mainWindow ?? undefined;
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 480,
    minHeight: 400,
    parent,
    modal: !!parent,
    title: "Share your screen",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#050b1a" : "#f6f8fb",
    webPreferences: secureWebPreferences(preloadPath("picker")),
  });
  ctx.pickerWindow = win;
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    ctx.pickerWindow = null;
    if (pending) pickerChoose(null, false);
  });
  return win.loadURL(PAGE.picker);
}

export function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frame = request.frame;
      let fromAppWindow = false;
      let isMainFrame = false;
      try {
        fromAppWindow = !!frame && !!ctx.mainWindow && webContents.fromFrame(frame) === ctx.mainWindow.webContents;
        isMainFrame = !!frame && frame.parent === null;
      } catch {
        /* frame destroyed */
      }
      const origin = originOfUrl(frame?.url) ?? request.securityOrigin;
      if (ctx.locked || pending || !allowDisplayMediaRequest({ origin, fromAppWindow, isMainFrame, userGesture: request.userGesture })) {
        log.warn("refused a screen-share request");
        callback(null);
        return;
      }
      void (async () => {
        let sources: Electron.DesktopCapturerSource[] = [];
        try {
          sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
        } catch (e) {
          log.error("couldn't list screens and windows", e);
        }
        const choice = await new Promise<{ id: string; audio: boolean } | null>((resolve) => {
          pending = { sources, audioRequested: request.audioRequested, resolve };
          openPicker().catch(() => pickerChoose(null, false));
        });
        const source = choice ? sources.find((s) => s.id === choice.id) : undefined;
        if (!source) {
          callback(null);
          return;
        }
        try {
          callback({ video: source, ...(choice?.audio && process.platform === "win32" ? { audio: "loopback" as const } : {}) });
          log.info(`screen share started (${source.id.startsWith("screen:") ? "screen" : "window"})`);
        } catch (e) {
          log.error("screen share failed", e);
        }
      })();
    },
    { useSystemPicker: false },
  );
}
