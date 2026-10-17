/**
 * Timeline items for calls: started (with Join while it lasts), ended / missed, declined, legacy.
 * Each is one compact row; consecutive rows share one card (`CallLog`), so a run of calls reads
 * as a short log instead of a stack of pills.
 */
import type { ReactNode } from "react";
import type { Room } from "matrix-js-sdk";
import { PhoneCall, PhoneMissed, PhoneOff, Video, PhoneOutgoing } from "lucide-react";
import { outcomeFor, type CallMarker } from "../../calls/history";
import { openLobby } from "../../calls/store";
import { formatDuration, formatFullDate, formatTime } from "../../lib/format";

function Row({ kind, tone, icon, children, ts, extra }: { kind: string; tone?: "missed" | "live"; icon: ReactNode; children: ReactNode; ts: number | null; extra?: ReactNode }) {
  return (
    <div className={`call-item${tone ? ` ${tone}` : ""}`} data-call={kind}>
      <span className="call-item-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="call-item-text">{children}</span>
      {extra}
      {ts ? (
        <time className="call-item-time" dateTime={new Date(ts).toISOString()} title={formatFullDate(ts)}>
          {formatTime(ts)}
        </time>
      ) : null}
    </div>
  );
}

export function CallTimelineItem({ marker, room, me, joinedHere, ts = null }: { marker: CallMarker; room: Room; me: string; joinedHere: boolean; ts?: number | null }) {
  const nameOf = (u: string) => (u === me ? "You" : (room.getMember(u)?.name ?? u));
  switch (marker.kind) {
    case "call-started": {
      const c = marker.call;
      const kind = c.intent === "video" ? "video call" : c.intent === "audio" ? "voice call" : "call";
      return (
        <Row
          kind="started"
          tone={c.ongoing ? "live" : undefined}
          icon={c.intent === "video" ? <Video /> : <PhoneOutgoing />}
          ts={c.startTs}
          extra={
            c.ongoing && !joinedHere ? (
              <button type="button" className="btn btn-sm btn-success" onClick={() => openLobby({ roomId: room.roomId, intent: c.intent ?? "audio", joining: true })}>
                Join
              </button>
            ) : c.ongoing ? (
              <span className="badge badge-success">In progress</span>
            ) : null
          }
        >
          {nameOf(c.startedBy)} started a {kind}
        </Row>
      );
    }
    case "call-ended": {
      const c = marker.call;
      const o = outcomeFor(c, me);
      const dur = c.endTs ? formatDuration((c.endTs - c.startTs) / 1000) : null;
      if (o === "missed") {
        return (
          <Row kind="missed" tone="missed" icon={<PhoneMissed />} ts={c.startTs}>
            Missed {c.intent === "video" ? "video call" : "call"} from {nameOf(c.startedBy)}
          </Row>
        );
      }
      return (
        <Row kind="ended" icon={<PhoneCall />} ts={c.endTs}>
          Call ended{dur ? ` · ${dur}` : ""}
          {c.participants.length > 1 ? ` · ${c.participants.length} people` : ""}
          {o === "declined" ? " · you declined" : ""}
        </Row>
      );
    }
    case "call-declined":
      return (
        <Row kind="declined" icon={<PhoneOff />} ts={ts}>
          {nameOf(marker.sender)} declined the call
        </Row>
      );
    case "legacy-call":
      return (
        <Row kind="legacy" tone={marker.sender === me ? undefined : "missed"} icon={<PhoneOff />} ts={ts}>
          {marker.sender === me ? "You tried to call with an older call type, which this app doesn't support" : `${nameOf(marker.sender)} tried to call with an older call type this app doesn't support`}
        </Row>
      );
  }
}
