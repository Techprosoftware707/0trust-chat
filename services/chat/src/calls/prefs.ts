/**
 * Call preferences, per user and per browser (localStorage `lumen-call-prefs:<user id>`).
 * Nothing secret: audio mode, processing switches, chosen device IDs (random per-origin
 * identifiers the browser gives this site) and video quality. Removed on sign-out.
 */
import { clearPrefStores, prefStore, usePrefStore, type PrefStore } from "../lib/prefs";

export type AudioMode = "voice" | "hifi";
export type VideoQuality = "auto" | "standard" | "hd" | "highest";

export interface CallPrefs {
  /** "voice" = HD Voice (default): speech-optimised Opus with full voice processing. */
  audioMode: AudioMode;
  /** Per-feature overrides; null = the mode's default (on for HD Voice, off for High-Fidelity). */
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  /** High-Fidelity: send stereo when the microphone delivers two channels. */
  hifiStereo: boolean;
  micDeviceId: string | null;
  cameraDeviceId: string | null;
  speakerDeviceId: string | null;
  videoQuality: VideoQuality;
  /** Ring for incoming 1:1 calls (only while this tab is open; muted rooms never ring). */
  ringtone: boolean;
  /** The first-call guidance in the lobby has been read. */
  onboarded: boolean;
}

export const DEFAULT_CALL_PREFS: CallPrefs = {
  audioMode: "voice",
  echoCancellation: null,
  noiseSuppression: null,
  autoGainControl: null,
  hifiStereo: false,
  micDeviceId: null,
  cameraDeviceId: null,
  speakerDeviceId: null,
  videoQuality: "auto",
  ringtone: true,
  onboarded: false,
};

const PREFIX = "lumen-call-prefs:";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const deviceId = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null);

export function parseCallPrefs(raw: unknown): CallPrefs {
  if (!isObj(raw)) return { ...DEFAULT_CALL_PREFS };
  return {
    audioMode: raw.audioMode === "hifi" ? "hifi" : "voice",
    echoCancellation: boolOrNull(raw.echoCancellation),
    noiseSuppression: boolOrNull(raw.noiseSuppression),
    autoGainControl: boolOrNull(raw.autoGainControl),
    hifiStereo: raw.hifiStereo === true,
    micDeviceId: deviceId(raw.micDeviceId),
    cameraDeviceId: deviceId(raw.cameraDeviceId),
    speakerDeviceId: deviceId(raw.speakerDeviceId),
    videoQuality: raw.videoQuality === "standard" || raw.videoQuality === "hd" || raw.videoQuality === "highest" ? raw.videoQuality : "auto",
    ringtone: raw.ringtone !== false,
    onboarded: raw.onboarded === true,
  };
}

let currentUser: string | null = null;

/** Called once the signed-in user is known. */
export function setCallPrefsUser(userId: string): void {
  currentUser = userId;
}

export function callPrefsStore(userId: string | null = currentUser): PrefStore<CallPrefs> {
  return prefStore(`${PREFIX}${userId ?? "anonymous"}`, parseCallPrefs);
}

export function getCallPrefs(): CallPrefs {
  return callPrefsStore().get();
}

export function setCallPrefs(patch: Partial<CallPrefs>): void {
  callPrefsStore().set(patch);
}

export function useCallPrefs(): CallPrefs {
  return usePrefStore(callPrefsStore());
}

export function clearAllCallPrefs(): void {
  clearPrefStores(PREFIX);
}

/** The effective processing switches for the current mode. */
export function effectiveProcessing(p: CallPrefs): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  const def = p.audioMode === "voice";
  return {
    echoCancellation: p.echoCancellation ?? def,
    noiseSuppression: p.noiseSuppression ?? def,
    autoGainControl: p.autoGainControl ?? def,
  };
}
