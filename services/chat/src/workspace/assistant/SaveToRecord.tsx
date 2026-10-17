/**
 * "Save to record" next to a conversation: the person ticks messages they can read here
 * (already decrypted on this device) and saves a copy as a note on the record this
 * conversation is linked to. Off unless the workspace turned it on. The copy leaves end-to-end
 * encryption, and the panel says so before anything is saved.
 */

import { useMemo, useState } from "react";
import { EventType, MatrixEventEvent, RoomEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { Lock, MessageSquareQuote, Save, X } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { useEmitterVersion } from "../../hooks/useEmitter";
import { stripReplyFallback } from "../../lib/markdown";
import { useClient } from "../../matrix/context";
import { isMessageEvent } from "../../matrix/rooms";
import { describeError } from "../api";
import { useWorkspace } from "../context";
import type { RoomLink } from "../types";
import { formatWhen } from "../ui";
import { assistantBase } from "./components";
import { buildSavePayload, selectionProblem } from "./logic";
import type { ChatMessageCandidate } from "./types";

const ROOM_EVENTS = [RoomEvent.Timeline, RoomEvent.TimelineReset, RoomEvent.Redaction, RoomEvent.LocalEchoUpdated] as const;
const CLIENT_EVENTS = [MatrixEventEvent.Decrypted, MatrixEventEvent.Replaced] as const;
const TEXT_TYPES = new Set(["m.text", "m.notice", "m.emote"]);

/** Text messages of the room that this device has decrypted (newest last, at most `limit`). */
export function textMessages(room: Room | null, limit = 40): ChatMessageCandidate[] {
  if (!room) return [];
  const out: ChatMessageCandidate[] = [];
  const events: MatrixEvent[] = room.getLiveTimeline().getEvents();
  for (const ev of events) {
    if (!isMessageEvent(ev) || ev.isRedacted() || ev.isDecryptionFailure() || ev.getType() === EventType.RoomMessageEncrypted) continue;
    const id = ev.getId();
    if (!id || !id.startsWith("$")) continue;
    const c = ev.getContent() as { msgtype?: string; body?: unknown };
    if (!c.msgtype || !TEXT_TYPES.has(c.msgtype) || typeof c.body !== "string" || !c.body.trim()) continue;
    const sender = ev.getSender() ?? "";
    out.push({
      eventId: id,
      senderId: sender,
      sender: room.getMember(sender)?.name ?? sender,
      ts: ev.getTs(),
      text: (ev.replyEventId ? stripReplyFallback(c.body) : c.body).trim(),
    });
  }
  return out.slice(-limit);
}

function Picker({ room, links, onDone }: { room: Room; links: RoomLink[]; onDone: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const client = useClient();
  const v1 = useEmitterVersion(room, ROOM_EVENTS, 100);
  const v2 = useEmitterVersion(client, CLIENT_EVENTS, 100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => textMessages(room), [room, v1, v2]);
  const targets = links
    .map((l) => (l.contact ? { type: "contact" as const, id: l.contact.id, label: l.contact.display_name } : l.opportunity ? { type: "opportunity" as const, id: l.opportunity.id, label: l.opportunity.name } : null))
    .filter((t): t is { type: "contact" | "opportunity"; id: string; label: string } => !!t);
  const [target, setTarget] = useState(targets[0] ? `${targets[0].type}:${targets[0].id}` : "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const selected = messages.filter((m) => picked.has(m.eventId));
  const problem = selectionProblem(selected);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const save = async () => {
    const [type, id] = target.split(":") as ["contact" | "opportunity", string];
    setBusy(true);
    try {
      await ws.api.post(`${assistantBase(ws.workspace!.id)}/save-to-record`, buildSavePayload(room.roomId, { type, id }, selected));
      ui.toast({ kind: "success", title: "Saved to the record", body: `${selected.length} message${selected.length === 1 ? "" : "s"} added as a note.` });
      onDone();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save to the record", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-save" role="group" aria-label="Save messages to a record">
      <div className="alert alert-warning">
        <Lock aria-hidden="true" />
        <p>
          The copy you save is stored in the workspace and is <strong>no longer end-to-end encrypted</strong>. Anyone who can see the record can read
          it. The conversation itself stays encrypted.
        </p>
      </div>
      {targets.length > 1 ? (
        <div className="field">
          <label htmlFor="ai-save-target">Save to</label>
          <select id="ai-save-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      ) : targets[0] ? (
        <p className="small">
          Save to <strong>{targets[0].label}</strong>
        </p>
      ) : null}
      {messages.length === 0 ? (
        <p className="muted small">No readable text messages are loaded in this conversation yet. Scroll up in the conversation to load older ones.</p>
      ) : (
        <ul className="ai-save-list" aria-label="Messages">
          {messages.map((m) => (
            <li key={m.eventId}>
              <label className="checkbox">
                <input type="checkbox" checked={picked.has(m.eventId)} onChange={() => toggle(m.eventId)} />
                <span>
                  <span className="xsmall subtle">
                    {m.sender} · {formatWhen(new Date(m.ts).toISOString())}
                  </span>
                  <span className="ai-save-text">{m.text.length > 300 ? `${m.text.slice(0, 299)}…` : m.text}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="cluster">
        <button type="button" className="btn btn-sm btn-primary" disabled={!!problem || busy || !target} onClick={() => void save()}>
          {busy ? <Spinner size="sm" /> : <Save aria-hidden="true" />} Save {selected.length || ""} as a note
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone} disabled={busy}>
          <X aria-hidden="true" /> Cancel
        </button>
        {selected.length && problem ? <span className="xsmall subtle">{problem}</span> : null}
      </div>
    </div>
  );
}

export function SaveToRecordSection({ roomId, links }: { roomId: string; links: RoomLink[] }) {
  const ws = useWorkspace();
  const client = useClient();
  const [open, setOpen] = useState(false);
  if (!links.length) return null;
  if (!ws.hasFeature("save_to_record")) {
    return (
      <p className="xsmall subtle ai-save-off">
        <MessageSquareQuote aria-hidden="true" className="inline-icon" /> “Save to record” is off for this workspace. When an owner or admin turns it
        on, you can copy selected messages into a note; that copy is no longer end-to-end encrypted.
      </p>
    );
  }
  if (!ws.can("activities.create")) return null;
  const room = client.getRoom(roomId);
  return open && room ? (
    <Picker room={room} links={links} onDone={() => setOpen(false)} />
  ) : (
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)} disabled={!room}>
      <MessageSquareQuote aria-hidden="true" /> Save messages to the record
    </button>
  );
}
