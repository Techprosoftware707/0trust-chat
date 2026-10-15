/**
 * Desktop settings (non-secret), stored as JSON in the user-data directory. Anything
 * unexpected in the file falls back to defaults, so a corrupted or hand-edited file can't
 * break the app or switch protections off.
 */

export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60] as const;

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DesktopSettings {
  v: 1;
  window: WindowState | null;
  /** Closing the window keeps the app running in the tray / menu bar. */
  closeToTray: boolean;
  trayHintShown: boolean;
  openAtLogin: boolean;
  doNotDisturb: boolean;
  /** Auto-lock after this many minutes without input in the app (only when a PIN is set); 0 = never. */
  autoLockMinutes: number;
  lockOnSuspend: boolean;
  touchId: boolean;
  /** Wrong PINs since the last successful unlock (back-off survives restarts). */
  pinFailures: number;
  pinBlockedUntil: number;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  v: 1,
  window: null,
  closeToTray: true,
  trayHintShown: false,
  openAtLogin: false,
  doNotDisturb: false,
  autoLockMinutes: 5,
  lockOnSuspend: true,
  touchId: false,
  pinFailures: 0,
  pinBlockedUntil: 0,
};

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

function int(v: unknown, d: number, min: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d;
}

export function parseWindowState(v: unknown): WindowState | null {
  if (typeof v !== "object" || v === null) return null;
  const w = v as Record<string, unknown>;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 100_000;
  if (!n(w.x) || !n(w.y) || !n(w.width) || !n(w.height)) return null;
  if ((w.width as number) < 320 || (w.height as number) < 240) return null;
  return { x: Math.round(w.x as number), y: Math.round(w.y as number), width: Math.round(w.width as number), height: Math.round(w.height as number), maximized: w.maximized === true };
}

export function parseSettings(raw: unknown): DesktopSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const autoLock = typeof r.autoLockMinutes === "number" && (r.autoLockMinutes === 0 || (AUTO_LOCK_CHOICES as readonly number[]).includes(r.autoLockMinutes)) ? r.autoLockMinutes : d.autoLockMinutes;
  return {
    v: 1,
    window: parseWindowState(r.window),
    closeToTray: bool(r.closeToTray, d.closeToTray),
    trayHintShown: bool(r.trayHintShown, d.trayHintShown),
    openAtLogin: bool(r.openAtLogin, d.openAtLogin),
    doNotDisturb: bool(r.doNotDisturb, d.doNotDisturb),
    autoLockMinutes: autoLock,
    lockOnSuspend: bool(r.lockOnSuspend, d.lockOnSuspend),
    touchId: bool(r.touchId, d.touchId),
    pinFailures: int(r.pinFailures, 0, 0, 1_000_000),
    pinBlockedUntil: int(r.pinBlockedUntil, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Keeps a restored window on a visible display; otherwise null (use the default placement). */
export function fitWindowState(
  w: WindowState | null,
  displays: { x: number; y: number; width: number; height: number }[],
): WindowState | null {
  if (!w) return null;
  const visible = displays.some((d) => {
    const ix = Math.max(0, Math.min(w.x + w.width, d.x + d.width) - Math.max(w.x, d.x));
    const iy = Math.max(0, Math.min(w.y + w.height, d.y + d.height) - Math.max(w.y, d.y));
    return ix >= 100 && iy >= 100;
  });
  return visible ? w : null;
}
