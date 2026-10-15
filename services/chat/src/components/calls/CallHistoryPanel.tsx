/** Call history of one conversation, built from its loaded timeline (see calls/history.ts). */
import { useMemo } from "react";
import { EventTimeline, RoomEvent, MatrixEventEvent } from "matrix-js-sdk";
import { Info, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Video, X } from "lucide-react";
import { buildCallHistory, outcomeFor, type CallOutcome } from "../../calls/history";
import { openLobby, useRoomCall } from "../../calls/store";
import { useEmitterVersion } from "../../hooks/useEmitter";
import { useRoom } from "../../hooks/matrix";
import { formatDayLabel, formatDuration, formatTime } from "../../lib/format";
import { useMatrix } from "../../matrix/context";

const OUTCOME: Record<CallOutcome, { label: string; icon: React.ReactNode; cls: string }> = {
  ongoing: { label: "In progress", icon: <PhoneCall aria-hidden="true" />, cls: "ok" },
  outgoing: { label: "Outgoing", icon: <PhoneOutgoing aria-hidden="true" />, cls: "" },
  answered: { label: "Incoming", icon: <PhoneIncoming aria-hidden="true" />, cls: "" },
  missed: { label: "Missed", icon: <PhoneMissed aria-hidden="true" />, cls: "danger-text" },
  declined: { label: "Declined", icon: <PhoneOff aria-hidden="true" />, cls: "" },
  "not-joined": { label: "You didn't join", icon: <PhoneIncoming aria-hidden="true" />, cls: "muted" },
};

const EVENTS = [RoomEvent.Timeline, RoomEvent.TimelineReset] as const;

export function CallHistoryPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { client, userId } = useMatrix();
  const room = useRoom(client, roomId);
  const v = useEmitterVersion(room, EVENTS, 200);
  const v2 = useEmitterVersion(client, [MatrixEventEvent.Decrypted] as const, 200);
  const live = useRoomCall(client, room);
  const calls = useMemo(() => {
    void v;
    void v2;
    if (!room) return [];
    return buildCallHistory(room.getLiveTimeline().getEvents(), live.devices).reverse();
  }, [room, v, v2, live.devices]);
  const canLoadMore = !!room && room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS) !== null;
  const nameOf = (u: string) => room?.getMember(u)?.name ?? u;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Call history</h2>
        <button type="button" className="icon-btn" aria-label="Close call history" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="panel-body">
        {calls.length === 0 ? <p className="muted small">No calls in the loaded part of this conversation.</p> : null}
        <ul className="list-plain call-history">
          {calls.map((c) => {
            const o = outcomeFor(c, userId);
            const meta = OUTCOME[o];
            const dur = c.endTs ? formatDuration((c.endTs - c.startTs) / 1000) : null;
            return (
              <li key={c.id} className="call-history-item" data-outcome={o}>
                <span className={`call-history-icon ${meta.cls}`}>{c.intent === "video" ? <Video aria-hidden="true" /> : meta.icon}</span>
                <span className="call-history-main">
                  <span className={`call-history-title ${meta.cls}`}>
                    {meta.label} {c.intent === "video" ? "video call" : c.intent === "audio" ? "voice call" : "call"}
                  </span>
                  <span className="xsmall muted">
                    {formatDayLabel(c.startTs)}, {formatTime(c.startTs)}
                    {dur ? ` · ${dur}` : ""} · started by {c.startedBy === userId ? "you" : nameOf(c.startedBy)}
                    {c.participants.length > 1 ? ` · ${c.participants.length} people` : ""}
                    {c.declinedBy.length ? ` · declined by ${c.declinedBy.map((u) => (u === userId ? "you" : nameOf(u))).join(", ")}` : ""}
                  </span>
                </span>
                {o === "ongoing" && !live.joinedHere ? (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => openLobby({ roomId, intent: c.intent ?? "audio", joining: true })}>
                    Join
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="search-note small">
          <Info aria-hidden="true" />
          <span>
            Built from the part of this conversation loaded on this device{canLoadMore ? " — scroll up in the conversation to include older calls" : ""}. Calls are recognised from their encrypted call events; nothing is stored separately.
          </span>
        </p>
      </div>
    </div>
  );
}
