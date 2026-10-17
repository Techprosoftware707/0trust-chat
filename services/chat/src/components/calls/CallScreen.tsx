/**
 * The in-call UI: full screen (1:1 and group layouts, screen-share stage) or a floating mini
 * card while chatting. Remote audio always plays, whichever view is shown.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionQuality } from "livekit-client";
import {
  Activity,
  AlertTriangle,
  SwitchCamera,
  Lock,
  Maximize,
  Maximize2,
  Mic,
  MicOff,
  Minimize,
  Minimize2,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Settings,
  ShieldAlert,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import type { CallParticipant, CallSession, CallSnapshot } from "../../calls/CallSession";
import { dismissEndedCall } from "../../calls/controller";
import { callEncryptionLabel } from "../../calls/e2ee";
import { setCallView, useCallSnapshot, useCallView } from "../../calls/store";
import { formatDuration } from "../../lib/format";
import { useMatrix } from "../../matrix/context";
import { dmPartner } from "../../matrix/rooms";
import { Avatar } from "../primitives/Avatar";
import { Spinner } from "../primitives/Spinner";
import { TrustBadge } from "../room/RoomHeader";
import { useUi } from "../UiContext";
import { CallDeviceSettings } from "./CallDeviceSettings";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { TrackAudio, TrackVideo, useCameras } from "./media";
import { setCallPrefs } from "../../calls/prefs";

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

function statusText(s: CallSnapshot, now: number): string {
  switch (s.phase) {
    case "starting":
      return "Starting…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "ended":
      return s.endReason ?? "Call ended";
    case "connected":
      if (s.ringing) return "Ringing…";
      return s.connectedAt ? formatDuration((now - s.connectedAt) / 1000) : "Connected";
  }
}

const QUALITY_TEXT: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: "Excellent connection",
  [ConnectionQuality.Good]: "Good connection",
  [ConnectionQuality.Poor]: "Poor connection",
  [ConnectionQuality.Lost]: "Connection lost",
  [ConnectionQuality.Unknown]: "",
};

/** Signal bars from the media server's own connection-quality score (server data). */
function QualityBars({ q }: { q: ConnectionQuality }) {
  if (q === ConnectionQuality.Unknown) return null;
  const n = q === ConnectionQuality.Excellent ? 3 : q === ConnectionQuality.Good ? 2 : q === ConnectionQuality.Poor ? 1 : 0;
  return (
    <span className={`q-bars q${n}`} role="img" aria-label={QUALITY_TEXT[q]} title={QUALITY_TEXT[q]}>
      <i />
      <i />
      <i />
    </span>
  );
}

function encryptionWarning(p: CallParticipant): string | null {
  switch (p.encryption) {
    case "encrypted":
      return null;
    case "waiting-for-key":
      return p.keyOverdue ? "Still no encryption key from this person — their media can't be played. Their app may not support encrypted calls." : null;
    case "decrypt-error":
      return "Can't decrypt this person's media.";
    case "not-encrypted":
      return "This person's media isn't end-to-end encrypted.";
    case "unknown":
      return "Connected to the media server without a call membership (never joined over Matrix, or removed from the conversation). It gets no new encryption keys, and its audio and video are not played here.";
  }
}

