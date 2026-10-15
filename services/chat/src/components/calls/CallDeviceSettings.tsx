/**
 * Audio/video device and quality settings, shared by the pre-join lobby, the in-call settings
 * sheet and Settings → Calls. Every value shown about the microphone is read back from the live
 * track (`MediaStreamTrack.getSettings()`), not assumed from what we asked for.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, Headphones, Info, Mic, Play, Speaker, Square, Video, Volume2 } from "lucide-react";
import { playTestTone, recordSample } from "../../calls/audio";
import { listDevices, looksLikeHeadphones, supportsConstraint, supportsOutputSelection, VIDEO_PROFILES } from "../../calls/media";
import { effectiveProcessing, setCallPrefs, useCallPrefs, type CallPrefs, type VideoQuality } from "../../calls/prefs";
import { errorMessage } from "../../lib/errors";
import { Toggle } from "../settings/Toggle";
import { LevelMeter } from "./media";

export interface DeviceSettingsProps {
  /** live microphone track (lobby/call), for the meter and read-back */
  micTrack: MediaStreamTrack | null;
  camTrack?: MediaStreamTrack | null;
  /** called after the user picked a device; returns once applied */
  onDevice?: (kind: "audioinput" | "videoinput" | "audiooutput", deviceId: string) => Promise<void> | void;
  /** audio mode / processing changed (re-apply to the live track) */
  onAudioPrefs?: () => Promise<void> | void;
  showVideo?: boolean;
  compact?: boolean;
}

function useDevices(dep: unknown) {
  const [devs, setDevs] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>({ mics: [], cams: [], speakers: [] });
  const refresh = useCallback(() => void listDevices().then(setDevs).catch(() => undefined), []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh, dep]);
  return devs;
}

function DeviceSelect({ label, icon, devices, value, onChange, emptyText }: { label: string; icon: React.ReactNode; devices: MediaDeviceInfo[]; value: string | null; onChange: (id: string) => void; emptyText: string }) {
  const id = useId();
  return (
    <div className="field device-field">
      <label htmlFor={id}>
        {icon} {label}
      </label>
      {devices.length ? (
        <select id={id} value={value ?? devices[0]?.deviceId ?? ""} onChange={(e) => onChange(e.target.value)}>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
      ) : (
        <p className="small muted">{emptyText}</p>
      )}
    </div>
  );
}

/** What the browser actually applied to the microphone track. */
function AppliedSettings({ track }: { track: MediaStreamTrack }) {
  const [s, setS] = useState<MediaTrackSettings>(() => track.getSettings());
  useEffect(() => {
    const t = setInterval(() => setS(track.getSettings()), 1000);
    return () => clearInterval(t);
  }, [track]);
  const on = (v: unknown) => (v === true ? "on" : v === false ? "off" : "not reported");
  const vi = (s as MediaTrackSettings & { voiceIsolation?: boolean }).voiceIsolation;
  return (
    <dl className="kv applied-settings" data-testid="applied-audio-settings">
      <dt>Echo cancellation</dt>
      <dd data-k="echoCancellation">{on(s.echoCancellation)}</dd>
      <dt>Noise suppression</dt>
      <dd data-k="noiseSuppression">{on(s.noiseSuppression)}</dd>
      <dt>Auto gain</dt>
      <dd data-k="autoGainControl">{on(s.autoGainControl)}</dd>
      <dt>Voice isolation</dt>
      <dd data-k="voiceIsolation">{supportsConstraint("voiceIsolation") ? on(vi) : "not supported by this browser"}</dd>
      <dt>Capture</dt>
      <dd data-k="capture">
        {s.sampleRate ? `${s.sampleRate / 1000} kHz` : "rate not reported"} · {s.channelCount === 2 ? "stereo" : s.channelCount === 1 ? "mono" : "channels not reported"}
      </dd>
    </dl>
  );
}

