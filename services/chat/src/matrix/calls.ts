/**
 * Legacy 1:1 Matrix VoIP (matrix-js-sdk MatrixCall), only used when the
 * deployment sets `voip_enabled`. Media protection is reported strictly from
 * RTCPeerConnection.getStats(): we only say media is encrypted once the DTLS
 * transport is connected and an SRTP cipher has been negotiated.
 */

export interface MediaProtection {
  /** DTLS transport state from the stats ("new", "connecting", "connected", "closed", "failed"). */
  dtlsState: string | null;
  srtpCipher: string | null;
  dtlsCipher: string | null;
  tlsVersion: string | null;
  /** Candidate pair in use is relayed through TURN. */
  relayed: boolean | null;
  protectedMedia: boolean;
}

interface StatLike {
  type?: string;
  id?: string;
  dtlsState?: string;
  srtpCipher?: string;
  dtlsCipher?: string;
  tlsVersion?: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  candidateType?: string;
  state?: string;
  selected?: boolean;
  nominated?: boolean;
}

/** Summarises an RTCStatsReport (or any iterable of stats objects). */
export function summariseTransportStats(stats: Iterable<StatLike>): MediaProtection {
  const all = [...stats];
  const byId = new Map(all.filter((s) => s.id).map((s) => [s.id!, s]));
  const transport = all.find((s) => s.type === "transport" && s.dtlsState === "connected") ?? all.find((s) => s.type === "transport");
  let relayed: boolean | null = null;
  const pairId = transport?.selectedCandidatePairId;
  const pair = pairId ? byId.get(pairId) : all.find((s) => s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded")));
  if (pair?.localCandidateId) {
    const local = byId.get(pair.localCandidateId);
    if (local?.candidateType) relayed = local.candidateType === "relay";
  }
  const dtlsState = transport?.dtlsState ?? null;
  const srtpCipher = transport?.srtpCipher ?? null;
  return {
    dtlsState,
    srtpCipher,
    dtlsCipher: transport?.dtlsCipher ?? null,
    tlsVersion: transport?.tlsVersion ?? null,
    relayed,
    protectedMedia: dtlsState === "connected" && !!srtpCipher,
  };
}

export async function readMediaProtection(pc: RTCPeerConnection | undefined | null): Promise<MediaProtection | null> {
  if (!pc) return null;
  const report = await pc.getStats();
  return summariseTransportStats(report.values() as Iterable<StatLike>);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
