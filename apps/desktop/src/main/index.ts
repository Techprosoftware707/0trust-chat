/**
 * Lumen Secure desktop — main process entry.
 *
 * The app ships the Lumen web client (services/chat) inside its signed bundle and serves it
 * from app://lumen; it never loads the web client from a server. See apps/desktop/README.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, session } from "electron";
import { findAppLinkInArgv } from "../core/deeplink.ts";
import { forbiddenSwitchesIn } from "../core/switches.ts";
import * as applock from "./applock.ts";
import { ctx, distPath } from "./context.ts";
import { changeServer } from "./flows.ts";
import { handleAppLink, registerIpc } from "./ipc.ts";
import { initLog, log } from "./log.ts";
import { buildMenu } from "./menu.ts";
import { createTray, refreshTrayMenu, setUnreadCount, trayHint } from "./notify.ts";
import { handleAppProtocol, registerPrivilegedScheme } from "./protocol.ts";
import { installDisplayMediaHandler } from "./screenshare.ts";
import { initSafeStorage, storageProtection } from "./secrets.ts";
import { runSelfCheck, selfCheckArg } from "./selfcheck.ts";
import { installDownloadHandler, installPermissionHandlers } from "./session.ts";
import { getServerProfile, getSettings, onSettingsChanged } from "./store.ts";
import { initUpdates } from "./updates.ts";
import { createMainWindow, hardenWebContents, loadMainContent, openSettingsWindow, showMainWindow } from "./windows.ts";

const APP_ID = "io.lumen.secure";

// ---- 1. Refuse to run a released build with debugging / insecure switches ----
const forbidden = app.isPackaged ? forbiddenSwitchesIn(process.argv) : [];
if (forbidden.length) {
  console.error(`[lumen] refusing to start with ${forbidden.map((b) => `--${b}`).join(", ")} (not allowed in released builds)`);
  app.exit(1);
} else {
  main();
}

function main(): void {
const selfCheck = selfCheckArg(process.argv);
ctx.selfCheck = selfCheck.enabled;
if (selfCheck.enabled) {
  // Throw-away profile: the self-check never touches the user's data or the running instance.
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "lumen-self-check-")));
}

registerPrivilegedScheme();
// Every renderer is sandboxed regardless of webPreferences. (Exception: an unpackaged
// development/test run started with --no-sandbox, e.g. as root in a CI container; a released
// build refuses --no-sandbox above.)
if (app.isPackaged || !app.commandLine.hasSwitch("no-sandbox")) app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// ---- 2. Single instance: a second launch (e.g. the OS opening io.lumen.secure:…) hands its
//         command line to the running instance and exits. ----
const primary = selfCheck.enabled || app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  let pendingLink: string | null = findAppLinkInArgv(process.argv);

  app.on("second-instance", (_e, argv) => {
    const link = findAppLinkInArgv(argv);
    if (link) handleAppLink(link);
    else showMainWindow();
  });
  // macOS delivers URLs through open-url (also before 'ready').
  app.on("will-finish-launching", () => {
    app.on("open-url", (e, url) => {
      e.preventDefault();
      if (app.isReady()) handleAppLink(url);
      else pendingLink = url;
    });
  });

  app.on("web-contents-created", (_e, contents) => hardenWebContents(contents));

  app.on("before-quit", () => {
    ctx.quitting = true;
  });

  const quit = () => {
    ctx.quitting = true;
    app.quit();
  };

  app.whenReady().then(async () => {
    initLog(app.getPath("userData"));
    log.info(`starting ${app.getName()} ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform}/${process.arch}, packaged=${app.isPackaged})`);

    const ses = session.defaultSession;
    handleAppProtocol(ses, { webRoot: distPath("web"), pagesRoot: distPath("pages"), getProfile: getServerProfile });
    installPermissionHandlers(ses);
    installDisplayMediaHandler(ses);
    installDownloadHandler(ses);
    // Windows and macOS use the OS spellchecker. On Linux Chromium would download Hunspell
    // dictionaries from Google's CDN, a third-party request: spellcheck is off there.
    if (process.platform === "linux") {
      ses.setSpellCheckerEnabled(false);
      ses.setSpellCheckerLanguages([]);
    }
    initSafeStorage();
    if (process.platform === "linux") {
      const sp = storageProtection();
      if (sp.level !== "os") log.warn(`OS keyring not available (safeStorage backend: ${sp.backend}); secrets are only obfuscated`);
    }
    registerIpc();

    const win = createMainWindow();
    if (selfCheck.enabled) {
      loadMainContent();
      void runSelfCheck(selfCheck.report);
      return;
    }

    // Lock before anything is shown if an app-lock PIN is set.
    if (applock.lockEnabled()) applock.lock("start");
    loadMainContent();

    win.on("close", (e) => {
      if (ctx.quitting) return;
      const s = getSettings();
      if (process.platform === "darwin" || (s.closeToTray && ctx.tray)) {
        e.preventDefault();
        win.hide();
        if (process.platform !== "darwin") trayHint();
      }
    });

    const lockNow = () => applock.lock("user");
    const menuActions = { changeServer: () => void changeServer(), lockNow, lockAvailable: applock.lockEnabled, quit };
    buildMenu(menuActions);
    createTray({ lockNow, lockAvailable: applock.lockEnabled, openSettings: openSettingsWindow, quit });
    applock.onLockChanged(() => buildMenu(menuActions));
    onSettingsChanged(() => refreshTrayMenu());
    applock.startAutoLock();
    setUnreadCount(0);

    if (app.isPackaged && !app.isDefaultProtocolClient(APP_ID)) {
      // Installers register the scheme too (NSIS registry keys, Info.plist, .desktop file).
      app.setAsDefaultProtocolClient(APP_ID);
    }
    const startHidden = process.argv.includes("--hidden"); // Windows "open at login" starts in the tray
    if (startHidden) win.once("ready-to-show", () => win.hide());

    if (pendingLink) {
      handleAppLink(pendingLink);
      pendingLink = null;
    }
    void initUpdates().catch((e: unknown) => log.error("updater", e));
  });

  app.on("activate", () => {
    // macOS: clicking the Dock icon shows the window again.
    if (ctx.mainWindow) showMainWindow();
    else if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      loadMainContent();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  process.on("uncaughtException", (e) => {
    log.error("uncaught exception", e);
    if (!app.isReady()) return;
    dialog.showErrorBox("Lumen", "An unexpected error occurred. The app will continue; if something doesn't work, restart it.");
  });
}
}
