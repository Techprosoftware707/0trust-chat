/**
 * Call diagnostics: numbers straight from RTCPeerConnection getStats() (via LiveKit's
 * per-track sender/receiver reports), sampled every 2 s on this device. Nothing is stored or
 * sent anywhere; "—" means the browser didn't report the value.
 */
import { Activity, Info, Radio } from "lucide-react";
import type { CallParticipant, CallSnapshot } from "../../calls/CallSession";
import { describeCandidate, QUALITY_THRESHOLDS, type StreamSummary } from "../../calls/stats";
import { formatTime } from "../../lib/format";

const dash = (v: number | string | null | undefined, unit = "") => (v === null || v === undefined || v === "" ? "—" : `${v}${unit}`);

function fmtpHighlights(fmtp: string | null): string {
  if (!fmtp) return "—";
  const kv = Object.fromEntries(fmtp.split(";").map((p) => p.trim().split("=")));
  const parts: string[] = [];
  if (kv.useinbandfec === "1") parts.push("in-band FEC");
  if (kv.usedtx === "1") parts.push("DTX");
  if (kv.stereo === "1") parts.push("stereo");
  if (kv.maxaveragebitrate) parts.push(`max ${Math.round(Number(kv.maxaveragebitrate) / 1000)} kbit/s`);
  return parts.length ? parts.join(", ") : fmtp;
}

