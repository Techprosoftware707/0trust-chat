/**
 * Call diagnostics computed only from RTCPeerConnection getStats() reports (the RTCRtpSender /
 * RTCRtpReceiver of each track). Nothing here is estimated or invented: a value the browser
 * didn't report stays `null` and is shown as "—".
 *
 * Network quality label (shown with its thresholds in the diagnostics panel):
 *   good — round-trip time < 150 ms, packet loss < 2 %, jitter < 30 ms
 *   fair — round-trip time < 300 ms, packet loss < 5 %, jitter < 60 ms
 *   poor — anything worse
 *   unknown — no measurement yet
 * Each metric is judged on its own and the worst one wins, so the label always names a cause.
 */

export type StatRecord = Record<string, unknown> & { id: string; type: string; timestamp?: number };

export const QUALITY_THRESHOLDS = {
  good: { rttMs: 150, lossPct: 2, jitterMs: 30 },
  fair: { rttMs: 300, lossPct: 5, jitterMs: 60 },
} as const;

export type QualityLabel = "good" | "fair" | "poor" | "unknown";

export interface QualityVerdict {
  label: QualityLabel;
  /** human-readable reasons for anything below "good" */
  reasons: string[];
}

export function classifyNetwork(m: { rttMs: number | null; lossPct: number | null; jitterMs: number | null }): QualityVerdict {
  const parts: { label: QualityLabel; reason: string | null }[] = [];
  const judge = (v: number | null, key: "rttMs" | "lossPct" | "jitterMs", name: string, unit: string) => {
    if (v === null || !Number.isFinite(v)) return;
    if (v < QUALITY_THRESHOLDS.good[key]) parts.push({ label: "good", reason: null });
    else if (v < QUALITY_THRESHOLDS.fair[key]) parts.push({ label: "fair", reason: `${name} ${fmt(v)}${unit} (good is under ${QUALITY_THRESHOLDS.good[key]}${unit})` });
    else parts.push({ label: "poor", reason: `${name} ${fmt(v)}${unit} (fair is under ${QUALITY_THRESHOLDS.fair[key]}${unit})` });
  };
  judge(m.rttMs, "rttMs", "Round-trip time", " ms");
  judge(m.lossPct, "lossPct", "Packet loss", " %");
  judge(m.jitterMs, "jitterMs", "Jitter", " ms");
  if (!parts.length) return { label: "unknown", reasons: [] };
  const order: QualityLabel[] = ["good", "fair", "poor"];
  const worst = parts.reduce((w, p) => (order.indexOf(p.label) > order.indexOf(w) ? p.label : w), "good" as QualityLabel);
  return { label: worst, reasons: parts.filter((p) => p.reason).map((p) => p.reason!) };
}

