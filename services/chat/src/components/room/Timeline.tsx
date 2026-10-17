import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EventTimeline,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { ArrowDown, LockKeyhole } from "lucide-react";
import { useClient } from "../../matrix/context";
import { buildTimeline, type TimelineItem } from "../../matrix/timeline";
import { buildCallHistory, callMarkers } from "../../calls/history";
import { useRoomCall } from "../../calls/store";
import { CallTimelineItem } from "../calls/CallTimelineItem";
import { previewText } from "../../matrix/rooms";
import { formatDayLabel } from "../../lib/format";
import { getPrefs } from "../../lib/prefs";
import { useEmitterVersion } from "../../hooks/useEmitter";
import { useBlockedUsers } from "../../hooks/matrix";
import { consumeHighlight, subscribeHighlight } from "../../lib/highlight";
import { MessageTile } from "./MessageTile";

const PAGE = 30;
const ROOM_EVENTS = [
  RoomEvent.Timeline,
  RoomEvent.TimelineReset,
  RoomEvent.LocalEchoUpdated,
  RoomEvent.Redaction,
  RoomEvent.RedactionCancelled,
  RoomEvent.Receipt,
  RoomEvent.TimelineRefresh,
] as const;
const CLIENT_EVENTS = [MatrixEventEvent.Decrypted, MatrixEventEvent.Replaced, MatrixEventEvent.VisibilityChange] as const;

type CallItem = Extract<TimelineItem, { kind: "call" }>;
type NoticeItem = Extract<TimelineItem, { kind: "notice" }>;
type Block = TimelineItem | { kind: "call-run"; key: string; items: CallItem[] } | { kind: "notice-run"; key: string; items: NoticeItem[] };

/** Consecutive call items share one compact card; consecutive notices one quiet block. */
function groupRuns(items: TimelineItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "call") {
      if (last?.kind === "call-run") last.items.push(it);
      else out.push({ kind: "call-run", key: `calls-${it.key}`, items: [it] });
    } else if (it.kind === "notice") {
      if (last?.kind === "notice-run") last.items.push(it);
      else out.push({ kind: "notice-run", key: `notices-${it.key}`, items: [it] });
    } else out.push(it);
  }
  return out;
}

function lastRealEvent(room: Room): MatrixEvent | null {
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1; i >= 0; i--) {
    const id = evs[i].getId();
    if (id && id.startsWith("$") && evs[i].status === null) return evs[i];
  }
  return null;
}

