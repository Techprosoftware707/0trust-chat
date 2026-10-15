/** Turns a list of MatrixEvents into display items (day separators, grouping, notices). */
import { EventType, type MatrixEvent } from "matrix-js-sdk";
import { isSameDay } from "../lib/format";
import { isMessageEvent } from "./rooms";
import type { CallMarker } from "../calls/history";

export type TimelineItem =
  | { kind: "day"; key: string; ts: number }
  | { kind: "message"; key: string; event: MatrixEvent; continuation: boolean }
  | { kind: "notice"; key: string; event: MatrixEvent; text: string }
  | { kind: "call"; key: string; event: MatrixEvent; marker: CallMarker };

const GROUP_WINDOW_MS = 5 * 60 * 1000;

type NameOf = (userId: string) => string;

/** Human-readable text for state events we show in the timeline; null to hide. */
export function noticeText(ev: MatrixEvent, nameOf: NameOf): string | null {
  const sender = nameOf(ev.getSender() ?? "");
  const c = ev.getContent() as Record<string, unknown>;
  const prev = (ev.getPrevContent() ?? {}) as Record<string, unknown>;
  switch (ev.getType()) {
    case EventType.RoomCreate:
      return `${sender} created the conversation`;
    case EventType.RoomEncryption:
      return "End-to-end encryption is enabled. Messages are encrypted on your devices before they are sent.";
    case EventType.RoomName:
      return c.name ? `${sender} renamed the conversation to “${String(c.name)}”` : `${sender} removed the conversation name`;
    case EventType.RoomTopic:
      return c.topic ? `${sender} changed the topic to “${String(c.topic)}”` : `${sender} removed the topic`;
    case EventType.RoomAvatar:
      return `${sender} changed the conversation picture`;
    case EventType.RoomMember: {
      const target = ev.getStateKey() ?? "";
      const targetName = (c.displayname as string) || nameOf(target);
      const m = c.membership;
      const pm = prev.membership;
      if (m === "join" && pm === "join") {
        if (c.displayname !== prev.displayname) {
          return c.displayname
            ? prev.displayname
              ? `${String(prev.displayname)} changed their name to ${String(c.displayname)}`
              : `${target} set their name to ${String(c.displayname)}`
            : `${String(prev.displayname)} removed their display name`;
        }
        if (c.avatar_url !== prev.avatar_url) return `${targetName} changed their profile picture`;
        return null;
      }
      if (m === "join") return `${targetName} joined`;
      if (m === "invite") return `${sender} invited ${targetName}`;
      if (m === "leave") {
        if (ev.getSender() === target) return pm === "invite" ? `${targetName} declined the invitation` : `${targetName} left`;
        if (pm === "invite") return `${sender} withdrew ${targetName}'s invitation`;
        if (pm === "ban") return `${sender} unbanned ${targetName}`;
        return `${sender} removed ${targetName}`;
      }
      if (m === "ban") return `${sender} banned ${targetName}`;
      if (m === "knock") return `${targetName} asked to join`;
      return null;
    }
    default:
      return null;
  }
}

/**
 * @param callMarkers call items keyed by event id (see calls/history.ts): the first join of a
 *   call, its end, declines and legacy call invites. Other call events stay hidden.
 * @param blocked senders whose messages are hidden: the server stops sending them once they are
 *   blocked, this also hides the ones already loaded. Membership changes stay visible.
 */
export function buildTimeline(
  events: MatrixEvent[],
  nameOf: NameOf,
  callMarkers?: Map<string, CallMarker>,
  blocked?: ReadonlySet<string>,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let prevTs: number | null = null;
  let prevMessage: MatrixEvent | null = null;
  for (const ev of events) {
    if (blocked?.size && !ev.isState() && blocked.has(ev.getSender() ?? "")) continue;
    const ts = ev.getTs();
    const key = ev.getId() ?? ev.getTxnId() ?? `${ts}-${items.length}`;
    let item: TimelineItem | null = null;
    const msgtype = (ev.getContent() as { msgtype?: string }).msgtype;
    const marker = callMarkers?.get(ev.getId() ?? "");
    if (marker) {
      item = { kind: "call", key, event: ev, marker };
    } else if (ev.getType() === EventType.RoomMessage && msgtype === "m.key.verification.request" && !ev.isRedacted()) {
      const to = (ev.getContent() as { to?: string }).to;
      item = { kind: "notice", key, event: ev, text: `${nameOf(ev.getSender() ?? "")} sent a verification request${to ? ` to ${nameOf(to)}` : ""}` };
    } else if (isMessageEvent(ev)) {
      const continuation: boolean =
        prevMessage !== null &&
        prevMessage.getSender() === ev.getSender() &&
        !prevMessage.isRedacted() &&
        ts - prevMessage.getTs() < GROUP_WINDOW_MS &&
        isSameDay(prevMessage.getTs(), ts);
      item = { kind: "message", key, event: ev, continuation };
    } else if (ev.isState()) {
      const text = noticeText(ev, nameOf);
      if (text) item = { kind: "notice", key, event: ev, text };
    }
    if (!item) continue;
    if (prevTs === null || !isSameDay(prevTs, ts)) {
      items.push({ kind: "day", key: `day-${key}`, ts });
      if (item.kind === "message") item.continuation = false;
    }
    items.push(item);
    prevTs = ts;
    prevMessage = item.kind === "message" ? ev : null;
  }
  return items;
}
