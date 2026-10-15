/**
 * Per-participant media keys for LiveKit's frame encryptor (AES-GCM in a worker).
 *
 * The keys themselves are created, rotated (on every membership change, so someone who left
 * can't decrypt media sent afterwards) and distributed by matrix-js-sdk's MatrixRTC encryption
 * manager over Olm-encrypted to-device messages; it reports each one with
 * `EncryptionKeyChanged(key, index, membership, backendIdentity)`. The backend identity equals
 * the participant's LiveKit identity, so we hand the raw key to LiveKit under it.
 *
 * Parameters match other MatrixRTC clients: raw 128-bit key imported as HKDF key material,
 * ratchet window 10, key ring of 256 indices, no shared key.
 */
import { BaseKeyProvider } from "livekit-client";

export class MatrixMediaKeyProvider extends BaseKeyProvider {
  /** identity -> highest key index received (for the encryption status display) */
  private readonly latest = new Map<string, { index: number; at: number }>();
  private readonly changeListeners = new Set<() => void>();

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 10, keyringSize: 256 });
  }

  async setMatrixKey(key: Uint8Array<ArrayBuffer>, index: number, identity: string): Promise<void> {
    const material = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(material, identity, index);
    const prev = this.latest.get(identity);
    // keys can arrive out of order; the display tracks the newest one
    if (!prev || index !== prev.index) this.latest.set(identity, { index, at: Date.now() });
    this.changeListeners.forEach((l) => l());
  }

  hasKeyFor(identity: string): boolean {
    return this.latest.has(identity);
  }

  keyInfo(identity: string): { index: number; at: number } | null {
    return this.latest.get(identity) ?? null;
  }

  onChange(l: () => void): () => void {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }
}