export function Timeline({
  room,
  roomEncrypted,
  onReply,
  onEdit,
}: {
  room: Room;
  roomEncrypted: boolean | null;
  onReply: (ev: MatrixEvent) => void;
  onEdit: (ev: MatrixEvent) => void;
}) {
  const client = useClient();
  const me = client.getUserId() ?? "";
  const v1 = useEmitterVersion(room, ROOM_EVENTS, 30);
  const v2 = useEmitterVersion(client, CLIENT_EVENTS, 30);
  const version = v1 * 100003 + v2;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [paginating, setPaginating] = useState(false);
  const [canPaginate, setCanPaginate] = useState(true);
  const [paginateError, setPaginateError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnounced = useRef<string | null>(null);

  const nameOf = useCallback((u: string) => room.getMember(u)?.name ?? u, [room]);

  const events = useMemo(() => {
    void version;
    return [...room.getLiveTimeline().getEvents(), ...room.getPendingEvents()];
  }, [room, version]);
  const liveCall = useRoomCall(client, room);
  const markers = useMemo(() => callMarkers(events, buildCallHistory(events, liveCall.devices)), [events, liveCall.devices]);
  const blockedList = useBlockedUsers(client);
  const blocked = useMemo(() => new Set(blockedList), [blockedList]);
  const items = useMemo(() => buildTimeline(events, nameOf, markers, blocked), [events, nameOf, markers, blocked]);
  const blocks = useMemo(() => groupRuns(items), [items]);
  // Messages that arrive (or are sent) while the conversation is open get a short entrance.
  const openedAt = useRef(Date.now());

  // Who has read each of my recent messages: their read receipt (or a later message of
  // theirs) is at or after it. Only real receipt data from the server is used.
  const readersByEvent = useMemo(() => {
    void version;
    const map = new Map<string, string[]>();
    const others = room
      .getJoinedMembers()
      .map((m) => m.userId)
      .filter((u) => u !== me)
      .slice(0, 50);
    if (!others.length) return map;
    let ownSeen = 0;
    for (let i = items.length - 1; i >= 0 && ownSeen < 25; i--) {
      const it = items[i];
      if (it.kind !== "message" || it.event.getSender() !== me || it.event.status !== null) continue;
      ownSeen++;
      const id = it.event.getId();
      if (id && id.startsWith("$")) map.set(id, others.filter((u) => room.hasUserReadEvent(u, id)));
    }
    return map;
  }, [items, room, me, version]);

  const captureAnchor = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const children = el.querySelectorAll<HTMLElement>("[data-item]");
    for (const c of children) {
      if (c.offsetTop + c.offsetHeight > top) {
        anchor.current = { id: c.dataset.item!, offset: c.offsetTop - top };
        return;
      }
    }
  };

  const loadOlder = useCallback(async () => {
    if (paginating) return;
    const tl = room.getLiveTimeline();
    if (tl.getPaginationToken(EventTimeline.BACKWARDS) === null) {
      setCanPaginate(false);
      return;
    }
    captureAnchor();
    setPaginating(true);
    setPaginateError(false);
    try {
      const more = await client.paginateEventTimeline(tl, { backwards: true, limit: PAGE });
      setCanPaginate(more);
    } catch {
      setPaginateError(true);
    } finally {
      setPaginating(false);
    }
  }, [client, room, paginating]);

  // Keep the view anchored: stick to the bottom, or keep the top-most visible item in place.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const node = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(anchor.current.id)}"]`);
      if (node) el.scrollTop = node.offsetTop - anchor.current.offset;
    }
  }, [items]);

  // Content can grow and the viewport can shrink after render: stay pinned to the bottom if
  // the user was there (and then send the read receipt).
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inner = innerRef.current;
    const el = scrollRef.current;
    if (!inner || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!atBottom.current) return;
      el.scrollTop = el.scrollHeight;
      sendReceiptRef.current();
    });
    ro.observe(inner); // content grows (images, avatars, fonts)
    ro.observe(el); // viewport shrinks (banners, composer growing, keyboard on mobile)
    return () => ro.disconnect();
  }, []);

  // Fill the viewport: keep paginating while there's no scrollbar yet.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || paginating || !canPaginate || paginateError) return;
    if (el.scrollHeight <= el.clientHeight + 40) void loadOlder();
  }, [items, paginating, canPaginate, paginateError, loadOlder]);

  // Read receipts: only when the latest message is actually visible to the user.
  const sendReceiptRef = useRef<() => void>(() => undefined);
  const sendReceiptIfNeeded = useCallback(() => {
    if (document.hidden || !atBottom.current) return;
    const ev = lastRealEvent(room);
    // Compare with our last *real* receipt: the SDK counts our own messages as read, but the
    // server's unread count only resets when we actually send a receipt.
    if (!ev || !ev.getId() || room.getEventReadUpTo(me, true) === ev.getId()) return;
    const type = getPrefs().sendReadReceipts ? ReceiptType.Read : ReceiptType.ReadPrivate;
    client.sendReadReceipt(ev, type).catch(() => undefined);
  }, [client, room, me]);

  sendReceiptRef.current = sendReceiptIfNeeded;
  useEffect(() => {
    const t = setTimeout(sendReceiptIfNeeded, 400);
    return () => clearTimeout(t);
  }, [items, sendReceiptIfNeeded]);
  useEffect(() => {
    const onVis = () => sendReceiptIfNeeded();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [sendReceiptIfNeeded]);

  // Announce new incoming messages to screen readers.
  useEffect(() => {
    const last = [...items].reverse().find((i) => i.kind === "message");
    if (!last || last.kind !== "message") return;
    const id = last.event.getId() ?? null;
    if (lastAnnounced.current === null) {
      lastAnnounced.current = id; // don't announce the initial history
      return;
    }
    if (id === lastAnnounced.current) return;
    lastAnnounced.current = id;
    if (last.event.getSender() !== me) setAnnouncement(`New message from ${nameOf(last.event.getSender() ?? "")}: ${previewText(last.event, me)}`);
  }, [items, me, nameOf]);

  // Jump to a search result.
  useEffect(() => {
    const go = () => {
      const target = consumeHighlight(room.roomId);
      if (!target) return;
      const el = document.getElementById(`ev-${target}`);
      if (el) {
        atBottom.current = false;
        el.scrollIntoView({ block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1800);
      }
    };
    go();
    return subscribeHighlight(go);
  }, [room.roomId, items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowJump(!bottom);
    captureAnchor();
    if (bottom) sendReceiptIfNeeded();
    if (el.scrollTop < 400 && canPaginate && !paginating && !paginateError) void loadOlder();
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = true;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    setShowJump(false);
  };

  const atStart = !canPaginate;

  return (
    <div className="timeline-wrap">
      <div
        className="timeline"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-live="off"
        tabIndex={0}
      >
        <div className="timeline-inner" ref={innerRef}>
          <div className="timeline-top">
            {paginating ? (
              <div className="timeline-skeleton" role="status">
                <span className="visually-hidden">Loading earlier messages…</span>
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ) : paginateError ? (
              <button type="button" className="btn btn-sm" onClick={() => void loadOlder()}>
                Couldn't load earlier messages — retry
              </button>
            ) : atStart ? (
              <div className="timeline-start">
                <span className="timeline-start-icon" aria-hidden="true">
                  <LockKeyhole />
                </span>
                <p className="timeline-start-title">This is the beginning of the conversation.</p>
                <p className="timeline-start-text">
                  {roomEncrypted
                    ? "Messages here are end-to-end encrypted with Matrix: only the people in this conversation can read them."
                    : roomEncrypted === false
                      ? "Messages here are not end-to-end encrypted."
                      : ""}
                </p>
              </div>
            ) : (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void loadOlder()}>
                Load earlier messages
              </button>
            )}
          </div>
          {blocks.map((it) => {
            if (it.kind === "day") {
              return (
                <div key={it.key} className="day-sep" data-item={it.key} role="separator" aria-label={formatDayLabel(it.ts)}>
                  <span>{formatDayLabel(it.ts)}</span>
                </div>
              );
            }
            if (it.kind === "call-run") {
              return (
                <div key={it.key} className="call-log" role="group" aria-label={it.items.length === 1 ? "Call" : `${it.items.length} call events`}>
                  {it.items.map((c) => (
                    <div key={c.key} data-item={c.key}>
                      <CallTimelineItem marker={c.marker} room={room} me={me} joinedHere={liveCall.joinedHere} ts={c.event.getTs()} />
                    </div>
                  ))}
                </div>
              );
            }
            if (it.kind === "notice-run") {
              return (
                <div key={it.key} className="notice-run">
                  {it.items.map((n) => (
                    <div key={n.key} className="notice" data-item={n.key}>
                      {n.text}
                    </div>
                  ))}
                </div>
              );
            }
            if (it.kind !== "message") return null;
            const id = it.event.getId() ?? "";
            return (
              <div key={it.key} data-item={it.key}>
                <MessageTile
                  event={it.event}
                  room={room}
                  continuation={it.continuation}
                  isOwn={it.event.getSender() === me}
                  readers={readersByEvent.get(id) ?? EMPTY}
                  roomEncrypted={roomEncrypted}
                  version={version}
                  fresh={it.event.getTs() >= openedAt.current - 1000}
                  onReply={onReply}
                  onEdit={onEdit}
                />
              </div>
            );
          })}
        </div>
      </div>
      {showJump ? (
        <button type="button" className="jump-latest btn btn-sm" onClick={jumpToBottom}>
          <ArrowDown aria-hidden="true" /> Jump to latest
        </button>
      ) : null}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

const EMPTY: string[] = [];
