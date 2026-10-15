/**
 * Windows and web-content hardening: the main window (web client or server picker), the lock
 * overlay, the desktop settings window; navigation lock, new-window policy, external links.
 */
import { app, BrowserWindow, nativeTheme, screen, shell, WebContentsView, type WebContents, type WebPreferences } from "electron";
import { brandOf } from "../core/discovery.ts";
import { fitWindowState } from "../core/settings.ts";
import { isSafeExternalUrl } from "../core/url.ts";
import { ctx, iconPath, PAGE, preloadPath, WEB_URL } from "./context.ts";
import { log } from "./log.ts";
import { WEB_ORIGIN } from "./protocol.ts";
import { getServerProfile, getSettings, updateSettings } from "./store.ts";

export function originOfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The webPreferences the main window was created with (reported by --self-check). */
export let mainWindowPreferences: WebPreferences | null = null;

export function secureWebPreferences(preload: string, extra: Partial<WebPreferences> = {}): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !app.isPackaged,
    spellcheck: false,
    ...extra,
  };
}

/** Opens https:/mailto: links in the default browser / mail client; refuses everything else. */
export async function openExternalSafe(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    log.warn("refused to open a non-https external link");
    return;
  }
  await shell.openExternal(url, { activate: true });
}

/** Applied to every web contents the app creates (app 'web-contents-created'). */
export function hardenWebContents(contents: WebContents): void {
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalSafe(url);
    else log.warn("blocked a window.open to a non-https URL");
    return { action: "deny" };
  });
  const guard = (e: Electron.Event, url: string) => {
    const from = originOfUrl(contents.getURL());
    const to = originOfUrl(url);
    // In-app navigation is allowed only within the web client (e.g. reload after sign-out).
    if (from === WEB_ORIGIN && to === WEB_ORIGIN) return;
    e.preventDefault();
    if (isSafeExternalUrl(url)) void openExternalSafe(url);
    else log.warn(`blocked navigation to ${to ?? "an invalid URL"}`);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame) e.preventDefault();
  });
}

export function brandName(): string {
  return brandOf(getServerProfile()).name;
}

function windowIcon(): string | undefined {
  return process.platform === "linux" ? iconPath("icon-512.png") : undefined;
}

export function createMainWindow(): BrowserWindow {
  const s = getSettings();
  const restored = fitWindowState(
    s.window,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    width: restored?.width ?? 1200,
    height: restored?.height ?? 800,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: brandName(),
    icon: windowIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#050b1a" : "#f6f8fb",
    webPreferences: (mainWindowPreferences = secureWebPreferences(preloadPath("app"), {
      // OS spellchecker on Windows and macOS; off on Linux (see index.ts).
      spellcheck: process.platform !== "linux",
      // backgroundThrottling stays on: with it off the Page Visibility API always reports
      // "visible", and the web client would send read receipts and skip notifications while
      // the window is hidden in the tray.
    })),
  });
  if (restored?.maximized) win.maximize();
  ctx.mainWindow = win;

  const saveState = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    updateSettings({ window: { ...b, maximized: win.isMaximized() } });
  };
  let t: NodeJS.Timeout | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    t = setTimeout(saveState, 800);
  };
  win.on("resize", debounced);
  win.on("move", debounced);
  win.on("maximize", debounced);
  win.on("unmaximize", debounced);

  win.on("page-title-updated", (e) => {
    // While locked the title must not show unread counts or room names.
    if (ctx.locked) {
      e.preventDefault();
      win.setTitle(brandName());
    }
  });

  win.once("ready-to-show", () => {
    if (!ctx.selfCheck || process.env.LUMEN_SELF_CHECK_SHOW !== "0") win.show();
  });
  win.on("closed", () => {
    ctx.mainWindow = null;
  });
  return win;
}

export function loadMainContent(): void {
  const win = ctx.mainWindow;
  if (!win) return;
  const target = getServerProfile() ? WEB_URL : PAGE.setup;
  void win.loadURL(target).catch((e: unknown) => log.error("couldn't load the main window", e));
}

export function showMainWindow(): void {
  const win = ctx.mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

// ---------------------------------------------------------------------------------------
// Lock overlay
// ---------------------------------------------------------------------------------------

function fitLockView(): void {
  const win = ctx.mainWindow;
  const view = ctx.lockView;
  if (!win || !view) return;
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
}

export function showLockView(): void {
  const win = ctx.mainWindow;
  if (!win || ctx.lockView) return;
  const view = new WebContentsView({ webPreferences: secureWebPreferences(preloadPath("lock")) });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#050b1a" : "#f6f8fb");
  ctx.lockView = view;
  win.contentView.addChildView(view);
  fitLockView();
  win.on("resize", fitLockView);
  void view.webContents.loadURL(PAGE.lock).then(() => view.webContents.focus());
  win.setTitle(brandName());
}

export function hideLockView(): void {
  const win = ctx.mainWindow;
  const view = ctx.lockView;
  if (!view) return;
  ctx.lockView = null;
  if (win && !win.isDestroyed()) {
    win.off("resize", fitLockView);
    win.contentView.removeChildView(view);
    win.webContents.focus();
  }
  view.webContents.close();
}

// ---------------------------------------------------------------------------------------
// Desktop settings window
// ---------------------------------------------------------------------------------------

export function openSettingsWindow(): void {
  if (ctx.locked) {
    // Unlock first: the settings window would bypass the lock (server, PIN, preferences).
    showMainWindow();
    return;
  }
  if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
    ctx.settingsWindow.show();
    ctx.settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    title: "Desktop settings",
    icon: windowIcon(),
    show: false,
    parent: process.platform === "darwin" ? undefined : (ctx.mainWindow ?? undefined),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#050b1a" : "#f6f8fb",
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(preloadPath("settings")),
  });
  ctx.settingsWindow = win;
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    ctx.settingsWindow = null;
  });
  void win.loadURL(PAGE.settings);
}
