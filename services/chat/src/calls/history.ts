/**
 * Call history from the room timeline: MatrixRTC membership state events
 * (`org.matrix.msc3401.call.member`), ring/notification events and declines.
 *
 * Limits (also shown in the UI): only the part of the timeline this device has loaded is
 * considered (scrolling back loads more), a call that started before the loaded history shows
 * up only from its first loaded event, and memberships that ended without a leave event (crashed
 * client and no delayed leave) are closed using the live call state.
 */
import { EventType, type MatrixEvent } from "matrix-js-sdk";
import { CALL_MEMBER_EVENT, LEGACY_CALL_INVITE, RTC_DECLINE_EVENT, RTC_NOTIFICATION_EVENT } from "./rtc";

export interface CallRecord {
  id: string; // event id of the first join
  startTs: number;
  endTs: number | null;
  startedBy: string;
  intent: "audio" | "video" | null;
  participants: string[];
  /** ring/notification event ids sent for this call */
  notifications: { id: string; sender: string; type: "ring" | "notification"; ts: number; mentionsAll: boolean; userIds: string[] }[];
  declinedBy: string[];
  ongoing: boolean;
  startEventId: string;
  endEventId: string | null;
}

export type CallOutcome = "ongoing" | "outgoing" | "answered" | "missed" | "declined" | "not-joined";

export function outcomeFor(c: CallRecord, me: string): CallOutcome {
  if (c.ongoing) return "ongoing";
  if (c.startedBy === me) return "outgoing";
  if (c.participants.includes(me)) return "answered";
  if (c.declinedBy.includes(me)) return "declined";
  const notifiedMe = c.notifications.some((n) => n.sender !== me && (n.mentionsAll || n.userIds.includes(me)));
  return notifiedMe ? "missed" : "not-joined";
}

function isJoinContent(c: Record<string, unknown>): boolean {
  // m.call.member (session format) for our slot: application m.call, call_id "" (= ROOM)
  return typeof c.device_id === "string" && (c.application === undefined || c.application === "m.call") && (c.call_id === undefined || c.call_id === "" || c.call_id === "ROOM");
}

/**
 * @param events the room's loaded timeline (oldest first)
 * @param liveDevices current number of memberships in the room's call (from MatrixRTC)
 */
export function buildCallHistory(events: MatrixEvent[], liveDevices: number): CallRecord[] {
  const calls: CallRecord[] = [];
  const active = new Map<string, string>(); // state key -> user
  let current: CallRecord | null = null;
  const byNotification = new Map<string, CallRecord>();
  const pendingDeclines: { notif: string; sender: string }[] = [];
  for (const ev of events) {
    const type = ev.getType();
    const id = ev.getId();
    if (!id || !id.startsWith("$")) continue;
    if (type === CALL_MEMBER_EVENT && ev.isState()) {
      const key = ev.getStateKey() ?? "";
      const c = ev.getContent() as Record<string, unknown>;
      const sender = ev.getSender() ?? "";
      if (isJoinContent(c)) {
        if (active.has(key)) continue; // renewal of an existing membership
        active.set(key, sender);
        if (!current) {
          const intent = c["m.call.intent"];
          current = {
            id,
            startTs: ev.getTs(),
            endTs: null,
            startedBy: sender,
            intent: intent === "video" ? "video" : intent === "audio" ? "audio" : null,
            participants: [],
            notifications: [],
            declinedBy: [],
            ongoing: true,
            startEventId: id,
            endEventId: null,
          };
          calls.push(current);
        }
        if (!current.participants.includes(sender)) current.participants.push(sender);
      } else if (active.has(key)) {
        active.delete(key);
        if (current && active.size === 0) {
          current.endTs = ev.getTs();
          current.endEventId = id;
          current.ongoing = false;
          current = null;
        }
      }
    } else if (type === RTC_NOTIFICATION_EVENT) {
      const c = ev.getContent() as Record<string, unknown>;
      const m = (c["m.mentions"] ?? {}) as { room?: unknown; user_ids?: unknown };
      const target = current ?? calls[calls.length - 1];
      if (!target) continue;
      const n = {
        id,
        sender: ev.getSender() ?? "",
        type: (c.notification_type === "ring" ? "ring" : "notification") as "ring" | "notification",
        ts: ev.getTs(),
        mentionsAll: m.room === true,
        userIds: Array.isArray(m.user_ids) ? (m.user_ids as unknown[]).filter((u): u is string => typeof u === "string") : [],
      };
      target.notifications.push(n);
      byNotification.set(id, target);
      if (!target.intent && (c["m.call.intent"] === "video" || c["m.call.intent"] === "audio")) target.intent = c["m.call.intent"] as "audio" | "video";
    } else if (type === RTC_DECLINE_EVENT) {
      const notif = ev.getRelation()?.event_id;
      if (notif) pendingDeclines.push({ notif, sender: ev.getSender() ?? "" });
    }
  }
  for (const d of pendingDeclines) {
    const call = byNotification.get(d.notif);
    if (call && !call.declinedBy.includes(d.sender)) call.declinedBy.push(d.sender);
  }
  // A call we think is ongoing although nobody is in it any more ended without a leave event.
  if (current && liveDevices === 0) current.ongoing = false;
  return calls;
}

export type CallMarker =
  | { kind: "call-started"; call: CallRecord }
  | { kind: "call-ended"; call: CallRecord }
  | { kind: "call-declined"; sender: string }
  | { kind: "legacy-call"; sender: string };

/** Which timeline events render as call items (everything else call-related stays hidden). */
export function callMarkers(events: MatrixEvent[], calls: CallRecord[]): Map<string, CallMarker> {
  const map = new Map<string, CallMarker>();
  for (const c of calls) {
    map.set(c.startEventId, { kind: "call-started", call: c });
    if (c.endEventId) map.set(c.endEventId, { kind: "call-ended", call: c });
  }
  for (const ev of events) {
    const id = ev.getId();
    if (!id) continue;
    if (ev.getType() === RTC_DECLINE_EVENT) map.set(id, { kind: "call-declined", sender: ev.getSender() ?? "" });
    else if (ev.getType() === LEGACY_CALL_INVITE) map.set(id, { kind: "legacy-call", sender: ev.getSender() ?? "" });
  }
  return map;
}

export function isCallEventType(type: string): boolean {
  return (
    type === CALL_MEMBER_EVENT ||
    type === RTC_NOTIFICATION_EVENT ||
    type === RTC_DECLINE_EVENT ||
    type === EventType.CallInvite ||
    type === EventType.CallAnswer ||
    type === EventType.CallHangup ||
    type === EventType.CallCandidates ||
    type === EventType.CallSelectAnswer ||
    type === EventType.CallReject ||
    type === EventType.CallNegotiate
  );
}

/**
 * The newest call in the loaded timeline was missed by `me` and `me` hasn't read past it yet
 * (read receipt): drives the missed-call indicator in the room list.
 */
export function unseenMissedCall(events: MatrixEvent[], me: string, liveDevices: number, readUpToId: string | null): CallRecord | null {
  if (!events.some((e) => e.getType() === RTC_NOTIFICATION_EVENT)) return null;
  const calls = buildCallHistory(events, liveDevices);
  const last = calls[calls.length - 1];
  if (!last || outcomeFor(last, me) !== "missed") return null;
  const lastIdx = events.findIndex((e) => e.getId() === (last.endEventId ?? last.startEventId));
  const readIdx = readUpToId ? events.findIndex((e) => e.getId() === readUpToId) : -1;
  return readIdx >= lastIdx && lastIdx >= 0 ? null : last;
}
