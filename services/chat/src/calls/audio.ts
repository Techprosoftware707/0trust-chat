/**
 * Local audio helpers built on Web Audio (no audio files, nothing leaves the device):
 * microphone level metering, the incoming-call ringtone, an output test tone and a
 * record-and-play-back microphone test.
 */

let ctx: AudioContext | null = null;

/** One shared AudioContext; created lazily (browsers only start it after a user gesture). */
export function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx || ctx.state === "closed") ctx = new AudioContext({ latencyHint: "interactive" });
  return ctx;
}

/**
 * Measures the level of a live MediaStreamTrack (RMS, 0..1, smoothed for display). Returns a
 * stop function. `onLevel` is called ~20 times per second; it gets 0 when the track is muted or
 * ended, so a meter never shows activity that isn't there.
 */
export function meterTrack(track: MediaStreamTrack, onLevel: (level: number) => void): () => void {
  const ac = audioContext();
  if (!ac) return () => undefined;
  void ac.resume().catch(() => undefined);
  const src = ac.createMediaStreamSource(new MediaStream([track]));
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let smooth = 0;
  const timer = setInterval(() => {
    if (track.readyState !== "live" || !track.enabled) {
      smooth = 0;
      onLevel(0);
      return;
    }
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    // perceptual-ish scaling: -60 dBFS .. 0 dBFS -> 0..1
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const level = Math.min(1, Math.max(0, (db + 60) / 60));
    smooth = Math.max(level, smooth * 0.85);
    onLevel(smooth);
  }, 50);
  return () => {
    clearInterval(timer);
    src.disconnect();
    an.disconnect();
  };
}

/** Routes a Web Audio node to a chosen output device (where the browser supports it). */
async function toOutput(node: AudioNode, ac: AudioContext, sinkId: string | null): Promise<() => void> {
  const dest = ac.createMediaStreamDestination();
  node.connect(dest);
  const el = new Audio();
  el.srcObject = dest.stream;
  if (sinkId && "setSinkId" in el) await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => undefined);
  await el.play().catch(() => undefined);
  return () => {
    el.pause();
    el.srcObject = null;
    node.disconnect();
  };
}

/** A calm two-tone ring (0.8 s on, 2.2 s off), repeated until stopped. */
export function startRingtone(sinkId: string | null = null): () => void {
  const ac = audioContext();
  if (!ac) return () => undefined;
  void ac.resume().catch(() => undefined);
  const gain = ac.createGain();
  gain.gain.value = 0;
  const o1 = ac.createOscillator();
  const o2 = ac.createOscillator();
  o1.frequency.value = 440;
  o2.frequency.value = 554.37;
  o1.connect(gain);
  o2.connect(gain);
  o1.start();
  o2.start();
  let stopped = false;
  let release: (() => void) | null = null;
  void toOutput(gain, ac, sinkId).then((r) => (stopped ? r() : (release = r)));
  const ring = () => {
    if (stopped) return;
    const t = ac.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.05);
    gain.gain.setValueAtTime(0.12, t + 0.75);
    gain.gain.linearRampToValueAtTime(0, t + 0.8);
  };
  ring();
  const timer = setInterval(ring, 3000);
  return () => {
    stopped = true;
    clearInterval(timer);
    try {
      o1.stop();
      o2.stop();
    } catch {
      /* already stopped */
    }
    release?.();
  };
}

/** Plays a short test tone (a soft 3-note chime) on the chosen output. */
export async function playTestTone(sinkId: string | null): Promise<void> {
  const ac = audioContext();
  if (!ac) throw new Error("This browser can't play audio from web pages.");
  await ac.resume();
  const gain = ac.createGain();
  gain.gain.value = 0;
  const release = await toOutput(gain, ac, sinkId);
  const notes = [523.25, 659.25, 783.99];
  const t0 = ac.currentTime + 0.05;
  notes.forEach((f, i) => {
    const o = ac.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start(t0 + i * 0.35);
    o.stop(t0 + i * 0.35 + 0.3);
  });
  gain.gain.setValueAtTime(0, t0);
  for (let i = 0; i < notes.length; i++) {
    gain.gain.linearRampToValueAtTime(0.2, t0 + i * 0.35 + 0.03);
    gain.gain.linearRampToValueAtTime(0, t0 + i * 0.35 + 0.3);
  }
  await new Promise((r) => setTimeout(r, 1300));
  release();
}

/**
 * Records `seconds` of the microphone track locally and returns a blob URL to play it back
 * (revoke it when done). The recording never leaves this device.
 */
export async function recordSample(track: MediaStreamTrack, seconds = 3): Promise<string> {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser can't record audio for a test.");
  const rec = new MediaRecorder(new MediaStream([track]));
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  rec.stop();
  await done;
  return URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
}
