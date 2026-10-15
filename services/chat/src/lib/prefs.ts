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

/**
 * A typed, validated preference record in localStorage under `key` (non-secret data only).
 * `parse` receives the stored JSON (or null) and must return a complete, valid record:
 * anything unexpected falls back to defaults, so a corrupted or hand-edited entry can't
 * break the app. Used for per-user preferences (e.g. `lumen-call-prefs:<user id>`).
 */
export interface PrefStore<T> {
  get(): T;
  set(patch: Partial<T>): void;
  reset(): void;
  subscribe(l: () => void): () => void;
}

const stores = new Map<string, PrefStore<unknown>>();

export function prefStore<T>(key: string, parse: (raw: unknown) => T): PrefStore<T> {
  const existing = stores.get(key);
  if (existing) return existing as PrefStore<T>;
  let value: T | null = null;
  const ls = new Set<() => void>();
  const read = (): T => {
    let raw: unknown;
    try {
      const s = localStorage.getItem(key);
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = null;
    }
    return parse(raw);
  };
  const store: PrefStore<T> = {
    get: () => (value ??= read()),
    set: (patch) => {
      value = parse({ ...(store.get() as object), ...patch });
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage disabled: keep in memory */
      }
      ls.forEach((l) => l());
    },
    reset: () => {
      value = null;
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      ls.forEach((l) => l());
    },
    subscribe: (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
  };
  stores.set(key, store as PrefStore<unknown>);
  return store;
}

export function usePrefStore<T>(store: PrefStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Removes every per-user preference record whose key starts with `prefix` (sign-out). */
export function clearPrefStores(prefix: string): void {
  for (const [k, s] of stores) if (k.startsWith(prefix)) s.reset();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
