import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EventTimeline, KnownMembership, MatrixEventEvent, RoomEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { History, LockKeyhole, Search, Server, X, SearchX } from "lucide-react";
import { useMatrix } from "../matrix/context";
import { isMessageEvent } from "../matrix/rooms";
import { formatListTimestamp } from "../lib/format";
import { roomHash } from "../lib/matrix-id";
import { requestHighlight } from "../lib/highlight";
import { errorMessage } from "../lib/errors";
import { useEmitterVersion } from "../hooks/useEmitter";
import { navigate } from "../hooks/useRoute";
import { Spinner } from "./primitives/Spinner";

interface Hit {
  room: Room;
  event: MatrixEvent;
  text: string;
  source: "device" | "server";
}

const MAX_HITS = 200;

function searchableText(ev: MatrixEvent): string | null {
  if (!isMessageEvent(ev) || ev.isRedacted() || ev.isDecryptionFailure()) return null;
  const c = ev.getContent() as { body?: unknown; filename?: unknown };
  if (typeof c.body === "string") return c.body;
  return typeof c.filename === "string" ? c.filename : null;
}

function Highlighted({ text, term }: { text: string; term: string }) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0 || !term) return <>{text.slice(0, 200)}</>;
  const start = Math.max(0, i - 60);
  return (
    <>
      {start > 0 ? "…" : ""}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length, i + term.length + 140)}
    </>
  );
}

/**
 * Message search. Encrypted messages can only be searched on this device, so
 * we search the messages that are loaded and decrypted in memory; the user
 * can load more history. Unencrypted rooms can optionally use server search.
 */
