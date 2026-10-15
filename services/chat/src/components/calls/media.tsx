/** Small media building blocks for the call UI: track-bound <video>/<audio> and a level meter. */
import { useEffect, useRef, useState } from "react";
import type { Track } from "livekit-client";
import { meterTrack } from "../../calls/audio";
import { listDevices } from "../../calls/media";

/** Renders a LiveKit video track (attach/detach so adaptive streaming knows the element size). */
export function TrackVideo({ track, mirror, fit = "cover", className, label }: { track: Track; mirror?: boolean; fit?: "cover" | "contain"; className?: string; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      className={`call-video${mirror ? " mirror" : ""} fit-${fit}${className ? ` ${className}` : ""}`}
      autoPlay
      playsInline
      muted
      aria-label={label}
      data-call-video={track.source}
    />
  );
}

/** Plays a remote audio track. Data attributes identify the source for diagnostics/tests. */
export function TrackAudio({ track, userId, name, source }: { track: Track; userId: string | null; name: string; source: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <audio ref={ref} autoPlay data-call-audio="" data-participant={userId ?? ""} data-name={name} data-source={source} />;
}

/** Level of a live audio track, 0..1 (0 when muted/ended). */
export function useTrackLevel(track: MediaStreamTrack | null | undefined): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track) {
      setLevel(0);
      return;
    }
    return meterTrack(track, setLevel);
  }, [track]);
  return track ? level : 0;
}

export function LevelMeter({ track, label = "Microphone level" }: { track: MediaStreamTrack | null | undefined; label?: string }) {
  const level = useTrackLevel(track);
  const pct = Math.round(level * 100);
  return (
    <div className="level-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-level={pct}>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className={`level-bar${level * 12 > i ? " lit" : ""}${i >= 10 ? " hot" : ""}`} />
      ))}
    </div>
  );
}

/** Cameras currently available (empty until the user granted camera access). */
export function useCameras(): MediaDeviceInfo[] {
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => void listDevices().then((d) => alive && setCams(d.cams)).catch(() => undefined);
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);
  return cams;
}
