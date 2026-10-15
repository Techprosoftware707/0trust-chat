/**
 * The call's overall media-encryption state — one definition for the call screen's badge
 * (web, desktop and the mobile call widget) and for the `io.lumen.call_state` value the
 * mobile apps show natively (CallKit / ConnectionService). Derived only from the session's
 * real key and track state (see CallSession), never from transport security.
 */
import type { CallSnapshot } from "./CallSession";

export type CallEncryptionLabel =
  /** own media encrypted; every other participant's media decrypting with keys received over Matrix */
  | "encrypted"
  /** keys are still being exchanged with people who just joined */
  | "exchanging-keys"
  /** some remote media is not decrypting (no key for too long, decryption errors, or unencrypted) */
  | "incomplete"
  /** encryption on, own key not set yet */
  | "setting-up"
  /** own key set, nobody else's media in the call yet */
  | "ready"
  /** the media connection is not end-to-end encrypted */
  | "not-encrypted"
  /** no running call (before connecting, or ended) */
  | "none";

export function callEncryptionLabel(s: CallSnapshot): CallEncryptionLabel {
  if (s.phase === "ended") return "none";
  if (!s.e2ee.enabled) return s.phase === "connected" ? "not-encrypted" : "none";
  if (!s.e2ee.ownKey) return "setting-up";
  if (s.e2ee.remoteTotal === 0) return "ready";
  if (s.e2ee.remoteEncrypted < s.e2ee.remoteTotal && s.e2ee.remoteEncrypted + s.e2ee.remoteWaiting === s.e2ee.remoteTotal) return "exchanging-keys";
  if (s.e2ee.remoteEncrypted === s.e2ee.remoteTotal) return "encrypted";
  return "incomplete";
}

/**
 * The `e2ee` value of `io.lumen.call_state` (docs/apps/integration.md §6.2), in the
 * vocabulary the apps parse: "encrypted" only when the call screen shows the green
 * "End-to-end encrypted" badge.
 */
export type CallE2eeWire = "encrypted" | "waiting-for-key" | "decrypt-error" | "not-encrypted" | "unknown";

export function callE2eeWire(s: CallSnapshot): CallE2eeWire {
  const label = callEncryptionLabel(s);
  switch (label) {
    case "encrypted":
      return "encrypted";
    case "not-encrypted":
      return "not-encrypted";
    case "none":
      return "unknown";
    case "setting-up":
    case "ready":
    case "exchanging-keys":
      return "waiting-for-key";
    case "incomplete": {
      const remote = s.participants.filter((p) => !p.isLocal && !p.pending);
      if (remote.some((p) => p.encryption === "not-encrypted")) return "not-encrypted";
      if (remote.some((p) => p.encryption === "decrypt-error")) return "decrypt-error";
      return "waiting-for-key";
    }
  }
}
