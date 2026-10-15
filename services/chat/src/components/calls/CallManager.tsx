import { useEffect, useReducer, useRef, useState } from "react";
import { CallEvent, type MatrixCall, type MatrixClient } from "matrix-js-sdk";
import { CallErrorCode, CallState, CallType } from "matrix-js-sdk/lib/webrtc/call.js";
import { CallEventHandlerEvent } from "matrix-js-sdk/lib/webrtc/callEventHandler.js";
import { Lock, Mic, MicOff, Phone, PhoneOff, ShieldAlert, Video, VideoOff } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { formatDuration, readMediaProtection, type MediaProtection } from "../../matrix/calls";
import { errorMessage } from "../../lib/errors";
import { Avatar } from "../primitives/Avatar";
import { Dialog } from "../primitives/Dialog";
import { useUi } from "../UiContext";
import { getActiveCall, setActiveCall, useActiveCall } from "./callStore";

/** Places a 1:1 call in a DM. */
export async function placeCall(client: MatrixClient, roomId: string, video: boolean): Promise<void> {
  if (getActiveCall()) throw new Error("You're already in a call.");
  const call = client.createCall(roomId);
  if (!call) throw new Error("Calls aren't supported in this browser.");
  setActiveCall(call);
  try {
    if (video) await call.placeVideoCall();
    else await call.placeVoiceCall();
  } catch (e) {
    setActiveCall(null);
    throw e;
  }
}

function useCallVersion(call: MatrixCall | null): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!call) return;
    const events = [CallEvent.State, CallEvent.FeedsChanged, CallEvent.Hangup, CallEvent.LocalHoldUnhold, CallEvent.RemoteHoldUnhold];
    for (const e of events) call.on(e as CallEvent.State, bump as never);
    return () => {
      for (const e of events) call.off(e as CallEvent.State, bump as never);
    };
  }, [call]);
  return v;
}

function MediaEl({ stream, kind, muted, className }: { stream: MediaStream | undefined; kind: "video" | "audio"; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);
  return kind === "video" ? (
    <video ref={ref} className={className} autoPlay playsInline muted={muted} />
  ) : (
    <audio ref={ref} autoPlay muted={muted} />
  );
}

const STATE_TEXT: Partial<Record<CallState, string>> = {
  [CallState.Fledgling]: "Starting…",
  [CallState.WaitLocalMedia]: "Waiting for your microphone/camera…",
  [CallState.CreateOffer]: "Calling…",
  [CallState.InviteSent]: "Calling…",
  [CallState.Ringing]: "Ringing…",
  [CallState.CreateAnswer]: "Connecting…",
  [CallState.Connecting]: "Connecting…",
  [CallState.Ended]: "Call ended",
};

function ProtectionBadge({ call }: { call: MatrixCall }) {
  const [p, setP] = useState<MediaProtection | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      void readMediaProtection(call.peerConn)
        .then((r) => alive && setP(r))
        .catch(() => undefined);
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [call]);
  if (p?.protectedMedia) {
    return (
      <span className="badge badge-success badge-plain" title={`DTLS ${p.tlsVersion ?? ""} ${p.dtlsCipher ?? ""}`.trim()}>
        <Lock aria-hidden="true" /> Media encrypted · DTLS-SRTP ({p.srtpCipher}){p.relayed ? " · via relay" : ""}
      </span>
    );
  }
  if (p?.dtlsState === "failed") {
    return (
      <span className="badge badge-danger badge-plain">
        <ShieldAlert aria-hidden="true" /> Media connection failed
      </span>
    );
  }
  return <span className="badge badge-plain">Checking media protection…</span>;
}

