/**
 * Encryption set-up flows built on matrix-js-sdk's CryptoApi (Rust crypto).
 * No cryptography is implemented here; this only sequences SDK calls safely.
 */
import type { MatrixClient } from "matrix-js-sdk";
import {
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  ImportRoomKeyStage,
  type GeneratedSecretStorageKey,
  type ImportRoomKeyProgressData,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage.js";
import { cacheSecretStorageKey, withSecretStorageKeyCache } from "./secret-storage";
import { uiaCallback } from "./uia";

export class RecoveryKeyError extends Error {
  override name = "RecoveryKeyError";
}

function cryptoOf(client: MatrixClient) {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Encryption is not available");
  return crypto;
}

/** Generates a new random recovery key (secret-storage key). Nothing is uploaded yet. */
export function generateRecoveryKey(client: MatrixClient): Promise<GeneratedSecretStorageKey> {
  return cryptoOf(client).createRecoveryKeyFromPassphrase();
}

/** Normalises a typed recovery key for comparison (spaces/case-insensitive). */
export function normaliseRecoveryKey(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

/** Turns what the user typed into secret-storage key bytes (recovery key, or passphrase if the key has one). */
export async function keyFromUserInput(input: string, info: SecretStorageKeyDescription): Promise<Uint8Array<ArrayBuffer>> {
  const trimmed = input.trim();
  try {
    return decodeRecoveryKey(normaliseRecoveryKey(trimmed));
  } catch {
    if (info.passphrase?.algorithm === "m.pbkdf2") {
      return deriveRecoveryKeyFromPassphrase(trimmed, info.passphrase.salt, info.passphrase.iterations, info.passphrase.bits);
    }
    throw new RecoveryKeyError("That isn't a valid recovery key. Check for typos.");
  }
}

/** Returns the checked key bytes for the account's default secret-storage key. */
export async function checkRecoveryInput(client: MatrixClient, input: string): Promise<{ keyId: string; key: Uint8Array<ArrayBuffer> }> {
  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) throw new RecoveryKeyError("No recovery key has been set up for this account yet.");
  const tuple = await client.secretStorage.getKey(keyId);
  if (!tuple) throw new RecoveryKeyError("Your secret storage key description is missing.");
  const info = tuple[1];
  const key = await keyFromUserInput(input, info);
  if (!(await client.secretStorage.checkKey(key, info))) {
    key.fill(0);
    throw new RecoveryKeyError("That recovery key doesn't match this account.");
  }
  return { keyId, key };
}

/**
 * First-time set-up or "change recovery key": creates cross-signing keys if the
 * account has none, then (re)creates secret storage protected by `key` and
 * makes sure a key backup exists.
 */
export async function setUpRecovery(client: MatrixClient, key: GeneratedSecretStorageKey): Promise<void> {
  const crypto = cryptoOf(client);
  const me = client.getSafeUserId();
  await withSecretStorageKeyCache(async () => {
    if (!(await crypto.userHasCrossSigningKeys(me, true))) {
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: uiaCallback(client, "Set up encryption for your account") });
    } else {
      const cs = await crypto.getCrossSigningStatus();
      const local = cs.privateKeysCachedLocally;
      if (!local.masterKey || !local.selfSigningKey || !local.userSigningKey) {
        throw new Error("Verify this device first: it doesn't hold your cross-signing keys yet.");
      }
    }
    const backupInfo = await crypto.getKeyBackupInfo();
    const backupKeyCached = (await crypto.getSessionBackupPrivateKey()) !== null;
    const backupTrusted = backupInfo ? (await crypto.isKeyBackupTrusted(backupInfo)).trusted : false;
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => key,
      setupNewSecretStorage: true,
      setupNewKeyBackup: !backupInfo || !backupKeyCached || !backupTrusted,
    });
    await crypto.checkKeyBackupAndEnable();
  });
}

/**
 * Resets the account's encryption identity (new cross-signing keys, new key
 * backup, old backups deleted) and protects it with the new recovery key.
 */
export async function resetEncryption(client: MatrixClient, key: GeneratedSecretStorageKey): Promise<void> {
  const crypto = cryptoOf(client);
  await withSecretStorageKeyCache(async () => {
    await crypto.resetEncryption(uiaCallback(client, "Reset your encryption identity"));
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => key,
      setupNewSecretStorage: true,
      setupNewKeyBackup: false,
    });
    await crypto.checkKeyBackupAndEnable();
  });
}

export interface RestoreProgress {
  stage: "fetch" | "load";
  done: number;
  total: number;
}

function progressAdapter(onProgress?: (p: RestoreProgress) => void) {
  return (p: ImportRoomKeyProgressData) => {
    if (!onProgress) return;
    if (p.stage === ImportRoomKeyStage.Fetch) onProgress({ stage: "fetch", done: 0, total: 0 });
    else onProgress({ stage: "load", done: p.successes + p.failures, total: p.total });
  };
}

/**
 * "Verify this device with your recovery key": imports the cross-signing keys
 * from secret storage (which signs this device), then enables and restores
 * the key backup.
 */
export async function verifyWithRecoveryKey(
  client: MatrixClient,
  input: string,
  onProgress?: (p: RestoreProgress) => void,
): Promise<{ imported: number; total: number } | null> {
  const crypto = cryptoOf(client);
  const { keyId, key } = await checkRecoveryInput(client, input);
  return withSecretStorageKeyCache(async () => {
    cacheSecretStorageKey(keyId, key);
    const status = await crypto.getCrossSigningStatus();
    if (!status.privateKeysInSecretStorage) {
      // Never call bootstrapCrossSigning here without the keys in secret
      // storage: it would silently create a brand-new identity.
      throw new RecoveryKeyError("Your recovery key is correct, but your secret storage doesn't contain your cross-signing keys. Verify with another device instead.");
    }
    await crypto.bootstrapCrossSigning({});
    return restoreFromBackupInner(client, onProgress);
  });
}

async function restoreFromBackupInner(client: MatrixClient, onProgress?: (p: RestoreProgress) => void) {
  const crypto = cryptoOf(client);
  const info = await crypto.getKeyBackupInfo();
  if (!info) return null;
  if (!(await crypto.getSessionBackupPrivateKey())) {
    try {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    } catch {
      return null; // no usable backup key in secret storage
    }
  }
  await crypto.checkKeyBackupAndEnable();
  const res = await crypto.restoreKeyBackup({ progressCallback: progressAdapter(onProgress) });
  return { imported: res.imported, total: res.total };
}

/** Restores keys from the backup (asks for the recovery key through the prompt if needed). */
export async function restoreFromBackup(client: MatrixClient, onProgress?: (p: RestoreProgress) => void) {
  return withSecretStorageKeyCache(() => restoreFromBackupInner(client, onProgress));
}
