/**
 * Media settings for calls: what we ask the browser to capture and how LiveKit encodes it.
 *
 * Audio
 *   HD Voice (default): Opus 48 kHz mono, speech-optimised, capped at 40 kbit/s (the codec's
 *   rate adapts downwards with the congestion controller), DTX on, in-band FEC (Opus
 *   `useinbandfec=1`, Chrome's default), echo cancellation, noise suppression, auto gain and
 *   `voiceIsolation` (where the browser supports it) on.
 *   High-Fidelity: 96 kbit/s mono or 128 kbit/s stereo when the microphone really delivers two
 *   channels, DTX off, every processing step individually switchable (off by default).
 *   RED (redundant audio): requested, but livekit-client 2.x disables RED whenever end-to-end
 *   encryption is on (the SFU can't re-packetise encrypted RED payloads), and every call here is
 *   end-to-end encrypted — so in practice loss is covered by in-band FEC and NACK. The
 *   diagnostics panel reports the codec that was actually negotiated.
 *
 * Video
 *   VP8 (see chooseVideoCodec), simulcast with up to three layers (low/medium/high), adaptive
 *   stream and dynacast on the room. Audio gets network priority "high", video "low", so the
 *   congestion controller degrades video before audio.
 */
import {
  type AudioCaptureOptions,
  type TrackPublishDefaults,
  type VideoCaptureOptions,
  type VideoCodec,
  VideoPreset,
  VideoPresets,
  type VideoEncoding,
} from "livekit-client";
import { effectiveProcessing, type CallPrefs, type VideoQuality } from "./prefs";

export const HD_VOICE_MAX_BITRATE = 40_000;
export const HIFI_MONO_MAX_BITRATE = 96_000;
export const HIFI_STEREO_MAX_BITRATE = 128_000;

/** Whether the browser knows a capture constraint (e.g. `voiceIsolation`, Chrome 124+/Safari). */
export function supportsConstraint(name: string): boolean {
  try {
    return !!(navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined)?.[name];
  } catch {
    return false;
  }
}

export function audioCaptureOptions(p: CallPrefs, deviceId?: string | null): AudioCaptureOptions {
  const proc = effectiveProcessing(p);
  const opts: AudioCaptureOptions = {
    echoCancellation: proc.echoCancellation,
    noiseSuppression: proc.noiseSuppression,
    autoGainControl: proc.autoGainControl,
    sampleRate: 48_000,
    channelCount: p.audioMode === "hifi" && p.hifiStereo ? 2 : 1,
  };
  // Voice isolation goes with noise suppression in HD Voice (it is speech-specific processing).
  if (supportsConstraint("voiceIsolation")) opts.voiceIsolation = p.audioMode === "voice" && proc.noiseSuppression;
  const dev = deviceId ?? p.micDeviceId;
  if (dev) opts.deviceId = { ideal: dev };
  return opts;
}

/** Publish options for the microphone track (stereo only when the captured track has 2 channels). */
export function audioPublishOptions(p: CallPrefs, capturedChannels: number | undefined) {
  if (p.audioMode === "hifi") {
    const stereo = p.hifiStereo && capturedChannels === 2;
    return {
      audioPreset: { maxBitrate: stereo ? HIFI_STEREO_MAX_BITRATE : HIFI_MONO_MAX_BITRATE, priority: "high" as RTCPriorityType },
      dtx: false,
      red: true,
      forceStereo: stereo,
    };
  }
  return {
    audioPreset: { maxBitrate: HD_VOICE_MAX_BITRATE, priority: "high" as RTCPriorityType },
    dtx: true,
    red: true,
    forceStereo: false,
  };
}

// ---- Video -------------------------------------------------------------------------------

export interface VideoProfile {
  quality: Exclude<VideoQuality, "auto">;
  label: string;
  capture: { width: number; height: number; frameRate: number };
  encoding: VideoEncoding;
  /** lower simulcast layers (LiveKit adds the top layer from `encoding`) */
  layers: VideoPreset[];
}

