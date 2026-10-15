/** Per-browser preferences (non-secret), stored in localStorage. */
import { useSyncExternalStore } from "react";

export interface Prefs {
  /** Desktop notifications (the browser permission is requested only when this is switched on). */
  notifications: boolean;
  /** Show message text in notifications. Off by default for privacy. */
  notificationPreviews: boolean;
  /** Public read receipts (off = private receipts: unread state still syncs across your devices). */
  sendReadReceipts: boolean;
  sendTypingNotifications: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  notifications: false,
  notificationPreviews: false,
  sendReadReceipts: true,
  sendTypingNotifications: true,
};

const KEY = "lumen-chat-prefs";
const listeners = new Set<() => void>();
let cache: Prefs | null = null;

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    const out = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
    }
    return out;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function getPrefs(): Prefs {
  if (!cache) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      /* storage disabled */
    }
    cache = parsePrefs(raw);
  }
  return cache;
}

export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage disabled: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function resetPrefs(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
