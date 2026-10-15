/**
 * Files in the user-data directory:
 *   settings.json     desktop preferences (non-secret, validated on read)
 *   server.json       the discovered server profile (non-secret, re-validated on read)
 *   store-key.bin     the 256-bit store key, encrypted with safeStorage (DPAPI/Keychain/libsecret)
 *   applock.bin       the PIN verifier (PBKDF2 output), encrypted with safeStorage
 *   desktop-config.json is NOT here: it is part of the signed app bundle (build-time default server).
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { parseStoredProfile, type ServerProfile } from "../core/discovery.ts";
import { DEFAULT_SETTINGS, parseSettings, type DesktopSettings } from "../core/settings.ts";
import { log } from "./log.ts";

export const isDebugBuild = () => !app.isPackaged;

export function userDataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

/** Atomic write (temp file + rename), owner-only permissions. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

let settings: DesktopSettings | null = null;
const listeners = new Set<(s: DesktopSettings) => void>();

export function getSettings(): DesktopSettings {
  settings ??= parseSettings(readJson(userDataFile("settings.json")));
  return settings;
}

export function updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  settings = parseSettings({ ...getSettings(), ...patch });
  try {
    writeFileAtomic(userDataFile("settings.json"), JSON.stringify(settings, null, 2));
  } catch (e) {
    log.error("couldn't save settings", e);
  }
  for (const l of listeners) l(settings);
  return settings;
}

export function onSettingsChanged(l: (s: DesktopSettings) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function resetSettingsCache(): void {
  settings = { ...DEFAULT_SETTINGS };
}

let profile: ServerProfile | null | undefined;

export function getServerProfile(): ServerProfile | null {
  if (profile === undefined) {
    profile = parseStoredProfile(readJson(userDataFile("server.json")), { debug: isDebugBuild() });
  }
  return profile;
}

export function saveServerProfile(p: ServerProfile | null): void {
  profile = p;
  const file = userDataFile("server.json");
  if (p) writeFileAtomic(file, JSON.stringify(p, null, 2));
  else fs.rmSync(file, { force: true });
}

/** desktop-config.json from the app bundle (written at build time from LUMEN_DEFAULT_SERVER). */
export function readBuildConfig(appRoot: string): unknown {
  return readJson(path.join(appRoot, "dist", "desktop-config.json"));
}