export function CallTile({ p, large, screen, avatarMxc }: { p: CallParticipant; large?: boolean; screen?: boolean; avatarMxc?: string | null }) {
  const track = screen ? p.screenTrack : p.cameraTrack;
  const warn = p.isLocal ? null : encryptionWarning(p);
  const label = screen ? `${p.name}'s screen` : p.isLocal ? `${p.name} (you)` : p.name;
  return (
    <figure
      className={`call-tile${large ? " large" : ""}${screen ? " screen" : ""}${track ? " has-video" : ""}${p.speaking && !screen ? " speaking" : ""}${p.pending ? " pending" : ""}${p.encryption === "unknown" ? " unknown" : ""}`}
      data-identity={p.identity}
      data-participant={p.userId ?? ""}
      data-encryption={p.encryption}
      data-key-index={p.keyIndex ?? ""}
      data-mic={p.micMuted ? "muted" : "on"}
      aria-label={label}
    >
      {track ? (
        <TrackVideo track={track} mirror={p.isLocal && !screen} fit={screen ? "contain" : "cover"} label={label} />
      ) : (
        <div className="tile-avatar">
          <Avatar name={p.name} seed={p.userId ?? p.identity} mxc={avatarMxc} size={large ? 112 : 64} />
        </div>
      )}
      <figcaption className="tile-caption">
        {screen ? null : p.encryption === "unknown" ? (
          <VolumeX className="tile-icon warn" aria-label="Not played" />
        ) : p.micMuted ? (
          <MicOff className="tile-icon muted" aria-label="Microphone off" />
        ) : (
          <Mic className="tile-icon" aria-label="Microphone on" />
        )}
        <span className="tile-name">{label}</span>
        {!screen && p.cameraMuted && !p.pending && p.encryption !== "unknown" ? <VideoOff className="tile-icon" aria-label="Camera off" /> : null}
        {!p.pending ? <QualityBars q={p.quality} /> : null}
        {warn ? <ShieldAlert className="tile-icon warn" aria-label={warn} /> : null}
      </figcaption>
      {p.pending ? (
        <div className="tile-overlay">
          <Spinner size="sm" label="Connecting…" />
        </div>
      ) : null}
      {warn && !p.isLocal && !screen ? <p className="tile-warning">{warn}</p> : null}
    </figure>
  );
}

function EncryptionStatus({ s }: { s: CallSnapshot }) {
  switch (callEncryptionLabel(s)) {
    case "none":
      return null;
    case "not-encrypted":
      return (
        <span className="badge badge-danger call-badge">
          <ShieldAlert aria-hidden="true" /> Not encrypted
        </span>
      );
    case "setting-up":
      return (
        <span className="badge call-badge">
          <Lock aria-hidden="true" /> Setting up encryption…
        </span>
      );
    case "ready":
      return (
        <span className="badge call-badge" title="Your media is encrypted on this device. The badge turns green once others' media is being decrypted.">
          <Lock aria-hidden="true" /> Encryption ready
        </span>
      );
    case "exchanging-keys":
      return (
        <span className="badge call-badge" title="Keys are being exchanged with the people who just joined.">
          <Lock aria-hidden="true" /> Exchanging encryption keys…
        </span>
      );
    case "encrypted":
      return (
        <span className="badge badge-success call-badge" data-testid="call-e2ee" title="Your media is encrypted on this device, and every other participant's media is being decrypted with keys exchanged over encrypted Matrix messages.">
          <Lock aria-hidden="true" /> End-to-end encrypted
        </span>
      );
    case "incomplete":
      return (
        <span className="badge badge-warning call-badge" data-testid="call-e2ee-warning">
          <ShieldAlert aria-hidden="true" /> Encryption incomplete: {s.e2ee.remoteEncrypted} of {s.e2ee.remoteTotal} decrypting
        </span>
      );
  }
}

