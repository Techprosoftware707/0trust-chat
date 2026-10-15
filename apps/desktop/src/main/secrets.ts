/**
 * OS-protected secrets (ADR 0003 D7): the store key and the app-lock PIN verifier are kept
 * only encrypted with Electron safeStorage:
 *   Windows  DPAPI (user-scoped)
 *   macOS    Keychain item restricted to this (signed) app
 *   Linux    libsecret / KWallet; without a keyring Chromium falls back to a fixed key
 *            ("basic_text"), which the app reports as a visible warning.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { safeStorage } from "electron";
import type { DesktopStorageProtection } from "../../../../services/chat/src/platform/desktop-api.ts";
import { parsePinVerifier, type PinVerifier } from "../core/pin.ts";
import { log } from "./log.ts";
import { userDataFile, writeFileAtomic } from "./store.ts";

const STORE_KEY_FILE = "store-key.bin";
const PIN_FILE = "applock.bin";

/**
 * Linux without a keyring: Chromium's "basic_text" backend reports encryption as unavailable
 * unless plain-text mode is enabled. The app enables it (Chromium's fixed fallback key, i.e.
 * obfuscation only) so that the same code path runs, and reports level "basic", which the UI
 * shows as a warning. Never used on Windows or macOS.
 */
export function initSafeStorage(): void {
  if (process.platform !== "linux") return;
  if (!safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() === "basic_text") {
    safeStorage.setUsePlainTextEncryption(true);
  }
}

export function storageProtection(): DesktopStorageProtection {
  if (process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    if (!safeStorage.isEncryptionAvailable()) return { level: "unavailable", backend };
    return { level: backend === "basic_text" || backend === "unknown" ? "basic" : "os", backend };
  }
  if (!safeStorage.isEncryptionAvailable()) return { level: "unavailable", backend: process.platform === "win32" ? "dpapi" : "keychain" };
  return { level: "os", backend: process.platform === "win32" ? "dpapi" : "keychain" };
}

function encrypt(plain: string): Buffer {
  if (storageProtection().level === "unavailable") throw new Error("OS-protected storage is not available");
  return safeStorage.encryptString(plain);
}

function decrypt(file: string): string | null {
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export function createStoreKey(): Buffer {
  const key = randomBytes(32);
  writeFileAtomic(userDataFile(STORE_KEY_FILE), encrypt(key.toString("base64")));
  log.info("created a new store key");
  return key;
}

export function getStoreKey(): Buffer {
  const b64 = decrypt(userDataFile(STORE_KEY_FILE));
  const key = b64 ? Buffer.from(b64, "base64") : null;
  if (!key || key.length !== 32) throw new Error("No store key");
  return key;
}

export function destroyStoreKey(): void {
  fs.rmSync(userDataFile(STORE_KEY_FILE), { force: true });
}

export function hasStoreKey(): boolean {
  return fs.existsSync(userDataFile(STORE_KEY_FILE));
}

export function readPinVerifier(): PinVerifier | null {
  const raw = decrypt(userDataFile(PIN_FILE));
  if (!raw) return null;
  try {
    return parsePinVerifier(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function hasPinFile(): boolean {
  return fs.existsSync(userDataFile(PIN_FILE));
}

export function writePinVerifier(v: PinVerifier | null): void {
  if (!v) {
    fs.rmSync(userDataFile(PIN_FILE), { force: true });
    return;
  }
  writeFileAtomic(userDataFile(PIN_FILE), encrypt(JSON.stringify(v)));
}
