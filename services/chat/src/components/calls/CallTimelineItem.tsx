/** Timeline items for calls: started (with Join while it lasts), ended / missed, declined, legacy. */
import type { Room } from "matrix-js-sdk";
import { PhoneCall, PhoneMissed, PhoneOff, Video, PhoneOutgoing } from "lucide-react";
import { outcomeFor, type CallMarker } from "../../calls/history";
import { openLobby } from "../../calls/store";
import { formatDuration, formatTime } from "../../lib/format";

export function CallTimelineItem({ marker, room, me, joinedHere }: { marker: CallMarker; room: Room; me: string; joinedHere: boolean }) {
  const nameOf = (u: string) => (u === me ? "You" : (room.getMember(u)?.name ?? u));
  switch (marker.kind) {
    case "call-started": {
      const c = marker.call;
      const kind = c.intent === "video" ? "video call" : c.intent === "audio" ? "voice call" : "call";
      return (
        <div className="call-item" data-call="started">
          <span className="call-item-icon">{c.intent === "video" ? <Video aria-hidden="true" /> : <PhoneOutgoing aria-hidden="true" />}</span>
          <span className="call-item-text">
            {nameOf(c.startedBy)} started a {kind} · {formatTime(c.startTs)}
          </span>
          {c.ongoing && !joinedHere ? (
            <button type="button" className="btn btn-sm btn-success" onClick={() => openLobby({ roomId: room.roomId, intent: c.intent ?? "audio", joining: true })}>
              Join
            </button>
          ) : c.ongoing ? (
            <span className="badge badge-success">In progress</span>
          ) : null}
        </div>
      );
    }
    case "call-ended": {
      const c = marker.call;
      const o = outcomeFor(c, me);
      const dur = c.endTs ? formatDuration((c.endTs - c.startTs) / 1000) : null;
      if (o === "missed") {
        return (
          <div className="call-item missed" data-call="missed">
            <span className="call-item-icon">
              <PhoneMissed aria-hidden="true" />
            </span>
            <span className="call-item-text">
              Missed {c.intent === "video" ? "video call" : "call"} from {nameOf(c.startedBy)} · {formatTime(c.startTs)}
            </span>
          </div>
        );
      }
      return (
        <div className="call-item" data-call="ended">
          <span className="call-item-icon">
            <PhoneCall aria-hidden="true" />
          </span>
          <span className="call-item-text">
            Call ended{dur ? ` · ${dur}` : ""}
            {c.participants.length > 1 ? ` · ${c.participants.length} people` : ""}
            {o === "declined" ? " · you declined" : ""}
          </span>
        </div>
      );
    }
    case "call-declined":
      return (
        <div className="call-item" data-call="declined">
          <span className="call-item-icon">
            <PhoneOff aria-hidden="true" />
          </span>
          <span className="call-item-text">{nameOf(marker.sender)} declined the call</span>
        </div>
      );
    case "legacy-call":
      return (
        <div className="call-item missed" data-call="legacy">
          <span className="call-item-icon">
            <PhoneOff aria-hidden="true" />
          </span>
          <span className="call-item-text">{nameOf(marker.sender)} tried to call with an older call type this app doesn't support</span>
        </div>
      );
  }
}
