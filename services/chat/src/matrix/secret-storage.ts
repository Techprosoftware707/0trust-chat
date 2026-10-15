/**
 * Secret-storage key handling for matrix-js-sdk's `cryptoCallbacks`.
 *
 * The recovery key (secret-storage key) is only ever held in memory, and only
 * for the duration of one security operation (set-up, restore, reset); it is
 * never written to disk and never logged.
 */
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage.js";

type KeyBytes = Uint8Array<ArrayBuffer>;

/** Asks the user for the key; resolves with the key bytes (already checked) or null if cancelled. */
export type SecretStorageKeyPrompt = (keyId: string, keyInfo: SecretStorageKeyDescription) => Promise<KeyBytes | null>;

const cache = new Map<string, KeyBytes>();
let prompt: SecretStorageKeyPrompt | null = null;

export function setSecretStorageKeyPrompt(fn: SecretStorageKeyPrompt | null): void {
  prompt = fn;
}

export function cacheSecretStorageKey(keyId: string, key: KeyBytes): void {
  cache.set(keyId, key);
}

export function clearSecretStorageKeyCache(): void {
  for (const k of cache.values()) k.fill(0);
  cache.clear();
}

/** Runs `fn` with the key cache enabled and wipes the cached key afterwards. */
export async function withSecretStorageKeyCache<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    clearSecretStorageKeyCache();
  }
}

export const cryptoCallbacks: CryptoCallbacks = {
  async getSecretStorageKey({ keys }) {
    const ids = Object.keys(keys);
    for (const id of ids) {
      const k = cache.get(id);
      if (k) return [id, k];
    }
    if (!prompt || ids.length === 0) return null;
    const keyId = ids[0];
    const key = await prompt(keyId, keys[keyId]);
    if (!key) return null;
    cache.set(keyId, key);
    return [keyId, key];
  },
  cacheSecretStorageKey(keyId, _keyInfo, key) {
    cache.set(keyId, key);
  },
};
