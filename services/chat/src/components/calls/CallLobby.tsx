/**
 * Pre-join lobby: camera preview, microphone level, device choice and first-call guidance.
 * Capture only starts on a user action (opening the lobby from a call button counts; when the
 * browser would show a permission prompt, we first explain why and wait for an explicit click).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createLocalAudioTrack, createLocalVideoTrack, type LocalAudioTrack, type LocalVideoTrack } from "livekit-client";
import { Lock, Mic, MicOff, Phone, Settings2, Video, VideoOff } from "lucide-react";
import { startCall } from "../../calls/controller";
import { audioCaptureOptions, describeMediaError, resolveVideoProfile, videoCaptureOptions } from "../../calls/media";
import { getCallPrefs, setCallPrefs, useCallPrefs } from "../../calls/prefs";
import { closeLobby, type LobbyRequest } from "../../calls/store";
import { useMatrix } from "../../matrix/context";
import { dmPartner } from "../../matrix/rooms";
import { Avatar } from "../primitives/Avatar";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";
import { CallDeviceSettings } from "./CallDeviceSettings";
import { LevelMeter, TrackVideo } from "./media";

type Perm = PermissionState | "unknown";

async function permissionState(name: "microphone" | "camera"): Promise<Perm> {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return "unknown";
  }
}

export function CallLobby({ request }: { request: LobbyRequest }) {
  const { client, config, userId } = useMatrix();
  const ui = useUi();
  const prefs = useCallPrefs();
  const room = client.getRoom(request.roomId);
  const [audio, setAudio] = useState<LocalAudioTrack | null>(null);
  const [video, setVideo] = useState<LocalVideoTrack | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [wantVideo, setWantVideo] = useState(request.intent === "video");
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState<"checking" | "explain" | "capturing" | "ready">("checking");
  const [showSettings, setShowSettings] = useState(false);
  const [joining, setJoining] = useState(false);
  const handedOver = useRef(false);
  const tracks = useRef<{ a: LocalAudioTrack | null; v: LocalVideoTrack | null }>({ a: null, v: null });
  tracks.current = { a: audio, v: video };

  const captureAudio = useCallback(async (deviceId?: string | null) => {
    setMicError(null);
    try {
      const t = await createLocalAudioTrack(audioCaptureOptions(getCallPrefs(), deviceId));
      setAudio((old) => {
        old?.stop();
        return t;
      });
    } catch (e) {
      setAudio((old) => {
        old?.stop();
        return null;
      });
      setMicError(describeMediaError(e, "microphone"));
    }
  }, []);

  const captureVideo = useCallback(async (deviceId?: string | null) => {
    setCamError(null);
    try {
      const p = getCallPrefs();
      const t = await createLocalVideoTrack(videoCaptureOptions(resolveVideoProfile(p.videoQuality), deviceId ?? p.cameraDeviceId));
      setVideo((old) => {
        old?.stop();
        return t;
      });
    } catch (e) {
      setVideo((old) => {
        old?.stop();
        return null;
      });
      setCamError(describeMediaError(e, "camera"));
    }
  }, []);

  const capture = useCallback(async () => {
    setPhase("capturing");
    await captureAudio();
    if (wantVideo) await captureVideo();
    setPhase("ready");
  }, [captureAudio, captureVideo, wantVideo]);

  // Decide whether we may start capturing right away (permission already granted) or should
  // explain first (the browser would prompt).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const mic = await permissionState("microphone");
      const cam = request.intent === "video" ? await permissionState("camera") : "granted";
      if (!alive) return;
      if (mic === "granted" && cam === "granted" && getCallPrefs().onboarded) void capture();
      else setPhase("explain");
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop preview tracks unless they were handed to the call.
  useEffect(
    () => () => {
      if (!handedOver.current) {
        tracks.current.a?.stop();
        tracks.current.v?.stop();
      }
    },
    [],
  );

  if (!room) return null;
  const dmUser = dmPartner(client, room);
  const title = request.joining ? `Join call in ${room.name}` : dmUser ? `Call ${room.name}` : `Start a call in ${room.name}`;

  const join = async () => {
    setJoining(true);
    setCallPrefs({ onboarded: true });
    handedOver.current = true;
    closeLobby();
    if (muted && audio) await audio.mute();
    void startCall(client, config, room, {
      intent: wantVideo ? "video" : "audio",
      audioTrack: audio,
      videoTrack: wantVideo ? video : null,
      notify: !request.joining,
      startMuted: muted,
    }).catch((e: unknown) => ui.reportError(e, "Couldn't start the call"));
  };

  return (
    <Dialog title={title} description={request.joining ? "You'll join the people already in the call." : dmUser ? "They'll get a ringing call." : "Members will be notified."} onClose={closeLobby} size="lg" className="lobby-dialog" icon={wantVideo ? <Video /> : <Phone />}>
      <div className="lobby">
        <div className="lobby-preview">
          <div className="lobby-stage">
            {video && wantVideo ? (
              <TrackVideo track={video} mirror label="Your camera preview" />
            ) : (
              <div className="lobby-avatar">
                <Avatar name={room.getMember(userId)?.name ?? userId} seed={userId} mxc={room.getMember(userId)?.getMxcAvatarUrl()} size={88} />
                <p className="small">{wantVideo ? (camError ? "Camera unavailable" : phase === "capturing" ? "Starting camera…" : "Camera off") : "Voice call"}</p>
              </div>
            )}
            <div className="lobby-toggles">
              <button
                type="button"
                className={`call-btn${muted || !audio ? " off" : ""}`}
                aria-pressed={muted}
                disabled={!audio}
                aria-label={!audio ? "Microphone unavailable" : muted ? "Unmute microphone" : "Mute microphone"}
                title={!audio ? "Microphone unavailable" : muted ? "You'll join muted" : "Microphone on"}
                onClick={() => setMuted((m) => !m)}
              >
                {muted || !audio ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={`call-btn${!wantVideo || (camError && !video) ? " off" : ""}`}
                aria-pressed={!wantVideo}
                aria-label={wantVideo ? (camError && !video ? "Camera unavailable — turn video off" : "Turn camera off") : "Turn camera on"}
                onClick={() => {
                  if (wantVideo) {
                    video?.stop();
                    setVideo(null);
                    setWantVideo(false);
                  } else {
                    setWantVideo(true);
                    if (phase === "ready") void captureVideo();
                  }
                }}
              >
                {wantVideo && !(camError && !video) ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}
              </button>
            </div>
          </div>
          {audio ? (
            <div className="lobby-meter">
              <Mic aria-hidden="true" />
              <LevelMeter track={muted ? null : audio.mediaStreamTrack} />
              <span className="xsmall muted">{muted ? "Muted" : "Speak to test your microphone"}</span>
            </div>
          ) : null}
        </div>

        <div className="lobby-side stack">
          {phase === "checking" ? <Spinner label="Checking devices…" /> : null}
          {phase === "explain" ? (
            <div className="lobby-onboarding stack-sm">
              <h3>Before your first call</h3>
              <ul className="check-list small">
                <li>
                  <Mic aria-hidden="true" /> Your browser will ask to use your microphone{request.intent === "video" ? " and camera" : ""}. Nothing is captured until you allow it.
                </li>
                <li>
                  <Lock aria-hidden="true" /> Audio and video are encrypted on your device with keys shared only with the people in the call, so the media server can't decode them.
                </li>
                <li>
                  <Settings2 aria-hidden="true" /> Headphones give the best sound and avoid echo.
                </li>
              </ul>
              <button type="button" className="btn btn-primary" onClick={() => void capture()}>
                Allow {request.intent === "video" ? "microphone and camera" : "microphone"}
              </button>
            </div>
          ) : null}
          {phase === "capturing" ? <Spinner label="Starting your devices…" /> : null}
          {micError ? (
            <div className="alert alert-danger small" role="alert">
              <MicOff aria-hidden="true" />
              <span>
                {micError}
                <br />
                <button type="button" className="link-button" onClick={() => void captureAudio()}>
                  Try again
                </button>
              </span>
            </div>
          ) : null}
          {camError && wantVideo ? (
            <div className="alert alert-warning small" role="alert">
              <VideoOff aria-hidden="true" />
              <span>
                {camError}
                <br />
                <button type="button" className="link-button" onClick={() => void captureVideo()}>
                  Try again
                </button>
              </span>
            </div>
          ) : null}
          {phase === "ready" ? (
            <>
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
                <Settings2 aria-hidden="true" /> {showSettings ? "Hide device settings" : "Devices and audio quality"}
              </button>
              {showSettings ? (
                <CallDeviceSettings
                  compact
                  micTrack={audio?.mediaStreamTrack ?? null}
                  camTrack={video?.mediaStreamTrack ?? null}
                  showVideo={wantVideo}
                  onDevice={async (kind, id) => {
                    if (kind === "audioinput") await captureAudio(id);
                    if (kind === "videoinput") await captureVideo(id);
                  }}
                  onAudioPrefs={async () => {
                    if (audio) await audio.restartTrack(audioCaptureOptions(getCallPrefs(), (audio.mediaStreamTrack.getSettings().deviceId as string | undefined) ?? null));
                  }}
                />
              ) : (
                <p className="small muted">
                  {prefs.audioMode === "hifi" ? "High-Fidelity audio" : "HD Voice"} · {audio?.mediaStreamTrack.label || "no microphone"}
                  {wantVideo && video ? ` · ${video.mediaStreamTrack.label}` : ""}
                </p>
              )}
            </>
          ) : null}
          {phase === "explain" ? null : <p className="small lobby-e2ee">
            <Lock aria-hidden="true" /> Audio and video will be end-to-end encrypted — the call screen confirms it once keys have been exchanged with each participant.
          </p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={closeLobby}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={joining || phase === "checking" || phase === "capturing"} onClick={() => void join()}>
              {wantVideo ? <Video aria-hidden="true" /> : <Phone aria-hidden="true" />}
              {request.joining ? "Join call" : "Start call"}
              {!audio && phase === "ready" ? " without microphone" : ""}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
