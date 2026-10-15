import { useCallback, useRef, useState } from "react";
import { KnownMembership, type MatrixEvent, type Room } from "matrix-js-sdk";
import { Check, DoorOpen, FileUp, X } from "lucide-react";
import { useMatrix } from "../matrix/context";
import { acceptInvite, declineInvite, dmPartner, isMessageEvent } from "../matrix/rooms";
import { useDirectVersion, useRoom, useRoomEncrypted, useSyncState } from "../hooks/matrix";
import { navigate } from "../hooks/useRoute";
import { errorMessage } from "../lib/errors";
import { Avatar } from "./primitives/Avatar";
import { Spinner } from "./primitives/Spinner";
import { useUi } from "./UiContext";
import { RoomHeader } from "./room/RoomHeader";
import { IdentityWarnings } from "./room/IdentityWarnings";
import { Timeline } from "./room/Timeline";
import { TypingIndicator } from "./room/TypingIndicator";
import { Composer, type ComposerHandle } from "./room/Composer";

function InvitePreview({ room }: { room: Room }) {
  const { client, userId } = useMatrix();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const inviter = room.getMember(userId)?.events.member?.getSender();
  const inviterName = inviter ? (room.getMember(inviter)?.name ?? inviter) : "Someone";
  return (
    <div className="empty-pane">
      <div className="empty-card">
        <Avatar name={room.name} seed={room.roomId} mxc={room.getMxcAvatarUrl()} size={64} />
        <h1>{room.name}</h1>
        <p className="muted">{inviterName} invited you to this conversation.</p>
        <div className="cluster center-cluster">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await acceptInvite(client, room);
              } catch (e) {
                ui.toast({ kind: "error", title: "Couldn't join", body: errorMessage(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size="sm" /> : <Check aria-hidden="true" />} Accept
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await declineInvite(client, room);
                navigate("#/");
              } catch (e) {
                ui.toast({ kind: "error", title: "Couldn't decline", body: errorMessage(e) });
                setBusy(false);
              }
            }}
          >
            <X aria-hidden="true" /> Decline
          </button>
        </div>
      </div>
    </div>
  );
}

function JoinedRoom({ room, isMobile, panel }: { room: Room; isMobile: boolean; panel: "info" | "search" | "calls" | null }) {
  const { client, userId, config } = useMatrix();
  useDirectVersion(client);
  const encrypted = useRoomEncrypted(client, room);
  const [replyTo, setReplyTo] = useState<MatrixEvent | null>(null);
  const [editing, setEditing] = useState<MatrixEvent | null>(null);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const dmUserId = dmPartner(client, room);

  const onReply = useCallback((ev: MatrixEvent) => {
    setEditing(null);
    setReplyTo(ev);
  }, []);
  const onEdit = useCallback((ev: MatrixEvent) => {
    setReplyTo(null);
    setEditing(ev);
  }, []);
  const onEditLast = useCallback(() => {
    const evs = room.getLiveTimeline().getEvents();
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.getSender() !== userId || !isMessageEvent(ev) || ev.isRedacted() || ev.status !== null) continue;
      const mt = (ev.getContent() as { msgtype?: string }).msgtype;
      if (mt === "m.text" || mt === "m.emote") {
        setReplyTo(null);
        setEditing(ev);
      }
      return;
    }
  }, [room, userId]);

  return (
    <section
      className={`room${dragging ? " dragging" : ""}`}
      aria-label={room.name}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          composer.current?.attach(e.dataTransfer.files);
        }
        setDragging(false);
      }}
    >
      <RoomHeader
        room={room}
        dmUserId={dmUserId}
        encrypted={encrypted}
        isMobile={isMobile}
        panel={panel}
        callsEnabled={config.calls.enabled}
      />
      <IdentityWarnings room={room} encrypted={encrypted} />
      <Timeline room={room} roomEncrypted={encrypted} onReply={onReply} onEdit={onEdit} />
      <TypingIndicator room={room} />
      <Composer
        ref={composer}
        room={room}
        encrypted={encrypted}
        replyTo={replyTo}
        editing={editing}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onEditLast={onEditLast}
      />
      {dragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <FileUp />
          <p>Drop files to send{encrypted ? " — they'll be encrypted first" : ""}</p>
        </div>
      ) : null}
    </section>
  );
}

export function RoomView({ roomId, isMobile, panel }: { roomId: string; isMobile: boolean; panel: "info" | "search" | "calls" | null }) {
  const { client } = useMatrix();
  const room = useRoom(client, roomId);
  const { state } = useSyncState(client);
  if (!room) {
    return (
      <div className="empty-pane">
        <div className="empty-card">
          {state === null ? (
            <Spinner label="Loading conversation…" />
          ) : (
            <>
              <DoorOpen aria-hidden="true" className="empty-icon" />
              <h1>Conversation not available</h1>
              <p className="muted">You're not a member of this conversation, or it doesn't exist.</p>
              <a className="btn" href="#/">
                Back to conversations
              </a>
            </>
          )}
        </div>
      </div>
    );
  }
  const membership = room.getMyMembership();
  if (membership === KnownMembership.Invite) return <InvitePreview room={room} />;
  if (membership !== KnownMembership.Join) {
    return (
      <div className="empty-pane">
        <div className="empty-card">
          <DoorOpen aria-hidden="true" className="empty-icon" />
          <h1>{room.name}</h1>
          <p className="muted">{membership === KnownMembership.Ban ? "You were banned from this conversation." : "You're no longer in this conversation."}</p>
          <a className="btn" href="#/">
            Back to conversations
          </a>
        </div>
      </div>
    );
  }
  return <JoinedRoom room={room} isMobile={isMobile} panel={panel} />;
}
