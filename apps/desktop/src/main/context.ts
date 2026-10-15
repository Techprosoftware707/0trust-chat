/** Shared main-process state (windows, flags). */
import path from "node:path";
import { app, type BrowserWindow, type Tray, type WebContentsView } from "electron";

export const ctx = {
  mainWindow: null as BrowserWindow | null,
  lockView: null as WebContentsView | null,
  settingsWindow: null as BrowserWindow | null,
  pickerWindow: null as BrowserWindow | null,
  tray: null as Tray | null,
  quitting: false,
  locked: false,
  selfCheck: false,
  unread: 0,
};

/** Root of the app bundle (the asar in packaged builds, apps/desktop in development). */
export const appRoot = () => app.getAppPath();
export const distPath = (...p: string[]) => path.join(appRoot(), "dist", ...p);
export const preloadPath = (name: string) => distPath("preload", `${name}.cjs`);
export const iconPath = (name: string) => distPath("icons", name);

export const WEB_URL = "app://lumen/";
export const PAGE = {
  setup: "app://desktop/setup.html",
  lock: "app://desktop/lock.html",
  settings: "app://desktop/settings.html",
  picker: "app://desktop/picker.html",
} as const;
