/** MatrixClient lifecycle: create, start (Rust crypto + sync), sign out, wipe. */
import {
  ClientEvent,
  createClient,
  IndexedDBStore,
  MemoryStore,
  PendingEventOrdering,
  SyncState,
  type MatrixClient,
} from "matrix-js-sdk";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { deleteDb } from "../lib/idb";
import { clearDrafts } from "../lib/drafts";
import { clearSession, type Session } from "../lib/session-store";
import { clearMediaCache } from "./media";
import { clearAllCallPrefs } from "../calls/prefs";
import { clearSecretStorageKeyCache, cryptoCallbacks } from "./secret-storage";
import { desktopApi } from "../platform/desktop";

export const CRYPTO_DB_PREFIX = "lumen-crypto";
const SYNC_DB_NAME = "lumen-sync";

/** Names of every IndexedDB database this app creates for an account. */
export const LOCAL_DATABASES = [
  `matrix-js-sdk:${SYNC_DB_NAME}`,
  `${CRYPTO_DB_PREFIX}::matrix-sdk-crypto`,
  `${CRYPTO_DB_PREFIX}::matrix-sdk-crypto-meta`,
];

export type StartupStage = "store" | "crypto" | "sync";

export async function createMatrixClient(session: Session, onStage?: (s: StartupStage) => void): Promise<MatrixClient> {
  onStage?.("store");
  let store: IndexedDBStore | MemoryStore;
  try {
    const idb = new IndexedDBStore({ indexedDB: window.indexedDB, dbName: SYNC_DB_NAME, localStorage: window.localStorage });
    await idb.startup();
    store = idb;
  } catch {
    // e.g. private browsing without IndexedDB: fall back to memory (slower start-up, same security)
    store = new MemoryStore({ localStorage: window.localStorage });
  }
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    store,
    timelineSupport: true,
    cryptoCallbacks,
    verificationMethods: [VerificationMethod.Sas],
    // Calls are MatrixRTC (LiveKit) only: the legacy 1:1 VoIP stack (MatrixCall, TURN
    // lookups) is never started. Incoming legacy invites get an "unsupported" notice.
    disableVoip: true,
  });
  onStage?.("crypto");
  await client.initRustCrypto({ storagePassword: session.storagePassword, cryptoDatabasePrefix: CRYPTO_DB_PREFIX });
  return client;
}

/** Starts syncing and resolves once the first sync has been processed (or failed with cached data). */
export async function startSyncing(client: MatrixClient): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        client.off(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === SyncState.Error && client.getRooms().length > 0) {
        // offline with cached data: show what we have, the banner shows the error
        client.off(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === SyncState.Error && (data?.error as { errcode?: string } | undefined)?.errcode === "M_UNKNOWN_TOKEN") {
        client.off(ClientEvent.Sync, onSync);
        reject(data?.error);
      }
    };
    client.on(ClientEvent.Sync, onSync);
  });
  await client.startClient({
    initialSyncLimit: 20,
    lazyLoadMembers: true,
    pendingEventOrdering: PendingEventOrdering.Detached,
    threadSupport: false,
  });
  await ready;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** Deletes leftover databases (e.g. from an interrupted sign-out). Only call when no client is running. */
export async function deleteLocalDatabases(): Promise<void> {
  await Promise.all(LOCAL_DATABASES.map((n) => deleteDb(n).catch(() => undefined)));
}

/**
 * Deletes every local trace of an account. The pickle key and the sealed secrets go first:
 * without them the access token and the crypto-store password are unrecoverable, so anything
 * still on disk is unreadable even if deleting it is delayed (the Rust crypto store can stay
 * open for a while after the client stops; its deletion then completes in the background,
 * or on the next start).
 */
export async function wipeLocalData(client?: MatrixClient | null): Promise<void> {
  clearSecretStorageKeyCache();
  clearMediaCache();
  clearDrafts();
  clearAllCallPrefs();
  client?.stopClient();
  await clearSession();
  if (client) {
    try {
      await withTimeout(client.clearStores({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX }), 1000);
    } catch {
      /* fall through to deleting the databases directly */
    }
  }
  await withTimeout(deleteLocalDatabases(), 1000);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("mxjssdk_")) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

const SIGNED_OUT_NOTICE = "lumen-signed-out-notice";

/** Reloads the app on the sign-in screen, dropping everything held in memory. */
export function reloadSignedOut(notice: string): void {
  const reload = () => {
    try {
      sessionStorage.setItem(SIGNED_OUT_NOTICE, notice);
    } catch {
      /* ignore */
    }
    window.location.replace(`${window.location.origin}/`);
  };
  // Desktop app: it also deletes its store key and clears the app origin's browser storage
  // (session storage included) before the reload.
  const desktop = desktopApi();
  if (desktop) void desktop.signedOut().catch(() => undefined).finally(reload);
  else reload();
}

export function takeSignedOutNotice(): string | null {
  try {
    const n = sessionStorage.getItem(SIGNED_OUT_NOTICE);
    sessionStorage.removeItem(SIGNED_OUT_NOTICE);
    return n;
  } catch {
    return null;
  }
}

/** Signs out on the server (invalidating the access token and device) and wipes local data. */
export async function signOut(client: MatrixClient): Promise<void> {
  await client.logout(true);
  await wipeLocalData(client);
}