export function CallDeviceSettings({ micTrack, camTrack, onDevice, onAudioPrefs, showVideo = true, compact }: DeviceSettingsProps) {
  const prefs = useCallPrefs();
  const devs = useDevices(micTrack);
  const [busy, setBusy] = useState(false);
  const [toneError, setToneError] = useState<string | null>(null);
  const [recording, setRecording] = useState<"idle" | "recording" | "playing">("idle");
  const [playback, setPlayback] = useState<string | null>(null);
  const [speakerApplied, setSpeakerApplied] = useState<string | null>(null);
  const outputSelectable = supportsOutputSelection();
  const proc = effectiveProcessing(prefs);
  const micId = (micTrack?.getSettings().deviceId as string | undefined) ?? prefs.micDeviceId;
  const camId = (camTrack?.getSettings().deviceId as string | undefined) ?? prefs.cameraDeviceId;
  const speaker = devs.speakers.find((d) => d.deviceId === (prefs.speakerDeviceId ?? "default")) ?? devs.speakers[0];
  const echoRisk = !proc.echoCancellation && !looksLikeHeadphones(speaker?.label);
  const stereoCapable = (() => {
    const caps = micTrack?.getCapabilities?.() as (MediaTrackCapabilities & { channelCount?: { max?: number } }) | undefined;
    return (caps?.channelCount?.max ?? 1) >= 2;
  })();

  useEffect(() => () => {
    if (playback) URL.revokeObjectURL(playback);
  }, [playback]);

  const applyAudio = async (patch: Partial<CallPrefs>) => {
    setCallPrefs(patch);
    if (!onAudioPrefs) return;
    setBusy(true);
    try {
      await onAudioPrefs();
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind: "audioinput" | "videoinput" | "audiooutput", id: string) => {
    if (kind === "audioinput") setCallPrefs({ micDeviceId: id });
    if (kind === "videoinput") setCallPrefs({ cameraDeviceId: id });
    if (kind === "audiooutput") setCallPrefs({ speakerDeviceId: id });
    setBusy(true);
    try {
      await onDevice?.(kind, id);
      if (kind === "audiooutput") setSpeakerApplied(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`device-settings stack${compact ? " compact" : ""}`} aria-busy={busy}>
      <section className="stack-sm" aria-label="Microphone">
        <DeviceSelect label="Microphone" icon={<Mic aria-hidden="true" />} devices={devs.mics} value={micId} onChange={(id) => void pick("audioinput", id)} emptyText="No microphone available (or access not granted yet)." />
        {micTrack ? (
          <div className="cluster mic-test">
            <LevelMeter track={micTrack} />
            <button
              type="button"
              className="btn btn-sm"
              disabled={recording !== "idle"}
              onClick={async () => {
                setRecording("recording");
                try {
                  if (playback) URL.revokeObjectURL(playback);
                  const url = await recordSample(micTrack, 3);
                  setPlayback(url);
                  setRecording("playing");
                  const a = new Audio(url);
                  const sink = prefs.speakerDeviceId;
                  if (sink && "setSinkId" in a) await (a as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sink).catch(() => undefined);
                  a.onended = () => setRecording("idle");
                  await a.play().catch(() => setRecording("idle"));
                } catch (e) {
                  setToneError(errorMessage(e));
                  setRecording("idle");
                }
              }}
            >
              {recording === "recording" ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
              {recording === "recording" ? "Recording 3 s…" : recording === "playing" ? "Playing back…" : "Test: record 3 s and play back"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="stack-sm" aria-label="Speaker or headphones">
        {outputSelectable ? (
          <DeviceSelect label="Speaker or headphones" icon={<Speaker aria-hidden="true" />} devices={devs.speakers} value={prefs.speakerDeviceId} onChange={(id) => void pick("audiooutput", id)} emptyText="No output devices listed." />
        ) : (
          <p className="alert alert-info small">
            <Info aria-hidden="true" />
            <span>This browser can't choose where call audio plays: it uses your system's default output. Change it in your system sound settings.</span>
          </p>
        )}
        <div className="cluster">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setToneError(null);
              void playTestTone(prefs.speakerDeviceId).catch((e: unknown) => setToneError(errorMessage(e)));
            }}
          >
            <Volume2 aria-hidden="true" /> Play test sound
          </button>
          {speakerApplied ? <span className="small muted">Output switched.</span> : null}
        </div>
        {toneError ? <p className="form-error small">{toneError}</p> : null}
      </section>

      {showVideo ? (
        <section className="stack-sm" aria-label="Camera">
          <DeviceSelect label="Camera" icon={<Video aria-hidden="true" />} devices={devs.cams} value={camId} onChange={(id) => void pick("videoinput", id)} emptyText="No camera available (or access not granted yet)." />
          <div className="field">
            <label htmlFor="video-quality">Video quality</label>
            <select id="video-quality" value={prefs.videoQuality} onChange={(e) => setCallPrefs({ videoQuality: e.target.value as VideoQuality })}>
              <option value="auto">Auto (recommended) — up to 1080p when your camera and device allow</option>
              <option value="standard">{VIDEO_PROFILES.standard.label} — saves data</option>
              <option value="hd">{VIDEO_PROFILES.hd.label}</option>
              <option value="highest">Highest available — up to {VIDEO_PROFILES.highest.label}</option>
            </select>
            <p className="xsmall muted">The quality others receive also adapts to their screen and to the network, automatically. Changes apply the next time your camera starts.</p>
          </div>
        </section>
      ) : null}

      <fieldset className="stack-sm audio-mode">
        <legend className="label">Audio quality</legend>
        <label className={`choice${prefs.audioMode === "voice" ? " selected" : ""}`}>
          <input type="radio" name="audio-mode" checked={prefs.audioMode === "voice"} onChange={() => void applyAudio({ audioMode: "voice" })} />
          <span>
            <strong>HD Voice</strong>
            <span className="small muted">Clear, natural speech (Opus 48 kHz, up to 40 kbit/s). Echo cancellation, noise suppression and automatic gain on. Best for most calls.</span>
          </span>
        </label>
        <label className={`choice${prefs.audioMode === "hifi" ? " selected" : ""}`}>
          <input type="radio" name="audio-mode" checked={prefs.audioMode === "hifi"} onChange={() => void applyAudio({ audioMode: "hifi" })} />
          <span>
            <strong>High-Fidelity</strong>
            <span className="small muted">For music or a good microphone: up to 96 kbit/s (128 kbit/s stereo), no silence suppression, processing off unless you turn it on. Use headphones.</span>
          </span>
        </label>
        {prefs.audioMode === "hifi" ? (
          <Toggle
            label="Stereo"
            description={stereoCapable ? "Send two channels when your microphone provides them." : "Your current microphone only provides one channel."}
            checked={prefs.hifiStereo && stereoCapable}
            disabled={!stereoCapable}
            onChange={(on) => void applyAudio({ hifiStereo: on })}
          />
        ) : null}
      </fieldset>

      <details className="advanced-audio">
        <summary>Advanced: voice processing</summary>
        <div className="stack-sm">
          <Toggle label="Echo cancellation" description="Stops others hearing themselves through your speakers." checked={proc.echoCancellation} onChange={(on) => void applyAudio({ echoCancellation: on })} />
          <Toggle label="Noise suppression" description="Reduces steady background noise (fans, traffic)." checked={proc.noiseSuppression} onChange={(on) => void applyAudio({ noiseSuppression: on })} />
          <Toggle label="Automatic gain" description="Keeps your volume level when you move closer or further away." checked={proc.autoGainControl} onChange={(on) => void applyAudio({ autoGainControl: on })} />
          <button type="button" className="link-button small" onClick={() => void applyAudio({ echoCancellation: null, noiseSuppression: null, autoGainControl: null })}>
            Reset to the mode's defaults
          </button>
          {micTrack ? <AppliedSettings track={micTrack} /> : null}
        </div>
      </details>

      {echoRisk ? (
        <p className="alert alert-warning small" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>Echo cancellation is off and you seem to be using speakers: others may hear themselves. Use headphones, or turn echo cancellation on.</span>
        </p>
      ) : null}
      <p className="small muted cluster no-wrap-icon">
        <Headphones aria-hidden="true" />
        <span>What others hear also depends on their device, speakers or headphones, operating system and network — these settings control what you send.</span>
      </p>
    </div>
  );
}