const enc = (maxBitrate: number, maxFramerate: number): VideoEncoding => ({ maxBitrate, maxFramerate, priority: "low" });

export const VIDEO_PROFILES: Record<Exclude<VideoQuality, "auto">, VideoProfile> = {
  standard: { quality: "standard", label: "Standard (360p)", capture: { width: 640, height: 360, frameRate: 30 }, encoding: enc(600_000, 30), layers: [VideoPresets.h180] },
  hd: { quality: "hd", label: "HD (720p)", capture: { width: 1280, height: 720, frameRate: 30 }, encoding: enc(1_700_000, 30), layers: [VideoPresets.h180, VideoPresets.h360] },
  highest: {
    quality: "highest",
    label: "Full HD (1080p)",
    capture: { width: 1920, height: 1080, frameRate: 30 },
    encoding: enc(3_000_000, 30),
    layers: [new VideoPreset(640, 360, 450_000, 30), new VideoPreset(1280, 720, 1_500_000, 30)],
  },
};

/**
 * Resolves "auto": ask for 1080p30 on devices with the CPU for it (≥ 8 logical cores), 720p30
 * otherwise. The camera bounds it further (the session drops to the 720p profile when the camera
 * delivers less than 1080p), and the network side is adaptive either way: simulcast + dynacast +
 * the SFU's congestion control decide what each receiver gets.
 */
export function resolveVideoProfile(q: VideoQuality): VideoProfile {
  if (q !== "auto") return VIDEO_PROFILES[q];
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  return cores >= 8 ? VIDEO_PROFILES.highest : VIDEO_PROFILES.hd;
}

