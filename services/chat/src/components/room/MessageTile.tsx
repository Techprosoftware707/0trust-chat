import { memo, useEffect, useState } from "react";
import {
  EventStatus,
  EventType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import {
  Check,
  CheckCheck,
  Clock,
  Hourglass,
  LockKeyhole,
  Pencil,
  Reply,
  RotateCcw,
  ShieldAlert,
  SmilePlus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useClient } from "../../matrix/context";
import { formatFullDate, formatTime } from "../../lib/format";
import { stripReplyFallback } from "../../lib/markdown";
import { previewText } from "../../matrix/rooms";
import { QUICK_REACTIONS, reactionContent } from "../../matrix/send";
import { errorMessage } from "../../lib/errors";
import { Avatar } from "../primitives/Avatar";
import { Dialog } from "../primitives/Dialog";
import { useUi } from "../UiContext";
import { Attachment } from "./Attachment";
import { EncryptionShield, isPendingLocal } from "./EncryptionShield";
import { MessageBody } from "./MessageBody";

/**
 * Why a message can't be shown, in calm words: whether its key may still arrive, isn't
 * available on this device, or was held back on purpose — and what helps, if anything.
 */
type UtdKind = "waiting" | "unavailable" | "blocked";
const UTD: Partial<Record<DecryptionFailureCode, { kind: UtdKind; hint: string; verify?: boolean }>> = {
  [DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID]: {
    kind: "waiting",
    hint: "The sender's device hasn't shared the key with this device yet. It usually arrives shortly.",
  },
  [DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX]: { kind: "unavailable", hint: "This device only has the key for later messages in this conversation." },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP]: {
    kind: "unavailable",
    hint: "It was sent before this device signed in, and there's no key backup to restore it from.",
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED]: {
    kind: "unavailable",
    hint: "It was sent before this device signed in. Verify this device to restore it from your key backup.",
    verify: true,
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP]: { kind: "unavailable", hint: "Your key backup doesn't include the key for this message." },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED]: { kind: "unavailable", hint: "It was sent before you joined, so its key was never shared with you." },
  [DecryptionFailureCode.MEGOLM_KEY_WITHHELD]: { kind: "unavailable", hint: "The sender's device chose not to share the key for this message with you." },
  [DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE]: {
    kind: "unavailable",
    hint: "The sender only shares keys with verified devices. Verify this device to read new messages.",
    verify: true,
  },
  [DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED]: { kind: "blocked", hint: "Not shown because the sender's verified identity has changed." },
  [DecryptionFailureCode.UNSIGNED_SENDER_DEVICE]: { kind: "blocked", hint: "Not shown because it was sent from a device its owner hasn't verified." },
  [DecryptionFailureCode.UNKNOWN_SENDER_DEVICE]: { kind: "blocked", hint: "Not shown because it was sent from an unknown device." },
};
const UTD_TITLE: Record<UtdKind, string> = {
  waiting: "Waiting for this message's key",
  unavailable: "This message can't be read on this device",
  blocked: "Message not shown",
};

