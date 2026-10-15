import { useEffect, useState } from "react";
import { EventType, KnownMembership, RoomStateEvent, type RoomMember } from "matrix-js-sdk";
import { Ban, BadgeCheck, DoorOpen, Lock, ShieldAlert, ShieldOff, UserPlus, X } from "lucide-react";
import { useMatrix } from "../matrix/context";
import { dmPartner, MEGOLM_ALGORITHM } from "../matrix/rooms";
import { canBlock, unblockUser } from "../matrix/block";
import { useBlockedUsers, usePresence, useRoom, useRoomEncrypted, useUserTrust } from "../hooks/matrix";
import { useEmitterVersion } from "../hooks/useEmitter";
import { errorMessage } from "../lib/errors";
import { Avatar } from "./primitives/Avatar";
import { Dialog } from "./primitives/Dialog";
import { BlockUserDialog } from "./dialogs/BlockUserDialog";
import { Spinner } from "./primitives/Spinner";
import { presenceDot } from "./Sidebar";
import { useUi } from "./UiContext";

function MemberRow({ member, isMe, blocked }: { member: RoomMember; isMe: boolean; blocked: boolean }) {
  const { client } = useMatrix();
  const ui = useUi();
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [unblocking, setUnblocking] = useState(false);
  const presence = usePresence(client, member.userId);
  const { status } = useUserTrust(client, isMe ? null : member.userId);
  let badge = null;
  if (isMe) {
    badge = ui.security.thisDeviceVerified ? (
      <span className="badge badge-success badge-plain">
        <BadgeCheck aria-hidden="true" /> You
      </span>
    ) : (
      <span className="badge badge-plain">You</span>
    );
  } else if (status?.isCrossSigningVerified()) {
    badge = (
      <span className="badge badge-success badge-plain">
        <BadgeCheck aria-hidden="true" /> Verified
      </span>
    );
  } else if (status && (status.needsUserApproval || status.wasCrossSigningVerified())) {
    badge = (
      <span className="badge badge-danger badge-plain">
        <ShieldAlert aria-hidden="true" /> Identity changed
      </span>
    );
  } else if (status) {
    badge = <span className="badge badge-plain">Not verified</span>;
  }
  if (blocked) {
    badge = (
      <span className="badge badge-danger badge-plain">
        <Ban aria-hidden="true" /> Blocked
      </span>
    );
  }
  const canVerify = !isMe && !!status && !status.isCrossSigningVerified() && member.membership === KnownMembership.Join;
  return (
    <li className="member-row">
      <Avatar name={member.name} seed={member.userId} mxc={member.getMxcAvatarUrl()} size={36} presence={presenceDot(presence)} />
      <div className="member-main">
        <span className="member-name">{member.name}</span>
        <span className="member-id">
          {member.userId}
          {member.membership === KnownMembership.Invite ? " · invited" : ""}
        </span>
        <span className="member-badges">{badge}</span>
      </div>
      <div className="member-actions">
        {canVerify && !blocked ? (
          <button type="button" className="btn btn-sm" onClick={() => void ui.verifyUser(member.userId)}>
            Verify
          </button>
        ) : null}
        {blocked ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={unblocking}
            onClick={async () => {
              setUnblocking(true);
              try {
                await unblockUser(client, member.userId);
              } catch (e) {
                ui.toast({ kind: "error", title: "Couldn't unblock", body: errorMessage(e) });
              } finally {
                setUnblocking(false);
              }
            }}
          >
            {unblocking ? <Spinner size="sm" /> : null} Unblock
          </button>
        ) : !isMe && canBlock(client, member.userId) ? (
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`Block ${member.name}`} onClick={() => setConfirmBlock(true)}>
            <Ban aria-hidden="true" /> Block
          </button>
        ) : null}
      </div>
      {confirmBlock ? <BlockUserDialog userId={member.userId} name={member.name} onClose={() => setConfirmBlock(false)} /> : null}
    </li>
  );
}

