/**
 * Persistent login session.
 *
 *  - localStorage "lumen-session": user ID, device ID, homeserver URL (not secret).
 *  - IndexedDB "lumen-session": a non-extractable AES-GCM CryptoKey plus the
 *    access token and the crypto-store password, both sealed with that key.
 */
import { deleteDb, idbDelete, idbGet, idbPut, openDb } from "./idb";
import { generatePickleKey, randomSecret, seal, unseal, type SealedSecret } from "./session-crypto";

export const SESSION_LS_KEY = "lumen-session";
const DB_NAME = "lumen-session";
const KEYS = "pickle-keys";
const SECRETS = "secrets";

export interface SessionMeta {
  v: 1;
  userId: string;
  deviceId: string;
  homeserverUrl: string;
}

export interface Session {
  userId: string;
  deviceId: string;
  homeserverUrl: string;
  accessToken: string;
  /** Password for the Rust crypto store (IndexedDB), random per device. */
  storagePassword: string;
}

interface StoredSecrets {
  accessToken: SealedSecret;
  storagePassword: SealedSecret;
}

const recordId = (m: Pick<SessionMeta, "userId" | "deviceId">) => `${m.userId}|${m.deviceId}`;
const ctx = (m: Pick<SessionMeta, "userId" | "deviceId">, what: string) => `lumen:${what}:${m.userId}:${m.deviceId}`;

function readMeta(): SessionMeta | null {
  try {
    const raw = localStorage.getItem(SESSION_LS_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SessionMeta;
    if (m?.v !== 1 || typeof m.userId !== "string" || typeof m.deviceId !== "string" || typeof m.homeserverUrl !== "string") {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

export function hasStoredSession(): boolean {
  return readMeta() !== null;
}

export function storedSessionMeta(): SessionMeta | null {
  return readMeta();
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb(DB_NAME, 1, [KEYS, SECRETS]);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export async function saveSession(meta: Omit<SessionMeta, "v">, accessToken: string): Promise<Session> {
  const m: SessionMeta = { v: 1, ...meta };
  const key = await generatePickleKey();
  const storagePassword = randomSecret(32);
  const secrets: StoredSecrets = {
    accessToken: await seal(key, accessToken, ctx(m, "access-token")),
    storagePassword: await seal(key, storagePassword, ctx(m, "storage-password")),
  };
  await withDb(async (db) => {
    await idbPut(db, KEYS, recordId(m), key);
    await idbPut(db, SECRETS, recordId(m), secrets);
  });
  localStorage.setItem(SESSION_LS_KEY, JSON.stringify(m));
  return { userId: m.userId, deviceId: m.deviceId, homeserverUrl: m.homeserverUrl, accessToken, storagePassword };
}

export class SessionUnavailableError extends Error {
  override name = "SessionUnavailableError";
}

/** Loads and decrypts the stored session, or returns null if there is none. */
export async function loadSession(): Promise<Session | null> {
  const m = readMeta();
  if (!m) return null;
  return withDb(async (db) => {
    const key = await idbGet<CryptoKey>(db, KEYS, recordId(m));
    const secrets = await idbGet<StoredSecrets>(db, SECRETS, recordId(m));
    if (!key || !secrets) throw new SessionUnavailableError("This browser no longer has the keys for your saved session.");
    try {
      return {
        userId: m.userId,
        deviceId: m.deviceId,
        homeserverUrl: m.homeserverUrl,
        accessToken: await unseal(key, secrets.accessToken, ctx(m, "access-token")),
        storagePassword: await unseal(key, secrets.storagePassword, ctx(m, "storage-password")),
      };
    } catch {
      throw new SessionUnavailableError("Your saved session could not be decrypted.");
    }
  });
}

/** Removes the session metadata, the sealed secrets and the pickle key. */
export async function clearSession(): Promise<void> {
  const m = readMeta();
  try {
    localStorage.removeItem(SESSION_LS_KEY);
  } catch {
    /* ignore */
  }
  if (m) {
    try {
      await withDb(async (db) => {
        await idbDelete(db, KEYS, recordId(m));
        await idbDelete(db, SECRETS, recordId(m));
      });
    } catch {
      /* fall through to deleting the whole database */
    }
  }
  await deleteDb(DB_NAME).catch(() => undefined);
}