function UndecryptableMessage({ reason }: { reason: DecryptionFailureCode | null }) {
  const ui = useUi();
  const info = (reason && UTD[reason]) || { kind: "waiting" as const, hint: "The key for this message hasn't reached this device yet." };
  const unverified = !ui.security.loading && !ui.security.thisDeviceVerified && ui.security.crossSigningExists;
  // Verifying helps whenever this device isn't trusted yet: it can then get keys from your
  // other devices and from your key backup.
  const offerVerify = unverified && (info.verify || info.kind === "waiting");
  return (
    <div className={`msg-utd utd-${info.kind}`}>
      {info.kind === "waiting" ? <Hourglass aria-hidden="true" /> : info.kind === "blocked" ? <ShieldAlert aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
      <div>
        <p className="msg-utd-title">{UTD_TITLE[info.kind]}</p>
        <p className="msg-utd-hint">
          {info.hint}
          {info.kind === "waiting" && !offerVerify ? " Keeping another of your signed-in devices open can help." : ""}
        </p>
        {offerVerify ? (
          <button type="button" className="link-button msg-utd-action" onClick={() => ui.openDialog({ type: "verify-device" })}>
            Verify this device
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface TileProps {
  event: MatrixEvent;
  room: Room;
  continuation: boolean;
  isOwn: boolean;
  readers: string[];
  roomEncrypted: boolean | null;
  version: number;
  /** arrived or sent while the conversation is open: animate its entrance once */
  fresh?: boolean;
  onReply: (ev: MatrixEvent) => void;
  onEdit: (ev: MatrixEvent) => void;
}

function senderName(room: Room, userId: string | undefined): string {
  if (!userId) return "Unknown";
  return room.getMember(userId)?.name ?? userId;
}

function ReplyQuote({ room, eventId }: { room: Room; eventId: string }) {
  const client = useClient();
  const [ev, setEv] = useState<MatrixEvent | null>(() => room.findEventById(eventId) ?? null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    if (ev) return;
    void fetchEvent(client, room, eventId)
      .then((e) => alive && (e ? setEv(e) : setMissing(true)))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [client, room, eventId, ev]);
  const jump = () => {
    const el = document.getElementById(`ev-${eventId}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    }
  };
  return (
    <button type="button" className="reply-quote" onClick={jump}>
      <span className="reply-quote-sender">{ev ? senderName(room, ev.getSender()) : "Reply"}</span>
      <span className="reply-quote-text">
        {ev ? previewText(ev, "") || "Message" : missing ? "Original message not available" : "Loading…"}
      </span>
    </button>
  );
}

async function fetchEvent(client: MatrixClient, room: Room, eventId: string): Promise<MatrixEvent | null> {
  const raw = await client.fetchRoomEvent(room.roomId, eventId);
  const ev = client.getEventMapper()(raw);
  await client.decryptEventIfNeeded(ev);
  return ev;
}

function Reactions({ event, room, isOwnUser }: { event: MatrixEvent; room: Room; isOwnUser: string }) {
  const client = useClient();
  const ui = useUi();
  const id = event.getId();
  if (!id) return null;
  const relations = room.relations.getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction);
  const groups = relations?.getSortedAnnotationsByKey() ?? [];
  if (!groups.length) return null;
  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {groups.map(([key, events]) => {
        const list = [...events].filter((e) => !e.isRedacted());
        if (!list.length) return null;
        const mine = list.find((e) => e.getSender() === isOwnUser);
        const names = list.map((e) => senderName(room, e.getSender())).join(", ");
        return (
          <button
            key={key}
            type="button"
            className={`reaction${mine ? " mine" : ""}`}
            aria-pressed={!!mine}
            title={`${names} reacted with ${key}`}
            aria-label={`${key} ${list.length}, ${mine ? "remove your reaction" : "react"}`}
            onClick={async () => {
              try {
                if (mine?.getId() && !mine.status) await client.redactEvent(room.roomId, mine.getId()!);
                else if (!mine) await client.sendEvent(room.roomId, EventType.Reaction, reactionContent(id, key));
              } catch (e) {
                ui.reportError(e, "Couldn't update reaction");
              }
            }}
          >
            <span className="reaction-key">{key}</span>
            <span className="reaction-count">{list.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function DeliveryStatus({ event, readers, room }: { event: MatrixEvent; readers: string[]; room: Room }) {
  if (event.status === EventStatus.NOT_SENT) return null; // shown as a failure row instead
  if (isPendingLocal(event)) {
    return (
      <span className="delivery" title="Sending" role="img" aria-label="Sending">
        <Clock aria-hidden="true" />
      </span>
    );
  }
  if (readers.length > 0) {
    const names = readers.map((u) => senderName(room, u));
    const label = `Seen by ${names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ")}`;
    return (
      <span className="delivery seen" title={label} role="img" aria-label={label}>
        <CheckCheck aria-hidden="true" />
        {room.getJoinedMemberCount() > 2 ? <span className="seen-count">{readers.length}</span> : null}
      </span>
    );
  }
  return (
    <span className="delivery" title="Sent to the server" role="img" aria-label="Sent">
      <Check aria-hidden="true" />
    </span>
  );
}

function MessageContent({ event, room }: { event: MatrixEvent; room: Room }) {
  if (event.isRedacted()) {
    return <p className="msg-deleted">Message deleted</p>;
  }
  if (event.isDecryptionFailure()) return <UndecryptableMessage reason={event.decryptionFailureReason} />;
  if (event.getType() === EventType.RoomMessageEncrypted) {
    return <p className="msg-pending-decrypt">Decrypting…</p>;
  }
  if (event.getType() === EventType.Sticker) return <Attachment event={event} />;
  const c = event.getContent() as { msgtype?: string; body?: unknown };
  const body = typeof c.body === "string" ? c.body : "";
  switch (c.msgtype) {
    case "m.image":
    case "m.file":
    case "m.video":
    case "m.audio":
      return <Attachment event={event} />;
    case "m.emote":
      return <MessageBody body={`* ${senderName(room, event.getSender())} ${body}`} className="msg-body msg-emote" />;
    case "m.notice":
      return <MessageBody body={body} className="msg-body msg-notice" />;
    default:
      return <MessageBody body={event.replyEventId ? stripReplyFallback(body) : body} />;
  }
}

export const MessageTile = memo(function MessageTile({ event, room, continuation, isOwn, readers, roomEncrypted, fresh, onReply, onEdit }: TileProps) {
  const client = useClient();
  const ui = useUi();
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sender = event.getSender() ?? "";
  const member = room.getMember(sender);
  const name = senderName(room, sender);
  const ts = event.getTs();
  const id = event.getId();
  const failed = event.status === EventStatus.NOT_SENT;
  const local = event.status !== null;
  const redacted = event.isRedacted();
  const content = event.getContent() as { msgtype?: string };
  const canEdit = isOwn && !redacted && !local && (content.msgtype === "m.text" || content.msgtype === "m.emote") && !event.isDecryptionFailure();
  const canAct = !redacted && !local && !!id && !event.isDecryptionFailure();
  const edited = !!event.replacingEvent();

  return (
    <article
      id={id ? `ev-${id}` : undefined}
      className={`msg${isOwn ? " own" : ""}${continuation ? " cont" : ""}${failed ? " failed" : ""}${local && !failed ? " pending" : ""}${fresh ? " fresh" : ""}`}
      aria-label={`${isOwn ? "You" : name}, ${formatTime(ts)}`}
      tabIndex={0}
    >
      <div className="msg-gutter">
        {!continuation ? <Avatar name={name} seed={sender} mxc={member?.getMxcAvatarUrl()} size={36} /> : null}
      </div>
      <div className="msg-main">
        {!continuation ? (
          <header className="msg-head">
            <span className="msg-sender">{isOwn ? "You" : name}</span>
            <time dateTime={new Date(ts).toISOString()} title={formatFullDate(ts)}>
              {formatTime(ts)}
            </time>
          </header>
        ) : null}
        <div className="msg-bubble-row">
          <div className="msg-bubble">
            {event.replyEventId && !redacted ? <ReplyQuote room={room} eventId={event.replyEventId} /> : null}
            <MessageContent event={event} room={room} />
            <div className="msg-meta">
              {continuation ? (
                <time className="msg-time-inline" dateTime={new Date(ts).toISOString()} title={formatFullDate(ts)}>
                  {formatTime(ts)}
                </time>
              ) : null}
              {edited && !redacted ? <span className="edited">(edited)</span> : null}
              <EncryptionShield event={event} roomEncrypted={roomEncrypted} />
              {isOwn ? <DeliveryStatus event={event} readers={readers} room={room} /> : null}
            </div>
          </div>
          {canAct ? (
            <div className="msg-actions" role="toolbar" aria-label="Message actions">
              <button type="button" className="icon-btn icon-btn-sm" aria-label="React" title="React" aria-expanded={picker} onClick={() => setPicker((p) => !p)}>
                <SmilePlus aria-hidden="true" />
              </button>
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Reply" title="Reply" onClick={() => onReply(event)}>
                <Reply aria-hidden="true" />
              </button>
              {canEdit ? (
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Edit" title="Edit" onClick={() => onEdit(event)}>
                  <Pencil aria-hidden="true" />
                </button>
              ) : null}
              {isOwn ? (
                <button type="button" className="icon-btn icon-btn-sm danger" aria-label="Delete" title="Delete" onClick={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
              {picker ? (
                <div className="reaction-picker" role="group" aria-label="Pick a reaction">
                  {QUICK_REACTIONS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="reaction-pick"
                      aria-label={`React with ${k}`}
                      onClick={async () => {
                        setPicker(false);
                        const rels = room.relations.getChildEventsForEvent(id!, RelationType.Annotation, EventType.Reaction);
                        const already = rels?.getSortedAnnotationsByKey()?.find(([key]) => key === k)?.[1];
                        if (already && [...already].some((e) => e.getSender() === client.getUserId() && !e.isRedacted())) return;
                        try {
                          await client.sendEvent(room.roomId, EventType.Reaction, reactionContent(id!, k));
                        } catch (e) {
                          ui.reportError(e, "Couldn't react");
                        }
                      }}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {!redacted ? <Reactions event={event} room={room} isOwnUser={client.getUserId() ?? ""} /> : null}
        {failed ? (
          <div className="msg-failed" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span>Not sent.</span>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                client.resendEvent(event, room).catch(() => undefined);
              }}
            >
              <RotateCcw aria-hidden="true" /> Retry
            </button>
            <button type="button" className="link-button" onClick={() => client.cancelPendingEvent(event)}>
              <X aria-hidden="true" /> Cancel
            </button>
          </div>
        ) : null}
      </div>
      {confirmDelete ? (
        <Dialog title="Delete this message?" size="sm" onClose={() => setConfirmDelete(false)}>
          <p className="muted">It will be removed for everyone in the conversation. Other people may already have read it.</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                setConfirmDelete(false);
                try {
                  await client.redactEvent(room.roomId, id!);
                } catch (e) {
                  ui.toast({ kind: "error", title: "Couldn't delete the message", body: errorMessage(e) });
                }
              }}
            >
              <Trash2 aria-hidden="true" /> Delete
            </button>
          </div>
        </Dialog>
      ) : null}
    </article>
  );
});