function CallView({ call }: { call: MatrixCall }) {
  const { client } = useMatrix();
  useCallVersion(call);
  const [length, setLength] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const room = client.getRoom(call.roomId);
  const name = room?.name ?? "Call";
  const video = call.type === CallType.Video;
  const remote = call.remoteUsermediaFeed?.stream;
  const local = call.localUsermediaFeed?.stream;
  const ended = call.state === CallState.Ended;

  useEffect(() => {
    const onLength = (l: number) => setLength(l);
    const onError = (e: Error) => setError(errorMessage(e));
    call.on(CallEvent.LengthChanged, onLength);
    call.on(CallEvent.Error, onError);
    return () => {
      call.off(CallEvent.LengthChanged, onLength);
      call.off(CallEvent.Error, onError);
    };
  }, [call]);

  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => getActiveCall() === call && setActiveCall(null), 2500);
    return () => clearTimeout(t);
  }, [ended, call]);

  const status = call.state === CallState.Connected ? formatDuration(length) : (STATE_TEXT[call.state] ?? call.state);
  const reason = ended && call.hangupReason && call.hangupReason !== CallErrorCode.UserHangup ? ` (${call.hangupReason.replace(/_/g, " ")})` : "";

  return (
    <section className={`call-view${video ? " video" : ""}`} aria-label={`Call with ${name}`}>
      <div className="call-stage">
        {video && remote ? (
          <MediaEl stream={remote} kind="video" className="call-remote" />
        ) : (
          <div className="call-avatar">
            <Avatar name={name} seed={call.roomId} mxc={room?.getMxcAvatarUrl()} size={88} />
          </div>
        )}
        {!video && remote ? <MediaEl stream={remote} kind="audio" /> : null}
        {video && local ? <MediaEl stream={local} kind="video" muted className="call-local" /> : null}
      </div>
      <div className="call-info">
        <p className="call-name">{name}</p>
        <p className="call-status" role="status" aria-live="polite">
          {status}
          {reason}
        </p>
        {call.state === CallState.Connected ? <ProtectionBadge call={call} /> : null}
        {error ? (
          <p className="form-error small" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="call-controls">
        {!ended ? (
          <>
            <button
              type="button"
              className="call-btn"
              aria-pressed={call.isMicrophoneMuted()}
              aria-label={call.isMicrophoneMuted() ? "Unmute microphone" : "Mute microphone"}
              onClick={() => void call.setMicrophoneMuted(!call.isMicrophoneMuted())}
            >
              {call.isMicrophoneMuted() ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
            {video ? (
              <button
                type="button"
                className="call-btn"
                aria-pressed={call.isLocalVideoMuted()}
                aria-label={call.isLocalVideoMuted() ? "Turn camera on" : "Turn camera off"}
                onClick={() => void call.setLocalVideoMuted(!call.isLocalVideoMuted())}
              >
                {call.isLocalVideoMuted() ? <VideoOff aria-hidden="true" /> : <Video aria-hidden="true" />}
              </button>
            ) : null}
            <button type="button" className="call-btn hangup" aria-label="Hang up" onClick={() => call.hangup(CallErrorCode.UserHangup, false)}>
              <PhoneOff aria-hidden="true" />
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setActiveCall(null)}>
            Close
          </button>
        )}
      </div>
    </section>
  );
}

function IncomingCall({ call, onDone }: { call: MatrixCall; onDone: () => void }) {
  const { client } = useMatrix();
  const ui = useUi();
  useCallVersion(call);
  const room = client.getRoom(call.roomId);
  const name = room?.name ?? "Someone";
  const video = call.type === CallType.Video;
  useEffect(() => {
    if (call.state === CallState.Ended) onDone();
  }, [call.state, onDone]);
  return (
    <Dialog title={`${name} is calling`} description={video ? "Video call" : "Voice call"} icon={video ? <Video /> : <Phone />} onClose={() => {
      call.reject();
      onDone();
    }} size="sm">
      <div className="verify-state">
        <Avatar name={name} seed={call.roomId} mxc={room?.getMxcAvatarUrl()} size={72} />
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              call.reject();
              onDone();
            }}
          >
            <PhoneOff aria-hidden="true" /> Decline
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setActiveCall(call);
              onDone();
              void Promise.resolve(call.answer(true, video)).catch((e: unknown) => ui.reportError(e, "Couldn't answer the call"));
            }}
          >
            <Phone aria-hidden="true" /> Answer
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Listens for incoming calls and shows the active call. Only mounted when VoIP is enabled. */
export function CallManager() {
  const { client } = useMatrix();
  const active = useActiveCall();
  const [incoming, setIncoming] = useState<MatrixCall | null>(null);
  useEffect(() => {
    const onIncoming = (call: MatrixCall) => {
      if (getActiveCall()) {
        // Already in a call: tell the caller we're busy.
        call.reject();
        return;
      }
      setIncoming(call);
    };
    client.on(CallEventHandlerEvent.Incoming, onIncoming);
    return () => {
      client.off(CallEventHandlerEvent.Incoming, onIncoming);
    };
  }, [client]);
  return (
    <>
      {incoming ? <IncomingCall call={incoming} onDone={() => setIncoming(null)} /> : null}
      {active ? <CallView call={active} /> : null}
    </>
  );
}
