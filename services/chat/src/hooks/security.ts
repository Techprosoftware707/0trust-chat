/** The account's encryption set-up state, read from the Rust crypto layer. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientEvent, SyncState, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { CryptoEvent, type KeyBackupInfo } from "matrix-js-sdk/lib/crypto-api/index.js";

export interface SecurityState {
  loading: boolean;
  error: string | null;
  /** Cross-signing keys exist on the server for this account. */
  crossSigningExists: boolean;
  /** This device has the cross-signing keys and trusts them. */
  crossSigningReady: boolean;
  /** This device is signed by our own cross-signing identity. */
  thisDeviceVerified: boolean;
  /** The cross-signing private keys are stored in secret storage. */
  keysInSecretStorage: boolean;
  /** Secret storage holds everything it should (cross-signing + backup key). */
  secretStorageReady: boolean;
  /** Server-side key backup (if any) and whether this device is backing up to it. */
  backupInfo: KeyBackupInfo | null;
  backupActiveVersion: string | null;
  backupTrusted: boolean;
  backupKeyCached: boolean;
  sessionsRemaining: number | null;
  /** What the user should do next. */
  next: "setup" | "verify" | "backup" | "ok" | "unknown";
}

const INITIAL: SecurityState = {
  loading: true,
  error: null,
  crossSigningExists: false,
  crossSigningReady: false,
  thisDeviceVerified: false,
  keysInSecretStorage: false,
  secretStorageReady: false,
  backupInfo: null,
  backupActiveVersion: null,
  backupTrusted: false,
  backupKeyCached: false,
  sessionsRemaining: null,
  next: "unknown",
};

export async function readSecurityState(client: MatrixClient): Promise<Omit<SecurityState, "sessionsRemaining">> {
  const crypto = client.getCrypto();
  if (!crypto) return { ...INITIAL, loading: false, error: "Encryption is not available in this browser." };
  const me = client.getSafeUserId();
  const deviceId = client.getDeviceId()!;
  const [crossSigningExists, crossSigningReady, deviceStatus, csStatus, secretStorageReady, backupInfo, activeVersion, backupKey] =
    await Promise.all([
      crypto.userHasCrossSigningKeys(me, true),
      crypto.isCrossSigningReady(),
      crypto.getDeviceVerificationStatus(me, deviceId),
      crypto.getCrossSigningStatus(),
      crypto.isSecretStorageReady(),
      crypto.getKeyBackupInfo(),
      crypto.getActiveSessionBackupVersion(),
      crypto.getSessionBackupPrivateKey(),
    ]);
  const backupTrusted = backupInfo ? (await crypto.isKeyBackupTrusted(backupInfo)).trusted : false;
  const thisDeviceVerified = !!deviceStatus?.crossSigningVerified;
  let next: SecurityState["next"];
  if (!crossSigningExists) next = "setup";
  else if (!thisDeviceVerified) next = "verify";
  else if (!secretStorageReady || !backupInfo || !activeVersion) next = "backup";
  else next = "ok";
  return {
    loading: false,
    error: null,
    crossSigningExists,
    crossSigningReady,
    thisDeviceVerified,
    keysInSecretStorage: csStatus.privateKeysInSecretStorage,
    secretStorageReady,
    backupInfo,
    backupActiveVersion: activeVersion,
    backupTrusted,
    backupKeyCached: backupKey !== null,
    next,
  };
}

export function useSecurityState(client: MatrixClient): SecurityState & { refresh: () => void } {
  const [state, setState] = useState<SecurityState>(INITIAL);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const n = ++seq.current;
    readSecurityState(client)
      .then((s) => {
        if (n === seq.current) setState((prev) => ({ ...s, sessionsRemaining: prev.sessionsRemaining }));
      })
      .catch((e: unknown) => {
        if (n === seq.current) setState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
  }, [client]);

  useEffect(() => {
    refresh();
    // The SDK enables key backup asynchronously after start-up, possibly before we subscribed
    // to its events: check it explicitly once, then re-read the state.
    void client
      .getCrypto()
      ?.checkKeyBackupAndEnable()
      .catch(() => null)
      .finally(refresh);
    const me = client.getUserId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const onTrust = (userId: string) => userId === me && soon();
    const onDevices = (users: string[]) => me && users.includes(me) && soon();
    const onRemaining = (n: number) => setState((s) => ({ ...s, sessionsRemaining: n }));
    // Start-up may render from the cached sync before the first live sync: re-read when
    // secret-storage / cross-signing / backup account data arrives, and after the first live sync.
    const onAccountData = (ev: MatrixEvent) => {
      const t = ev.getType();
      if (t.startsWith("m.secret_storage.") || t.startsWith("m.cross_signing.") || t === "m.megolm_backup.v1") soon();
    };
    const onSync = (st: SyncState, prev: SyncState | null) => {
      if (st === SyncState.Syncing && prev !== SyncState.Syncing) soon();
    };
    client.on(ClientEvent.AccountData, onAccountData);
    client.on(ClientEvent.Sync, onSync);
    client.on(CryptoEvent.KeysChanged, soon);
    client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    client.on(CryptoEvent.DevicesUpdated, onDevices);
    client.on(CryptoEvent.KeyBackupStatus, soon);
    client.on(CryptoEvent.KeyBackupDecryptionKeyCached, soon);
    client.on(CryptoEvent.KeyBackupSessionsRemaining, onRemaining);
    return () => {
      if (timer) clearTimeout(timer);
      client.off(CryptoEvent.KeysChanged, soon);
      client.off(CryptoEvent.UserTrustStatusChanged, onTrust);
      client.off(CryptoEvent.DevicesUpdated, onDevices);
      client.off(CryptoEvent.KeyBackupStatus, soon);
      client.off(CryptoEvent.KeyBackupDecryptionKeyCached, soon);
      client.off(CryptoEvent.KeyBackupSessionsRemaining, onRemaining);
      client.off(ClientEvent.AccountData, onAccountData);
      client.off(ClientEvent.Sync, onSync);
    };
  }, [client, refresh]);

  return { ...state, refresh };
}
