/** Starting and ending the (single) active call. */
import type { MatrixClient, Room } from "matrix-js-sdk";
import type { AppConfig } from "../config";
import { CallSession, type StartOptions } from "./CallSession";
import { getActiveCall, setActiveCall, setCallView } from "./store";

const ENDED_VISIBLE_MS = 3500;

export async function startCall(
  client: MatrixClient,
  config: AppConfig,
  room: Room,
  opts: StartOptions & { startMuted?: boolean },
): Promise<CallSession> {
  const current = getActiveCall();
  if (current && current.getSnapshot().phase !== "ended") {
    if (current.roomId === room.roomId) {
      setCallView("full");
      opts.audioTrack?.stop();
      opts.videoTrack?.stop();
      return current;
    }
    await current.leave("You joined another call");
  }
  const session = new CallSession(client, config, room, opts);
  setActiveCall(session);
  setCallView("full");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = session.subscribe(() => {
    const s = session.getSnapshot();
    if (s.phase === "ended" && !timer) {
      // A normal hang-up closes the call view after a moment; an error stays until dismissed.
      if (!s.error) timer = setTimeout(() => getActiveCall() === session && setActiveCall(null), ENDED_VISIBLE_MS);
      unsub();
    }
  });
  await session.start();
  if (opts.startMuted && session.getSnapshot().phase !== "ended") await session.setMicEnabled(false);
  return session;
}

export function dismissEndedCall(): void {
  const s = getActiveCall();
  if (s && s.getSnapshot().phase === "ended") setActiveCall(null);
}