function Stream({ title, s }: { title: string; s: StreamSummary | null }) {
  if (!s) return null;
  const video = s.kind === "video";
  return (
    <div className="diag-stream" data-kind={s.kind} data-dir={s.direction}>
      <h5>{title}</h5>
      <dl className="kv">
        <dt>Codec</dt>
        <dd data-k="codec">
          {dash(s.codec)}
          {s.clockRate ? ` · ${s.clockRate / 1000} kHz` : ""}
          {!video && s.direction === "send" && s.codec === "audio/opus" ? ` · ${/(^|;)\s*stereo=1/.test(s.fmtp ?? "") ? "stereo" : "mono"}` : ""}
        </dd>
        {!video && s.direction === "send" ? (
          <>
            <dt>Codec options</dt>
            <dd data-k="fmtp">{fmtpHighlights(s.fmtp)}</dd>
          </>
        ) : null}
        <dt>Bitrate</dt>
        <dd data-k="kbps">{dash(s.kbps, " kbit/s")}</dd>
        <dt>Packets</dt>
        <dd>{dash(s.packetsPerSecond, "/s")}</dd>
        {video ? (
          <>
            <dt>Resolution</dt>
            <dd data-k="resolution">{s.width && s.height ? `${s.width}×${s.height}` : "—"}</dd>
            <dt>Frame rate</dt>
            <dd data-k="fps">{dash(s.fps, " fps")}</dd>
          </>
        ) : null}
        {s.direction === "send" && video ? (
          <>
            <dt>Layers sent</dt>
            <dd>{s.layers.length ? s.layers.join(", ") : "—"}</dd>
            <dt>Limited by</dt>
            <dd data-k="limitation">{s.qualityLimitation === "none" ? "nothing" : dash(s.qualityLimitation)}</dd>
          </>
        ) : null}
        <dt>Packet loss</dt>
        <dd data-k="loss">{dash(s.lossPct, " %")}</dd>
        <dt>Jitter</dt>
        <dd data-k="jitter">{dash(s.jitterMs, " ms")}</dd>
        {s.direction === "send" ? (
          <>
            <dt>Round trip (to server)</dt>
            <dd>{dash(s.rttMs, " ms")}</dd>
          </>
        ) : null}
        {s.direction === "receive" && !video ? (
          <>
            <dt>Concealed audio</dt>
            <dd data-k="concealed">{dash(s.concealedPct, " %")}</dd>
            <dt>FEC recovered</dt>
            <dd>{dash(s.fecPacketsDelta, " packets")}</dd>
          </>
        ) : null}
        {s.direction === "receive" && video ? (
          <>
            <dt>Frames decoded</dt>
            <dd>{dash(s.framesDecodedDelta, " (last 2 s)")}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

const ENC_TEXT: Record<CallParticipant["encryption"], string> = {
  encrypted: "Decrypting their media",
  "waiting-for-key": "Waiting for their key",
  "decrypt-error": "Can't decrypt their media",
  "not-encrypted": "Sending unencrypted media",
  unknown: "Not a call member — gets no keys",
};

export function DiagnosticsPanel({ snap }: { snap: CallSnapshot }) {
  const st = snap.stats;
  const t = st?.transport;
  return (
    <div className="diag stack" aria-label="Call diagnostics">
      <section>
        <h4>
          <Activity aria-hidden="true" /> Connection
        </h4>
        <dl className="kv">
          <dt>State</dt>
          <dd data-k="phase">{snap.phase}</dd>
          <dt>Media server</dt>
          <dd>{snap.focusUrl ? new URL(snap.focusUrl).host : "—"}</dd>
          <dt>ICE</dt>
          <dd data-k="ice">{dash(t?.iceState)}</dd>
          <dt>Path</dt>
          <dd data-k="path">{describeCandidate(t?.local ?? null)}</dd>
          <dt>Round trip</dt>
          <dd data-k="rtt">{dash(t?.rttMs, " ms")}</dd>
          <dt>Reconnections</dt>
          <dd data-k="reconnects">{snap.reconnects}</dd>
        </dl>
        {t?.relayed ? (
          <p className="alert alert-info small" data-testid="turn-relay">
            <Radio aria-hidden="true" />
            <span>TURN relay in use ({(t.local?.relayProtocol ?? t.local?.protocol ?? "").toUpperCase()}): a direct path to the media server isn't available on this network. Media stays encrypted.</span>
          </p>
        ) : null}
      </section>

      <section>
        <h4>Network quality</h4>
        <p className={`quality-label q-${st?.verdict.label ?? "unknown"}`} data-k="quality">
          {st ? { good: "Good", fair: "Fair", poor: "Poor", unknown: "Measuring…" }[st.verdict.label] : "Measuring…"}
        </p>
        {st?.verdict.reasons.length ? (
          <ul className="small">
            {st.verdict.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <p className="xsmall muted">
          Good: round trip under {QUALITY_THRESHOLDS.good.rttMs} ms, loss under {QUALITY_THRESHOLDS.good.lossPct} %, jitter under {QUALITY_THRESHOLDS.good.jitterMs} ms. Fair: under {QUALITY_THRESHOLDS.fair.rttMs} ms /{" "}
          {QUALITY_THRESHOLDS.fair.lossPct} % / {QUALITY_THRESHOLDS.fair.jitterMs} ms. Otherwise poor. The worst measured value decides.
        </p>
      </section>

      <section>
        <h4>Sending</h4>
        {st ? (
          <>
            <Stream title="Microphone" s={st.local.audio} />
            <Stream title="Camera" s={st.local.video} />
            <Stream title="Screen" s={st.local.screen} />
            {!st.local.audio && !st.local.video && !st.local.screen ? <p className="small muted">Nothing is being sent.</p> : null}
          </>
        ) : (
          <p className="small muted">Measuring…</p>
        )}
        {snap.codec ? (
          <p className="xsmall muted">
            Video codec: {snap.codec.chosen.toUpperCase()} — {snap.codec.reason} This browser can send: {snap.codec.sendable.map((c) => c.replace("video/", "")).join(", ") || "—"}.
            {snap.codec.measured.length
              ? ` Measured (720p30): ${snap.codec.measured.map((m) => `${m.codec.toUpperCase()} ${m.supported ? (m.smooth ? "smooth" : "not smooth") : "unsupported"}${m.powerEfficient ? ", hardware" : ""}`).join("; ")}.`
              : ""}
          </p>
        ) : null}
      </section>

      <section>
        <h4>Receiving</h4>
        {snap.participants
          .filter((p) => !p.isLocal && !p.pending)
          .map((p) => {
            const r = st?.remote[p.identity];
            return (
              <div key={p.identity} className="diag-participant" data-participant={p.userId ?? ""}>
                <h5>
                  {p.name}{" "}
                  <span className={`enc-chip enc-${p.encryption}`} data-key-index={p.keyIndex ?? ""}>
                    {ENC_TEXT[p.encryption]}
                    {p.keyIndex !== null ? ` · key #${p.keyIndex}` : ""}
                  </span>
                </h5>
                <Stream title="Audio" s={r?.audio ?? null} />
                <Stream title="Video" s={r?.video ?? null} />
                <Stream title="Screen" s={r?.screen ?? null} />
              </div>
            );
          })}
        {!snap.participants.some((p) => !p.isLocal && !p.pending) ? <p className="small muted">No one else is connected.</p> : null}
      </section>

      <section>
        <h4>Encryption</h4>
        <dl className="kv">
          <dt>Frame encryption</dt>
          <dd data-k="e2ee">{snap.e2ee.enabled ? "on (AES-GCM, per-participant keys)" : "off"}</dd>
          <dt>Your key</dt>
          <dd data-k="own-key">{snap.e2ee.ownKey ? `in use (key #${snap.e2ee.ownKeyIndex})` : "not yet"}</dd>
          <dt>Decrypting</dt>
          <dd>
            {snap.e2ee.remoteEncrypted} of {snap.e2ee.remoteTotal} participants
          </dd>
        </dl>
        <p className="xsmall muted">Keys are created on each device, sent only to the devices in the call over encrypted Matrix messages, and replaced whenever someone leaves.</p>
      </section>

      <section>
        <h4>Events</h4>
        <ol className="diag-events small">
          {snap.events
            .slice()
            .reverse()
            .map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <time dateTime={new Date(e.ts).toISOString()}>{formatTime(e.ts)}</time> {e.text}
              </li>
            ))}
        </ol>
      </section>
      <p className="xsmall muted cluster">
        <Info aria-hidden="true" /> Computed on this device from WebRTC statistics. Nothing is recorded or sent anywhere.
      </p>
    </div>
  );
}