export function videoCaptureOptions(profile: VideoProfile, deviceId?: string | null): VideoCaptureOptions {
  return {
    resolution: { width: profile.capture.width, height: profile.capture.height, frameRate: profile.capture.frameRate },
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

export const SCREEN_SHARE_ENCODING: VideoEncoding = { maxBitrate: 3_000_000, maxFramerate: 15, priority: "medium" };

// ---- Codec choice ------------------------------------------------------------------------

export interface CodecReport {
  chosen: VideoCodec;
  reason: string;
  /** codecs this browser can send (RTCRtpSender.getCapabilities) */
  sendable: string[];
  /** media-capabilities answers for 720p30 WebRTC encoding, where the browser has the API */
  measured: { codec: string; supported: boolean; smooth: boolean; powerEfficient: boolean }[];
}

/**
 * Picks the camera codec from real capability checks:
 *  - AV1 is never used: livekit-client's frame encryptor rejects AV1 under end-to-end encryption.
 *  - VP9 is not used: LiveKit sends it as SVC, which several browsers (and older Element clients)
 *    don't decode with frame encryption; it is also the most CPU-hungry software encoder.
 *  - VP8 is the default: every WebRTC browser encodes and decodes it, it simulcasts, and the
 *    frame encryptor handles it natively.
 *  - H.264 is chosen only when VP8 can't be sent at all, or when VP8 is measured as not smooth
 *    while H.264 is smooth and power-efficient (i.e. a hardware encoder). H.264 is also
 *    handled by the frame encryptor (NAL-unit aware); every current browser decodes it.
 */
export async function chooseVideoCodec(): Promise<CodecReport> {
  const sendable = (typeof RTCRtpSender !== "undefined" ? (RTCRtpSender.getCapabilities?.("video")?.codecs ?? []) : [])
    .map((c) => c.mimeType.toLowerCase())
    .filter((m) => /video\/(vp8|vp9|h264|av1|h265)$/.test(m));
  const unique = [...new Set(sendable)];
  const measured: CodecReport["measured"] = [];
  const mc = typeof navigator !== "undefined" ? navigator.mediaCapabilities : undefined;
  if (mc?.encodingInfo) {
    for (const [codec, contentType] of [
      ["vp8", "video/VP8"],
      ["h264", "video/H264"],
      ["vp9", "video/VP9"],
      ["av1", "video/AV1"],
    ] as const) {
      try {
        const r = await mc.encodingInfo({
          type: "webrtc",
          video: { contentType, width: 1280, height: 720, bitrate: 1_700_000, framerate: 30 },
        } as MediaEncodingConfiguration);
        measured.push({ codec, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient });
      } catch {
        /* not answerable for this codec */
      }
    }
  }
  const has = (c: string) => unique.includes(`video/${c}`);
  const m = (c: string) => measured.find((x) => x.codec === c);
  if (!has("vp8") && has("h264")) return { chosen: "h264", reason: "this browser can't send VP8.", sendable: unique, measured };
  const vp8 = m("vp8");
  const h264 = m("h264");
  if (vp8 && h264 && has("h264") && !vp8.smooth && h264.smooth && h264.powerEfficient) {
    return { chosen: "h264", reason: "VP8 encoding was measured as not smooth here and H.264 has a hardware encoder.", sendable: unique, measured };
  }
  return {
    chosen: "vp8",
    reason: "every WebRTC browser must support it, it has simulcast and it works with frame encryption.",
    sendable: unique,
    measured,
  };
}

export function publishDefaults(p: CallPrefs, profile: VideoProfile, codec: VideoCodec): TrackPublishDefaults {
  const audio = audioPublishOptions(p, p.audioMode === "hifi" && p.hifiStereo ? 2 : 1);
  return {
    ...audio,
    simulcast: true,
    videoSimulcastLayers: profile.layers,
    videoEncoding: profile.encoding,
    videoCodec: codec,
    backupCodec: false,
    screenShareEncoding: SCREEN_SHARE_ENCODING,
    screenShareSimulcastLayers: [new VideoPreset(1280, 720, 800_000, 5)],
    stopMicTrackOnMute: false,
  };
}

// ---- Devices and errors ------------------------------------------------------------------

export function supportsOutputSelection(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export async function listDevices(): Promise<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  // Without a permission grant, labels are empty and IDs are blank: show nothing rather than "Unknown".
  const real = all.filter((d) => d.deviceId !== "");
  return {
    mics: real.filter((d) => d.kind === "audioinput"),
    cams: real.filter((d) => d.kind === "videoinput"),
    speakers: real.filter((d) => d.kind === "audiooutput"),
  };
}

export type MediaKind = "microphone" | "camera" | "screen";

/** Turns getUserMedia/getDisplayMedia errors into something a person can act on. */
export function describeMediaError(e: unknown, kind: MediaKind): string {
  const name = (e as { name?: string })?.name ?? "";
  const what = kind === "microphone" ? "microphone" : kind === "camera" ? "camera" : "screen";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      if (kind === "screen") return "Screen sharing was cancelled or isn't allowed.";
      return `Access to your ${what} is blocked. Allow it for this site in your browser's settings (usually the icon next to the address), then try again.`;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return `No ${what} was found. Connect one, or check that it's enabled in your system settings.`;
    case "NotReadableError":
    case "TrackStartError":
      return `Your ${what} couldn't be started. Another app may be using it — close it and try again.`;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return `The selected ${what} can't provide the requested settings. Choose another device, or pick the system default.`;
    case "AbortError":
      return `Starting your ${what} was interrupted. Try again.`;
    case "TypeError":
      return `This browser can't use a ${what} here (calls need a secure https connection).`;
    default:
      return `Couldn't use your ${what}${e instanceof Error && e.message ? `: ${e.message}` : "."}`;
  }
}

/** Looks like headphones/a headset (so echo is unlikely even without echo cancellation). */
export function looksLikeHeadphones(label: string | undefined): boolean {
  return !!label && /head(phone|set)|earbud|earphone|airpods|buds|bluetooth|hands-?free/i.test(label);
}