function fmt(v: number): string {
  return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function reportToArray(report: RTCStatsReport | Iterable<StatRecord> | undefined | null): StatRecord[] {
  if (!report) return [];
  const out: StatRecord[] = [];
  const fe = (report as { forEach?: (cb: (s: StatRecord) => void) => void }).forEach;
  if (typeof fe === "function") fe.call(report, (s: StatRecord) => out.push(s));
  else for (const s of report as Iterable<StatRecord>) out.push(s);
  return out;
}

export interface Candidate {
  type: string | null; // host | srflx | prflx | relay
  protocol: string | null; // udp | tcp
  relayProtocol: string | null; // udp | tcp | tls (for relay candidates)
}

export interface TransportInfo {
  iceState: string | null;
  dtlsState: string | null;
  local: Candidate | null;
  remote: Candidate | null;
  rttMs: number | null;
  /** media goes through a TURN relay (our side) */
  relayed: boolean;
}

export function transportInfo(stats: StatRecord[]): TransportInfo | null {
  const byId = new Map(stats.map((s) => [s.id, s]));
  const transport = stats.find((s) => s.type === "transport");
  let pair: StatRecord | undefined = transport ? byId.get(str(transport.selectedCandidatePairId) ?? "") : undefined;
  pair ??= stats.find((s) => s.type === "candidate-pair" && (s.selected === true || (s.nominated === true && s.state === "succeeded")));
  if (!transport && !pair) return null;
  const cand = (id: unknown): Candidate | null => {
    const c = byId.get(str(id) ?? "");
    return c ? { type: str(c.candidateType), protocol: str(c.protocol), relayProtocol: str(c.relayProtocol) } : null;
  };
  const local = pair ? cand(pair.localCandidateId) : null;
  const rtt = pair ? num(pair.currentRoundTripTime) : null;
  return {
    iceState: str(transport?.iceState) ?? (pair ? str(pair.state) : null),
    dtlsState: str(transport?.dtlsState),
    local,
    remote: pair ? cand(pair.remoteCandidateId) : null,
    rttMs: rtt === null ? null : Math.round(rtt * 1000),
    relayed: local?.type === "relay",
  };
}

export interface StreamSummary {
  direction: "send" | "receive";
  kind: "audio" | "video";
  codec: string | null; // e.g. "audio/opus"
  clockRate: number | null;
  channels: number | null;
  fmtp: string | null;
  kbps: number | null;
  packetsPerSecond: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  rttMs: number | null; // from remote-inbound-rtp (send side)
  width: number | null;
  height: number | null;
  fps: number | null;
  /** send side: the encoder's limitation ("bandwidth", "cpu", "none") */
  qualityLimitation: string | null;
  /** send side: simulcast layers currently being sent, e.g. ["q 320x180", "h 640x360"] */
  layers: string[];
  /** receive side: video frames decoded in the interval */
  framesDecodedDelta: number | null;
  /** receive side, audio: share of samples concealed (lost/late) in the interval */
  concealedPct: number | null;
  /** receive side, audio: FEC packets recovered in the interval */
  fecPacketsDelta: number | null;
  /** cumulative bytes over all RTP streams of the track */
  totalBytes: number | null;
}

type Keyed = Map<string, StatRecord>;

function delta(cur: StatRecord, prev: StatRecord | undefined, key: string): number | null {
  const a = num(cur[key]);
  const b = prev ? num(prev[key]) : null;
  return a === null || b === null ? null : a - b;
}

function seconds(cur: StatRecord, prev: StatRecord | undefined): number | null {
  const a = num(cur.timestamp);
  const b = prev ? num(prev.timestamp) : null;
  if (a === null || b === null || a <= b) return null;
  return (a - b) / 1000;
}

/**
 * Summarises one track's sender or receiver report against the previous report of the same
 * track (for rates). `prev` may be null on the first sample: rates are then null.
 */
export function summariseStream(statsArr: StatRecord[], prevArr: StatRecord[] | null, direction: "send" | "receive"): StreamSummary | null {
  const byId: Keyed = new Map(statsArr.map((s) => [s.id, s]));
  const prevById: Keyed = new Map((prevArr ?? []).map((s) => [s.id, s]));
  const rtpType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
  const rtps = statsArr.filter((s) => s.type === rtpType);
  if (!rtps.length) return null;
  const kind = (str(rtps[0].kind) ?? "audio") as "audio" | "video";
  let bytes = 0;
  let bytesKnown = false;
  let kbps: number | null = null;
  let pps: number | null = null;
  const layers: string[] = [];
  let top: StatRecord = rtps[0];
  for (const r of rtps) {
    const b = num(direction === "send" ? r.bytesSent : r.bytesReceived);
    if (b !== null) {
      bytes += b;
      bytesKnown = true;
    }
    const p = prevById.get(r.id);
    const dt = seconds(r, p);
    const db = delta(r, p, direction === "send" ? "bytesSent" : "bytesReceived");
    const dp = delta(r, p, direction === "send" ? "packetsSent" : "packetsReceived");
    if (dt && db !== null) kbps = (kbps ?? 0) + (db * 8) / 1000 / dt;
    if (dt && dp !== null) pps = (pps ?? 0) + dp / dt;
    const w = num(r.frameWidth);
    const active = r.active !== false && (!dt || (db ?? 0) > 0);
    if (direction === "send" && kind === "video" && w && active) layers.push(`${str(r.rid) ?? "–"} ${w}×${num(r.frameHeight)}`);
    if ((num(r.frameWidth) ?? 0) > (num(top.frameWidth) ?? 0) && active) top = r;
  }
  const codec = byId.get(str(top.codecId) ?? "");
  const prevTop = prevById.get(top.id);
  let lossPct: number | null = null;
  let jitterMs: number | null = null;
  let rttMs: number | null = null;
  let framesDecodedDelta: number | null = null;
  let concealedPct: number | null = null;
  let fecPacketsDelta: number | null = null;
  if (direction === "receive") {
    const dLost = delta(top, prevTop, "packetsLost");
    const dRecv = delta(top, prevTop, "packetsReceived");
    if (dLost !== null && dRecv !== null && dLost + dRecv > 0) lossPct = Math.max(0, (dLost / (dLost + dRecv)) * 100);
    const j = num(top.jitter);
    jitterMs = j === null ? null : Math.round(j * 1000 * 10) / 10;
    framesDecodedDelta = delta(top, prevTop, "framesDecoded");
    const dConc = delta(top, prevTop, "concealedSamples");
    const dSilent = delta(top, prevTop, "silentConcealedSamples") ?? 0;
    const dSamples = delta(top, prevTop, "totalSamplesReceived");
    if (dConc !== null && dSamples && dSamples > 0) concealedPct = Math.max(0, ((dConc - dSilent) / dSamples) * 100);
    fecPacketsDelta = delta(top, prevTop, "fecPacketsReceived");
  } else {
    // Loss/jitter/RTT as reported back by the SFU (RTCP receiver reports).
    const remote = statsArr.find((s) => s.type === "remote-inbound-rtp" && (str(s.localId) === top.id || num(s.ssrc) === num(top.ssrc)));
    if (remote) {
      const fl = num(remote.fractionLost);
      lossPct = fl === null ? null : Math.round(fl * 1000) / 10;
      const j = num(remote.jitter);
      jitterMs = j === null ? null : Math.round(j * 1000 * 10) / 10;
      const r = num(remote.roundTripTime);
      rttMs = r === null ? null : Math.round(r * 1000);
    }
  }
  return {
    direction,
    kind,
    codec: str(codec?.mimeType),
    clockRate: num(codec?.clockRate),
    channels: num(codec?.channels),
    fmtp: str(codec?.sdpFmtpLine),
    kbps: kbps === null ? null : Math.round(kbps * 10) / 10,
    packetsPerSecond: pps === null ? null : Math.round(pps * 10) / 10,
    lossPct: lossPct === null ? null : Math.round(lossPct * 10) / 10,
    jitterMs,
    rttMs,
    width: num(top.frameWidth),
    height: num(top.frameHeight),
    fps: num(top.framesPerSecond),
    qualityLimitation: direction === "send" && kind === "video" ? str(top.qualityLimitationReason) : null,
    layers,
    framesDecodedDelta,
    concealedPct: concealedPct === null ? null : Math.round(concealedPct * 10) / 10,
    fecPacketsDelta,
    totalBytes: bytesKnown ? bytes : null,
  };
}

/** Aggregates the per-stream numbers into one network verdict (worst RTT/loss/jitter seen). */
export function overallNetwork(streams: StreamSummary[], transport: TransportInfo | null): { rttMs: number | null; lossPct: number | null; jitterMs: number | null } {
  const max = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  return {
    rttMs: max([transport?.rttMs ?? null, ...streams.map((s) => s.rttMs)]),
    lossPct: max(streams.map((s) => s.lossPct)),
    jitterMs: max(streams.map((s) => s.jitterMs)),
  };
}

export function describeCandidate(c: Candidate | null): string {
  if (!c?.type) return "—";
  if (c.type === "relay") return `TURN relay (${(c.relayProtocol ?? c.protocol ?? "?").toUpperCase()})`;
  const proto = (c.protocol ?? "").toUpperCase();
  if (c.type === "host") return `Direct (${proto})`;
  if (c.type === "srflx" || c.type === "prflx") return `Direct via NAT (${proto})`;
  return `${c.type} (${proto})`;
}
