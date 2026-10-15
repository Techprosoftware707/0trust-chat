/**
 * `io.lumen.call_state` (widget → native) from the call session's snapshot, and the native
 * `io.lumen.call_action` controls applied to the session. The state carries no keys, tokens,
 * names or IDs: only what the native call UI (CallKit, ConnectionService) needs.
 */
import type { CallSession, CallSnapshot } from "../calls/CallSession";
import { callE2eeWire, callEncryptionLabel, type CallE2eeWire, type CallEncryptionLabel } from "../calls/e2ee";
import { listDevices } from "../calls/media";
import type { CallAction } from "./bridge";

export interface CallStateMessage {
  state: "connecting" | "connected" | "reconnecting" | "ended";
  video: boolean;
  muted: boolean;
  /** the apps' encryption value: "encrypted" only when the call screen shows "End-to-end encrypted" */
  e2ee: CallE2eeWire;
  /** the call screen's own label (finer-grained, informational) */
  e2eeLabel: CallEncryptionLabel;
  /** other participants with media, and how many of them are decrypting */
  remoteTotal: number;
  remoteEncrypted: number;
  /** ringing the other person of a 1:1 call (nobody answered yet) */
  ringing: boolean;
  /** why the call ended (shown to the user), and whether that was an error */
  reason: string | null;
  error: boolean;
}

export function toCallState(s: CallSnapshot): CallStateMessage {
  const state = s.phase === "ended" ? "ended" : s.phase === "connected" ? "connected" : s.phase === "reconnecting" ? "reconnecting" : "connecting";
  return {
    state,
    video: s.camera.state === "on",
    muted: s.mic.state !== "on",
    e2ee: callE2eeWire(s),
    e2eeLabel: callEncryptionLabel(s),
    remoteTotal: s.e2ee.remoteTotal,
    remoteEncrypted: s.e2ee.remoteEncrypted,
    ringing: s.ringing,
    reason: s.phase === "ended" ? s.endReason : null,
    error: s.phase === "ended" && !!s.error,
  };
}

/** Emits a call_state message now and whenever the derived state changes. */
export function watchCallState(session: CallSession, emit: (m: CallStateMessage) => void): () => void {
  let last = "";
  const push = () => {
    const m = toCallState(session.getSnapshot());
    const json = JSON.stringify(m);
    if (json === last) return;
    last = json;
    emit(m);
  };
  push();
  return session.subscribe(push);
}

/** The next camera after the current one (front ↔ back on phones). */
async function nextCamera(session: CallSession): Promise<string | null> {
  const cams = (await listDevices()).cams;
  if (cams.length < 2) return null;
  const current = session.localVideoTrack?.mediaStreamTrack.getSettings().deviceId;
  const i = cams.findIndex((c) => c.deviceId === current);
  return cams[(i + 1) % cams.length].deviceId;
}

export async function applyCallAction(session: CallSession, action: CallAction): Promise<void> {
  switch (action) {
    case "hangup":
      return session.leave();
    case "mute":
      return session.setMicEnabled(false);
    case "unmute":
      return session.setMicEnabled(true);
    case "video_on":
      return session.setCameraEnabled(true);
    case "video_off":
      return session.setCameraEnabled(false);
    case "switch_camera": {
      const id = await nextCamera(session);
      if (id) await session.switchDevice("videoinput", id);
      return;
    }
  }
}