function CtlButton({ label, pressed, onClick, children, variant, disabled, title }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode; variant?: "off" | "danger" | "warn"; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className={`call-btn${variant ? ` ${variant}` : ""}`} aria-label={label} title={title ?? label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function Controls({ session, s, compact }: { session: CallSession; s: CallSnapshot; compact?: boolean }) {
  const micOn = s.mic.state === "on";
  const camOn = s.camera.state === "on";
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const ended = s.phase === "ended";
  const cams = useCameras();
  return (
    <div className={`call-controls${compact ? " compact" : ""}`} role="toolbar" aria-label="Call controls">
      <CtlButton
        label={s.mic.state === "unavailable" ? "Microphone unavailable — try again" : micOn ? "Mute microphone" : "Unmute microphone"}
        title={s.mic.error ?? undefined}
        pressed={!micOn}
        variant={s.mic.state === "unavailable" ? "warn" : micOn ? undefined : "off"}
        disabled={ended || s.mic.state === "starting"}
        onClick={() => void session.setMicEnabled(!micOn)}
      >
        {micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
      </CtlButton>
      <CtlButton
        label={camOn ? "Turn camera off" : s.camera.state === "unavailable" ? "Camera unavailable — try again" : "Turn camera on"}
        title={s.camera.error ?? undefined}
        pressed={!camOn}
        variant={s.camera.state === "unavailable" ? "warn" : camOn ? undefined : "off"}
        disabled={ended}
        onClick={() => void session.setCameraEnabled(!camOn)}
      >
        {camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}
      </CtlButton>
      {!compact && camOn && cams.length > 1 ? (
        <CtlButton
          label="Switch camera"
          disabled={ended}
          onClick={() => {
            const current = session.localVideoTrack?.mediaStreamTrack.getSettings().deviceId;
            const i = cams.findIndex((c) => c.deviceId === current);
            const next = cams[(i + 1) % cams.length];
            setCallPrefs({ cameraDeviceId: next.deviceId });
            void session.switchDevice("videoinput", next.deviceId);
          }}
        >
          <SwitchCamera aria-hidden="true" />
        </CtlButton>
      ) : null}
      {!compact && canShare ? (
        <CtlButton label={s.screen.active ? "Stop sharing your screen" : "Share your screen"} pressed={s.screen.active} disabled={ended} onClick={() => void session.setScreenShare(!s.screen.active)}>
          {s.screen.active ? <MonitorOff aria-hidden="true" /> : <MonitorUp aria-hidden="true" />}
        </CtlButton>
      ) : null}
      {ended ? (
        <button type="button" className="btn btn-sm call-close-btn" onClick={dismissEndedCall}>
          Close
        </button>
      ) : (
        <CtlButton label="Leave call" variant="danger" onClick={() => void session.leave()}>
          <PhoneOff aria-hidden="true" />
        </CtlButton>
      )}
    </div>
  );
}

type Panel = "people" | "diagnostics" | "settings" | null;

function PeoplePanel({ s }: { s: CallSnapshot }) {
  const { client } = useMatrix();
  const room = client.getRoom(s.roomId);
  return (
    <ul className="list-plain call-people">
      {s.participants.map((p) => {
        const warn = p.isLocal ? null : encryptionWarning(p);
        return (
          <li key={p.identity} className="call-person" data-participant={p.userId ?? ""}>
            <Avatar name={p.name} seed={p.userId ?? p.identity} mxc={p.userId ? room?.getMember(p.userId)?.getMxcAvatarUrl() : null} size={36} />
            <span className="call-person-main">
              <span className="call-person-name">
                {p.name}
                {p.isLocal ? " (you)" : ""}
              </span>
              <span className="xsmall muted">
                {p.pending ? "Connecting…" : `${p.micMuted ? "Muted" : "Mic on"} · ${p.cameraMuted ? "camera off" : "camera on"}${p.screenTrack ? " · sharing screen" : ""}`}
                {p.userId ? ` · ${p.userId}` : ""}
              </span>
              {warn ? (
                <span className="xsmall warn-text">
                  <ShieldAlert aria-hidden="true" /> {warn}
                </span>
              ) : !p.isLocal && !p.pending && p.encryption === "encrypted" ? (
                <span className="xsmall ok" data-key-index={p.keyIndex ?? ""}>
                  <Lock aria-hidden="true" /> Media decrypting (key #{p.keyIndex})
                </span>
              ) : !p.isLocal && !p.pending ? (
                <span className="xsmall muted">Exchanging encryption keys…</span>
              ) : null}
            </span>
            {!p.pending ? <QualityBars q={p.quality} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Stage({ s }: { s: CallSnapshot }) {
  const { client } = useMatrix();
  const room = client.getRoom(s.roomId);
  const mxc = (p: CallParticipant) => (p.userId ? (room?.getMember(p.userId)?.getMxcAvatarUrl() ?? null) : null);
  const local = s.participants.find((p) => p.isLocal);
  const remotes = s.participants.filter((p) => !p.isLocal);
  const sharer = s.participants.find((p) => p.screenTrack);
  if (sharer) {
    return (
      <div className="call-stage layout-screen">
        <div className="screen-main">
          <CallTile p={sharer} large screen />
        </div>
        <div className="filmstrip">
          {s.participants.map((p) => (
            <CallTile key={p.identity} p={p} avatarMxc={mxc(p)} />
          ))}
        </div>
      </div>
    );
  }
  if (remotes.length <= 1) {
    const other = remotes[0];
    return (
      <div className="call-stage layout-one">
        {other ? (
          <CallTile p={other} large avatarMxc={mxc(other)} />
        ) : (
          <div className="call-waiting">
            {room ? <Avatar name={room.name} seed={room.roomId} mxc={room.getMxcAvatarUrl()} size={112} /> : null}
            <p>{s.ringing ? "Ringing…" : s.phase === "connected" ? "Waiting for others to join…" : s.phase === "ended" ? (s.endReason ?? "Call ended") : "Connecting…"}</p>
          </div>
        )}
        {local ? (
          <div className="pip">
            <CallTile p={local} avatarMxc={mxc(local)} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`call-stage layout-grid n${Math.min(s.participants.length, 9)}`}>
      {s.participants.map((p) => (
        <CallTile key={p.identity} p={p} avatarMxc={mxc(p)} />
      ))}
    </div>
  );
}

function Banners({ session, s }: { session: CallSession; s: CallSnapshot }) {
  return (
    <div className="call-banners" aria-live="polite">
      {s.phase === "reconnecting" ? (
        <p className="call-banner warn" role="status" data-testid="call-reconnecting">
          <WifiOff aria-hidden="true" /> Reconnecting — the call continues as soon as your connection is back.
        </p>
      ) : null}
      {s.audioPlaybackBlocked ? (
        <p className="call-banner">
          <Volume2 aria-hidden="true" /> Your browser paused call audio.
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void session.startAudioPlayback()}>
            Play audio
          </button>
        </p>
      ) : null}
      {s.mic.state === "unavailable" && s.mic.error ? (
        <p className="call-banner warn" role="alert">
          <MicOff aria-hidden="true" /> {s.mic.error} Others can't hear you.
        </p>
      ) : null}
      {s.camera.state === "unavailable" && s.camera.error ? (
        <p className="call-banner warn" role="alert">
          <VideoOff aria-hidden="true" /> {s.camera.error}
        </p>
      ) : null}
      {s.screen.error ? (
        <p className="call-banner warn" role="alert">
          <MonitorOff aria-hidden="true" /> {s.screen.error}
        </p>
      ) : null}
      {s.e2ee.unknownConnections > 0 ? (
        <p className="call-banner" role="status">
          <ShieldAlert aria-hidden="true" /> {s.e2ee.unknownConnections === 1 ? "A connection" : `${s.e2ee.unknownConnections} connections`} on the media server didn't join through Matrix and gets no encryption keys.
        </p>
      ) : null}
      {s.notice ? (
        <p className="call-banner" role="status">
          <AlertTriangle aria-hidden="true" /> {s.notice}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => session.dismissNotice()}>
            <X aria-hidden="true" />
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * `embedded`: the screen fills a native app's call view (the mobile call widget), which owns the
 * window: no full-screen or minimise controls, always the full view.
 */
export function CallScreen({ session, embedded = false }: { session: CallSession; embedded?: boolean }) {
  const s = useCallSnapshot(session)!;
  const storedView = useCallView();
  const view = embedded ? "full" : storedView;
  const { client } = useMatrix();
  const ui = useUi();
  const [panel, setPanel] = useState<Panel>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const now = useNow(s.phase === "connected");
  const room = client.getRoom(s.roomId);
  const dmUser = room ? dmPartner(client, room) : null;
  const name = room?.name ?? "Call";

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Remote audio plays in both views.
  const sinks = s.participants
    .filter((p) => !p.isLocal)
    .flatMap((p) => [
      p.micTrack ? <TrackAudio key={`${p.identity}-mic`} track={p.micTrack} userId={p.userId} name={p.name} source="microphone" /> : null,
      p.screenAudioTrack ? <TrackAudio key={`${p.identity}-screen`} track={p.screenAudioTrack} userId={p.userId} name={p.name} source="screen_share_audio" /> : null,
    ]);

  if (view === "mini") {
    return (
      <aside className={`call-mini${s.phase === "reconnecting" ? " reconnecting" : ""}`} aria-label={`Call in ${name}`}>
        <div className="sinks">{sinks}</div>
        <button type="button" className="call-mini-main" onClick={() => setCallView("full")} aria-label="Return to the call">
          <Avatar name={name} seed={dmUser ?? s.roomId} mxc={room?.getMxcAvatarUrl()} size={36} />
          <span className="call-mini-text">
            <span className="call-mini-name">{name}</span>
            <span className="call-mini-status" role="status">
              {statusText(s, now)}
            </span>
          </span>
          <Maximize2 aria-hidden="true" />
        </button>
        <Controls session={session} s={s} compact />
      </aside>
    );
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void rootRef.current?.requestFullscreen().catch((e: unknown) => ui.reportError(e, "Couldn't switch to full screen"));
  };
  const panelBtn = (p: Exclude<Panel, null>, label: string, icon: ReactNode) => (
    <button type="button" className="icon-btn call-top-btn" aria-label={label} title={label} aria-pressed={panel === p} onClick={() => setPanel(panel === p ? null : p)}>
      {icon}
    </button>
  );

  return (
    <section ref={rootRef} className={`call-screen phase-${s.phase}${panel ? " with-panel" : ""}`} aria-label={`Call in ${name}`} data-phase={s.phase}>
      <div className="sinks">{sinks}</div>
      <header className="call-top">
        <div className="call-title">
          <h2 className="call-name">{name}</h2>
          <p className="call-status" role="status" aria-live="polite" data-testid="call-status">
            {statusText(s, now)}
            {s.stats && s.phase === "connected" && s.stats.verdict.label !== "unknown" ? <span className={`call-quality q-${s.stats.verdict.label}`}> · {s.stats.verdict.label === "good" ? "Good network" : s.stats.verdict.label === "fair" ? "Fair network" : "Poor network"}</span> : null}
          </p>
        </div>
        <div className="call-top-badges">
          <EncryptionStatus s={s} />
          {dmUser ? <TrustBadge userId={dmUser} onVerify={() => void ui.verifyUser(dmUser)} /> : null}
        </div>
        <div className="call-top-actions">
          {panelBtn("people", `Participants (${s.participants.length})`, <Users aria-hidden="true" />)}
          {panelBtn("diagnostics", "Call diagnostics", <Activity aria-hidden="true" />)}
          {panelBtn("settings", "Audio and video settings", <Settings aria-hidden="true" />)}
          {embedded ? null : (
            <>
              <button type="button" className="icon-btn call-top-btn" aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
              </button>
              <button type="button" className="icon-btn call-top-btn" aria-label="Minimise call (keep chatting)" title="Minimise call" onClick={() => setCallView("mini")}>
                <Minimize2 aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>
      <Banners session={session} s={s} />
      <div className="call-body">
        <Stage s={s} />
        {panel ? (
          <aside className="call-panel" aria-label={panel === "people" ? "Participants" : panel === "diagnostics" ? "Call diagnostics" : "Audio and video settings"}>
            <div className="call-panel-head">
              <h3>{panel === "people" ? `Participants (${s.participants.length})` : panel === "diagnostics" ? "Diagnostics" : "Audio and video"}</h3>
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Close panel" onClick={() => setPanel(null)}>
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="call-panel-body">
              {panel === "people" ? <PeoplePanel s={s} /> : null}
              {panel === "diagnostics" ? <DiagnosticsPanel snap={s} /> : null}
              {panel === "settings" ? (
                <CallDeviceSettings
                  micTrack={session.localAudioTrack?.mediaStreamTrack ?? null}
                  camTrack={session.localVideoTrack?.mediaStreamTrack ?? null}
                  onDevice={async (kind, id) => {
                    try {
                      if (kind === "audiooutput") await session.setSpeaker(id);
                      else await session.switchDevice(kind, id);
                    } catch (e) {
                      ui.reportError(e, "Couldn't switch the device");
                    }
                  }}
                  onAudioPrefs={() => session.applyAudioPrefs().catch((e: unknown) => ui.reportError(e, "Couldn't apply the audio settings"))}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
      <footer className="call-bottom">
        <Controls session={session} s={s} />
      </footer>
    </section>
  );
}