export function SearchPanel({ onClose, currentRoomId }: { onClose: () => void; currentRoomId: string | null }) {
  const { client } = useMatrix();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<"all" | "room">(currentRoomId ? "room" : "all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverOn, setServerOn] = useState(false);
  const [serverHits, setServerHits] = useState<Hit[]>([]);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const v = useEmitterVersion(client, [RoomEvent.Timeline, MatrixEventEvent.Decrypted, RoomEvent.TimelineReset], 200);

  useEffect(() => input.current?.focus(), []);

  const rooms = useMemo(() => {
    void v;
    const joined = client.getRooms().filter((r) => r.getMyMembership() === KnownMembership.Join);
    return scope === "room" && currentRoomId ? joined.filter((r) => r.roomId === currentRoomId) : joined;
  }, [client, scope, currentRoomId, v]);

  const { hits, scanned } = useMemo(() => {
    void v;
    const q = term.trim().toLowerCase();
    let scanned = 0;
    const out: Hit[] = [];
    if (q.length < 2) return { hits: out, scanned };
    for (const room of rooms) {
      for (const ev of room.getLiveTimeline().getEvents()) {
        const text = searchableText(ev);
        if (text === null) continue;
        scanned++;
        if (text.toLowerCase().includes(q)) out.push({ room, event: ev, text, source: "device" });
      }
    }
    out.sort((a, b) => b.event.getTs() - a.event.getTs());
    return { hits: out.slice(0, MAX_HITS), scanned };
  }, [rooms, term, v]);

  const unencryptedRooms = useMemo(() => rooms.filter((r) => !r.hasEncryptionStateEvent()), [rooms]);

  useEffect(() => {
    const q = term.trim();
    if (!serverOn || q.length < 2 || unencryptedRooms.length === 0) {
      setServerHits([]);
      return;
    }
    let alive = true;
    setServerBusy(true);
    setServerError(null);
    const t = setTimeout(() => {
      client
        .searchRoomEvents({ term: q, filter: { rooms: unencryptedRooms.map((r) => r.roomId) } })
        .then((res) => {
          if (!alive) return;
          setServerHits(
            res.results
              .map((r) => r.context.getEvent())
              .map((ev) => ({ room: client.getRoom(ev.getRoomId())!, event: ev, text: searchableText(ev) ?? "", source: "server" as const }))
              .filter((h) => h.room && h.text),
          );
        })
        .catch((e: unknown) => alive && setServerError(errorMessage(e)))
        .finally(() => alive && setServerBusy(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, serverOn, term, unencryptedRooms]);

  const merged = useMemo(() => {
    const seen = new Set(hits.map((h) => h.event.getId()));
    return [...hits, ...serverHits.filter((h) => !seen.has(h.event.getId()))].sort((a, b) => b.event.getTs() - a.event.getTs());
  }, [hits, serverHits]);

  const canLoadMore = rooms.some((r) => r.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS) !== null);
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await Promise.all(
        rooms
          .filter((r) => r.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS) !== null)
          .slice(0, 30)
          .map((r) => client.paginateEventTimeline(r.getLiveTimeline(), { backwards: true, limit: 100 }).catch(() => false)),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="panel">
      <header className="panel-header">
        <h2>Search messages</h2>
        <button type="button" className="icon-btn" aria-label="Close search" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="panel-body">
        <div className="search-box">
          <Search aria-hidden="true" />
          <label htmlFor={inputId} className="visually-hidden">
            Search messages
          </label>
          <input ref={input} id={inputId} type="search" placeholder="Search…" value={term} onChange={(e) => setTerm(e.target.value)} autoComplete="off" />
        </div>
        <div className="chips" role="group" aria-label="Search in">
          <button type="button" className="chip" aria-pressed={scope === "room"} disabled={!currentRoomId} onClick={() => setScope("room")}>
            This conversation
          </button>
          <button type="button" className="chip" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
            All conversations
          </button>
        </div>
        <p className="search-note small">
          <LockKeyhole aria-hidden="true" /> Search runs on this device, over the messages that are loaded and decrypted here. Your search terms
          aren't sent to the server.
        </p>
        {unencryptedRooms.length > 0 ? (
          <label className="checkbox small">
            <input type="checkbox" checked={serverOn} onChange={(e) => setServerOn(e.target.checked)} />
            <span>
              <Server aria-hidden="true" className="inline-icon" /> Also search {unencryptedRooms.length} unencrypted conversation
              {unencryptedRooms.length === 1 ? "" : "s"} on the server (sends your search term to the server)
            </span>
          </label>
        ) : null}
        <div className="search-status small muted" role="status" aria-live="polite">
          {term.trim().length < 2
            ? "Type at least 2 characters."
            : `${merged.length} result${merged.length === 1 ? "" : "s"} in ${scanned} loaded message${scanned === 1 ? "" : "s"}${serverBusy ? " · searching server…" : ""}`}
        </div>
        {serverError ? (
          <p className="form-error" role="alert">
            Server search failed: {serverError}
          </p>
        ) : null}
        {term.trim().length >= 2 && merged.length === 0 && !serverBusy ? (
          <div className="list-empty search-empty">
            <span className="empty-art" aria-hidden="true">
              <SearchX />
            </span>
            <p className="list-empty-title">No matches yet</p>
            <p>{canLoadMore ? "Try other words, or load more history to search further back." : "Try other words or the other conversations."}</p>
          </div>
        ) : null}
        <ul className="list-plain search-results">
          {merged.map((h) => (
            <li key={`${h.source}-${h.event.getId()}`}>
              <button
                type="button"
                className="search-hit"
                onClick={() => {
                  navigate(roomHash(h.room.roomId));
                  requestHighlight(h.room.roomId, h.event.getId()!);
                }}
              >
                <span className="search-hit-head">
                  <span className="search-hit-room">{h.room.name}</span>
                  <time>{formatListTimestamp(h.event.getTs())}</time>
                </span>
                <span className="search-hit-sender">{h.room.getMember(h.event.getSender() ?? "")?.name ?? h.event.getSender()}</span>
                <span className="search-hit-text">
                  <Highlighted text={h.text} term={term.trim()} />
                </span>
                {h.source === "server" ? <span className="badge badge-plain">server result</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {canLoadMore ? (
          <button type="button" className="btn btn-sm btn-block" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner size="sm" /> : <History aria-hidden="true" />} Load more history to search
          </button>
        ) : (
          <p className="small subtle center">All history available to this device is loaded.</p>
        )}
      </div>
    </div>
  );
}
