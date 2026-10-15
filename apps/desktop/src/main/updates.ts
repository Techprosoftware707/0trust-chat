/**
 * Auto-update with electron-updater, only for code-signed builds:
 *   Windows  the running .exe must have a valid Authenticode signature; electron-updater then
 *            also checks that each downloaded installer is signed by the same publisher
 *            (`publisherName` in app-update.yml, written by electron-builder when signing).
 *   macOS    Squirrel.Mac only installs updates into a signed app and checks that the update
 *            is signed by the same Developer ID; the running app must be Developer ID signed.
 *   Linux    off: AppImage updates are not signature-checked; deb updates come from the
 *            package manager.
 * The feed is configured at build time (LUMEN_UPDATE_URL → generic provider, or
 * LUMEN_UPDATE_GITHUB=owner/repo → GitHub releases). No feed → no app-update.yml → off.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { log } from "./log.ts";

export type UpdateState =
  | { status: "disabled"; reason: "development" | "platform" | "no-feed" | "unsigned"; message: string }
  | { status: "idle" | "checking" | "up-to-date"; message: string }
  | { status: "available" | "downloading"; message: string; version?: string; percent?: number }
  | { status: "downloaded"; message: string; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "disabled", reason: "development", message: "Updates are checked only in installed builds." };
const listeners = new Set<(s: UpdateState) => void>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updater: any = null;

export function updateState(): UpdateState {
  return state;
}

export function onUpdateState(l: (s: UpdateState) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function set(s: UpdateState): void {
  state = s;
  for (const l of listeners) l(s);
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Whether the running app is code-signed with a real (not ad-hoc) identity. */
export async function runningAppIsSigned(): Promise<boolean> {
  if (process.platform === "darwin") {
    // .../Lumen Secure.app/Contents/MacOS/Lumen Secure -> the .app bundle
    const bundle = path.resolve(path.dirname(process.execPath), "..", "..");
    const verify = await run("/usr/bin/codesign", ["--verify", "--strict", "--deep", bundle]);
    if (verify.code !== 0) return false;
    const info = await run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
    const text = info.stderr + info.stdout;
    return /Authority=Developer ID Application/.test(text) && /TeamIdentifier=(?!not set)\S+/.test(text);
  }
  if (process.platform === "win32") {
    const exe = process.execPath.replace(/'/g, "''");
    const ps = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-AuthenticodeSignature -LiteralPath '${exe}').Status`,
    ]);
    return ps.code === 0 && ps.stdout.trim() === "Valid";
  }
  return false;
}

export async function initUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform !== "win32" && process.platform !== "darwin") {
    set({ status: "disabled", reason: "platform", message: "Automatic updates are not available for Linux builds. Install new versions with your package manager or a new AppImage." });
    return;
  }
  if (!fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) {
    set({ status: "disabled", reason: "no-feed", message: "This build has no update feed configured." });
    return;
  }
  if (!(await runningAppIsSigned())) {
    set({ status: "disabled", reason: "unsigned", message: "Updates are disabled in unsigned builds." });
    log.info("auto-update disabled: the running app is not code-signed");
    return;
  }
  const { autoUpdater } = await import("electron-updater");
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: (m: unknown) => log.info(`updater: ${String(m)}`), warn: (m: unknown) => log.warn(`updater: ${String(m)}`), error: (m: unknown) => log.warn(`updater: ${String(m)}`), debug: () => undefined };
  autoUpdater.on("checking-for-update", () => set({ status: "checking", message: "Checking for updates…" }));
  autoUpdater.on("update-not-available", () => set({ status: "up-to-date", message: `You're up to date (${app.getVersion()}).` }));
  autoUpdater.on("update-available", (i: { version: string }) => set({ status: "available", version: i.version, message: `Version ${i.version} is available.` }));
  autoUpdater.on("download-progress", (p: { percent: number }) => set({ status: "downloading", percent: Math.round(p.percent), message: `Downloading update… ${Math.round(p.percent)} %` }));
  autoUpdater.on("update-downloaded", (i: { version: string }) => set({ status: "downloaded", version: i.version, message: `Version ${i.version} is ready. It is installed when you restart the app.` }));
  autoUpdater.on("error", (e: Error) => set({ status: "error", message: `Update check failed: ${e.message.split("\n")[0]}` }));
  set({ status: "idle", message: "Automatic updates are on." });
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), 6 * 3600_000).unref();
}

export async function checkForUpdates(): Promise<void> {
  if (!updater) return;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ status: "error", message: `Update check failed: ${(e as Error).message.split("\n")[0]}` });
  }
}

export function installUpdateNow(): void {
  if (updater && state.status === "downloaded") updater.quitAndInstall(false, true);
}
