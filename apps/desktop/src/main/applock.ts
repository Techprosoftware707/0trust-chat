/**
 * App lock (ADR 0003 D7): optional PIN (PBKDF2-SHA-256 verifier, safeStorage-encrypted) plus
 * Touch ID on macOS. Locks on start, after inactivity in the app (configurable), and when the
 * OS locks the screen or suspends. While locked an opaque lock view covers the window and the
 * web client's document is hidden and made inert (not merely blurred); notifications lose
 * their content.
 *
 * It protects against someone using an unlocked, unattended computer. It does not protect
 * against malware or anyone with control of the operating system account.
 */
import { powerMonitor, systemPreferences } from "electron";
import { backoffMs, createPinVerifier, pinProblem, verifyPin } from "../core/pin.ts";
import { ctx } from "./context.ts";
import { log } from "./log.ts";
import { readPinVerifier, storageProtection, writePinVerifier } from "./secrets.ts";
import { getSettings, updateSettings } from "./store.ts";
import { hideLockView, showLockView } from "./windows.ts";

let lastActivity = Date.now();
const listeners = new Set<() => void>();

export function onLockChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function emit(): void {
  for (const l of listeners) l();
  ctx.mainWindow?.webContents.send("lumen:lock", ctx.locked);
}

export function lockEnabled(): boolean {
  return readPinVerifier() !== null;
}

export function touchIdAvailable(): boolean {
  return process.platform === "darwin" && systemPreferences.canPromptTouchID();
}

export function lock(reason: string): boolean {
  if (ctx.locked || !lockEnabled() || !ctx.mainWindow) return false;
  ctx.locked = true;
  log.info(`locked (${reason})`);
  if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) ctx.settingsWindow.close();
  if (ctx.pickerWindow && !ctx.pickerWindow.isDestroyed()) ctx.pickerWindow.close();
  showLockView();
  emit();
  return true;
}

function unlock(): void {
  ctx.locked = false;
  lastActivity = Date.now();
  hideLockView();
  emit();
  log.info("unlocked");
}

export function retryAfterMs(): number {
  return Math.max(0, getSettings().pinBlockedUntil - Date.now());
}

export async function unlockWithPin(pin: unknown): Promise<{ ok: boolean; retryAfterMs: number; error?: string }> {
  if (!ctx.locked) return { ok: true, retryAfterMs: 0 };
  const wait = retryAfterMs();
  if (wait > 0) return { ok: false, retryAfterMs: wait, error: "Too many wrong PINs. Wait, then try again." };
  const v = readPinVerifier();
  if (!v) {
    // The verifier is gone (e.g. removed from disk): nothing to check against.
    unlock();
    return { ok: true, retryAfterMs: 0 };
  }
  if (typeof pin === "string" && (await verifyPin(pin, v))) {
    updateSettings({ pinFailures: 0, pinBlockedUntil: 0 });
    unlock();
    return { ok: true, retryAfterMs: 0 };
  }
  const failures = getSettings().pinFailures + 1;
  const delay = backoffMs(failures);
  updateSettings({ pinFailures: failures, pinBlockedUntil: delay ? Date.now() + delay : 0 });
  log.warn(`wrong PIN (${failures} in a row)`);
  return { ok: false, retryAfterMs: delay, error: "Wrong PIN." };
}

export async function unlockWithTouchId(): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.locked) return { ok: true };
  if (!getSettings().touchId || !touchIdAvailable()) return { ok: false, error: "Touch ID is not available." };
  try {
    await systemPreferences.promptTouchID("unlock Lumen");
    unlock();
    return { ok: true };
  } catch {
    return { ok: false, error: "Touch ID didn't unlock the app. Use your PIN." };
  }
}

export async function setPin(current: unknown, next: unknown): Promise<{ ok: boolean; error?: string }> {
  const existing = readPinVerifier();
  if (existing && !(typeof current === "string" && (await verifyPin(current, existing)))) return { ok: false, error: "The current PIN is wrong." };
  const problem = pinProblem(next);
  if (problem) return { ok: false, error: problem };
  if (storageProtection().level === "unavailable") return { ok: false, error: "This system has no protected storage for the PIN." };
  writePinVerifier(await createPinVerifier(next as string));
  updateSettings({ pinFailures: 0, pinBlockedUntil: 0 });
  log.info("app lock PIN set");
  emit();
  return { ok: true };
}

export async function removePin(current: unknown): Promise<{ ok: boolean; error?: string }> {
  const existing = readPinVerifier();
  if (!existing) return { ok: true };
  if (!(typeof current === "string" && (await verifyPin(current, existing)))) return { ok: false, error: "The current PIN is wrong." };
  writePinVerifier(null);
  updateSettings({ touchId: false });
  log.info("app lock PIN removed");
  emit();
  return { ok: true };
}

/** Input in the app (reported by the main window's preload, throttled). */
export function noteActivity(): void {
  lastActivity = Date.now();
}

export function startAutoLock(): void {
  setInterval(() => {
    const minutes = getSettings().autoLockMinutes;
    if (!ctx.locked && minutes > 0 && Date.now() - lastActivity >= minutes * 60_000) lock("inactivity");
  }, 15_000).unref();
  const onOsLock = (why: string) => () => {
    if (getSettings().lockOnSuspend) lock(why);
  };
  powerMonitor.on("lock-screen", onOsLock("screen locked"));
  powerMonitor.on("suspend", onOsLock("suspend"));
  ctx.mainWindow?.on("focus", noteActivity);
}