export function RoomInfoPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { client, userId } = useMatrix();
  const ui = useUi();
  const room = useRoom(client, roomId);
  useEmitterVersion(room, [RoomStateEvent.Members, RoomStateEvent.Events]);
  const encrypted = useRoomEncrypted(client, room);
  const [confirmEnc, setConfirmEnc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const blockedUsers = useBlockedUsers(client);
  useEffect(() => {
    if (!room || room.membersLoaded()) return;
    setLoadingMembers(true);
    void room.loadMembersIfNeeded().finally(() => setLoadingMembers(false));
  }, [room]);
  if (!room) return null;
  const dm = dmPartner(client, room);
  const members = [...room.getMembersWithMembership(KnownMembership.Join), ...room.getMembersWithMembership(KnownMembership.Invite)].sort((a, b) =>
    a.userId === userId ? -1 : b.userId === userId ? 1 : a.name.localeCompare(b.name),
  );
  const topic = room.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent()?.topic as string | undefined;
  const canEnableEncryption = !encrypted && room.currentState.maySendStateEvent(EventType.RoomEncryption, userId);

  return (
    <div className="panel">
      <header className="panel-header">
        <h2>Details</h2>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="panel-body">
        <div className="panel-hero">
          <Avatar name={room.name} seed={dm ?? room.roomId} mxc={room.getMxcAvatarUrl() ?? (dm ? room.getMember(dm)?.getMxcAvatarUrl() : null)} size={72} />
          <h3>{room.name}</h3>
          {topic ? <p className="muted small">{topic}</p> : null}
        </div>
        <section className={`enc-card ${encrypted ? "ok" : encrypted === false ? "warn" : ""}`} aria-label="Encryption">
          {encrypted ? <Lock aria-hidden="true" /> : <ShieldOff aria-hidden="true" />}
          <div>
            <p className="enc-title">{encrypted ? "End-to-end encrypted" : encrypted === false ? "Not encrypted" : "Checking encryption…"}</p>
            <p className="small muted">
              {encrypted
                ? "Messages and files are encrypted on each device. Only the devices of the people here can read them — not the server."
                : encrypted === false
                  ? "The server can read messages and files in this conversation."
                  : ""}
            </p>
            {canEnableEncryption ? (
              <button type="button" className="btn btn-sm" onClick={() => setConfirmEnc(true)}>
                <Lock aria-hidden="true" /> Enable encryption
              </button>
            ) : null}
          </div>
        </section>
        <section aria-label="Members" className="members">
          <div className="members-head">
            <h3>
              Members <span className="count">{members.length}</span>
            </h3>
            {room.canInvite(userId) ? (
              <button type="button" className="btn btn-sm" onClick={() => ui.openDialog({ type: "invite", roomId })}>
                <UserPlus aria-hidden="true" /> Invite
              </button>
            ) : null}
          </div>
          {loadingMembers ? <Spinner size="sm" label="Loading members…" /> : null}
          <ul className="list-plain member-list">
            {members.map((m) => (
              <MemberRow key={m.userId} member={m} isMe={m.userId === userId} blocked={blockedUsers.includes(m.userId)} />
            ))}
          </ul>
        </section>
        <button type="button" className="btn btn-outline-danger btn-block" onClick={() => ui.openDialog({ type: "leave-room", roomId })}>
          <DoorOpen aria-hidden="true" /> Leave conversation
        </button>
      </div>
      {confirmEnc ? (
        <Dialog title="Enable encryption?" size="sm" onClose={() => setConfirmEnc(false)} dismissible={!busy}>
          <p className="muted">
            Once enabled, encryption can't be turned off for this conversation. Earlier messages stay unencrypted.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmEnc(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await client.sendStateEvent(roomId, EventType.RoomEncryption, { algorithm: MEGOLM_ALGORITHM } as never, "");
                  setConfirmEnc(false);
                } catch (e) {
                  ui.toast({ kind: "error", title: "Couldn't enable encryption", body: errorMessage(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner size="sm" /> : <Lock aria-hidden="true" />} Enable encryption
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
