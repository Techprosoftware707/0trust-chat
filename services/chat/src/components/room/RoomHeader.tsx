import { ArrowLeft, BadgeCheck, EllipsisVertical, History, Info, Lock, Phone, PhoneCall, Search, ShieldAlert, ShieldOff, Video } from "lucide-react";
import type { Room } from "matrix-js-sdk";
import { useMatrix } from "../../matrix/context";
import { openLobby, setCallView, useActiveCall, useCallSnapshot, useRoomCall } from "../../calls/store";
import { usePresence, useUserTrust } from "../../hooks/matrix";
import { formatRelative } from "../../lib/format";
import { Avatar } from "../primitives/Avatar";
import { Menu, type MenuItem } from "../primitives/Menu";
import { presenceDot } from "../Sidebar";
import { useUi } from "../UiContext";

export function EncryptionBadge({ encrypted }: { encrypted: boolean | null }) {
  if (encrypted === null) return null;
  return encrypted ? (
    <span className="badge badge-success badge-plain" title="Messages are end-to-end encrypted: only members' devices can read them">
      <Lock aria-hidden="true" /> <span className="badge-label">Encrypted</span>
    </span>
  ) : (
    <span className="badge badge-warning badge-plain" title="Messages in this conversation are not end-to-end encrypted">
      <ShieldOff aria-hidden="true" /> <span className="badge-label">Not encrypted</span>
    </span>
  );
}

function presenceText(p: ReturnType<typeof usePresence>): string | null {
  if (!p) return null;
  if (p.presence === "online") return p.currentlyActive ? "Online" : "Online · idle";
  if (p.presence === "unavailable") return "Away";
  return p.lastActiveAgo ? `Last seen ${formatRelative(Date.now() - p.lastActiveAgo)}`.replace("Last seen Just now", "Last seen just now") : "Offline";
}

export function TrustBadge({ userId, onVerify }: { userId: string; onVerify: () => void }) {
  const { client } = useMatrix();
  const { status } = useUserTrust(client, userId);
  if (!status) return null;
  if (status.isCrossSigningVerified())
    return (
      <span className="badge badge-success badge-plain" title="You've verified this person's identity">
        <BadgeCheck aria-hidden="true" /> <span className="badge-label">Verified</span>
      </span>
    );
  if (status.needsUserApproval || status.wasCrossSigningVerified())
    return (
      <button type="button" className="badge badge-danger badge-plain badge-button" onClick={onVerify} title="Their identity changed. Verify them again.">
        <ShieldAlert aria-hidden="true" /> <span className="badge-label">Identity changed</span>
      </button>
    );
  return (
    <button type="button" className="badge badge-plain badge-button" onClick={onVerify} title="Compare emoji to verify this person">
      <ShieldAlert aria-hidden="true" /> <span className="badge-label">Not verified</span>
    </button>
  );
}

/** Start / join / return-to call, with the live participant count from MatrixRTC memberships. */
function CallButtons({ room }: { room: Room }) {
  const { client } = useMatrix();
  const info = useRoomCall(client, room);
  const active = useActiveCall();
  const snap = useCallSnapshot(active);
  const inThisCall = !!active && active.roomId === room.roomId && snap?.phase !== "ended";
  const n = info.userIds.length;
  if (inThisCall) {
    return (
      <button type="button" className="btn btn-sm btn-success call-pill" onClick={() => setCallView("full")} aria-label={`Return to the call (${n} in call)`}>
        <PhoneCall aria-hidden="true" /> In call{n ? ` · ${n}` : ""}
      </button>
    );
  }
  if (n > 0) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-success call-pill"
        onClick={() => openLobby({ roomId: room.roomId, intent: info.intent ?? "audio", joining: true })}
        aria-label={`Join the call (${n} ${n === 1 ? "person" : "people"} in it)`}
      >
        <span className="live-dot" aria-hidden="true" /> Join call · {n}
      </button>
    );
  }
  return (
    <>
      <button type="button" className="icon-btn" aria-label="Voice call" title="Voice call" onClick={() => openLobby({ roomId: room.roomId, intent: "audio", joining: false })}>
        <Phone aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn" aria-label="Video call" title="Video call" onClick={() => openLobby({ roomId: room.roomId, intent: "video", joining: false })}>
        <Video aria-hidden="true" />
      </button>
    </>
  );
}

export function RoomHeader({
  room,
  dmUserId,
  encrypted,
  isMobile,
  panel,
  callsEnabled,
}: {
  room: Room;
  dmUserId: string | null;
  encrypted: boolean | null;
  isMobile: boolean;
  panel: "info" | "search" | "calls" | null;
  callsEnabled: boolean;
}) {
  const { client } = useMatrix();
  const ui = useUi();
  const presence = usePresence(client, dmUserId);
  const members = room.getJoinedMemberCount();
  const sub = dmUserId ? (presenceText(presence) ?? dmUserId) : `${members} member${members === 1 ? "" : "s"}`;
  const mxc = room.getMxcAvatarUrl() ?? (dmUserId ? room.getMember(dmUserId)?.getMxcAvatarUrl() : null) ?? null;
  const toggle = (p: "info" | "search" | "calls") => ui.openPanel(panel === p ? null : p);
  // In a narrow header (phones, tablets in portrait, a panel open on a small laptop) these move
  // into a "More" menu so the conversation name keeps its room (CSS container query).
  const more: MenuItem[] = [
    { label: "Search messages", icon: <Search aria-hidden="true" />, onSelect: () => toggle("search") },
    ...(callsEnabled ? [{ label: "Call history", icon: <History aria-hidden="true" />, onSelect: () => toggle("calls") }] : []),
    { label: "Conversation details", icon: <Info aria-hidden="true" />, onSelect: () => toggle("info") },
  ];
  return (
    <header className="room-header">
      {isMobile ? (
        <a href="#/" className="icon-btn" aria-label="Back to conversations">
          <ArrowLeft aria-hidden="true" />
        </a>
      ) : null}
      <Avatar name={room.name} seed={dmUserId ?? room.roomId} mxc={mxc} size={40} presence={dmUserId ? presenceDot(presence) : null} />
      <div className="room-header-titles">
        <h1 className="room-title" title={room.name}>
          {room.name}
        </h1>
        <div className="room-sub">
          <span className="room-sub-text">{sub}</span>
          <span className="room-header-badges">
            <EncryptionBadge encrypted={encrypted} />
            {dmUserId ? <TrustBadge userId={dmUserId} onVerify={() => void ui.verifyUser(dmUserId)} /> : null}
          </span>
        </div>
      </div>
      <div className="room-header-actions">
        {callsEnabled ? <CallButtons room={room} /> : null}
        {callsEnabled ? (
          <button
            type="button"
            className="icon-btn wide-only"
            aria-label="Call history"
            title="Call history"
            aria-pressed={panel === "calls"}
            onClick={() => toggle("calls")}
          >
            <History aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn wide-only"
          aria-label="Search messages"
          title="Search messages"
          aria-pressed={panel === "search"}
          onClick={() => toggle("search")}
        >
          <Search aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn wide-only"
          aria-label="Conversation details"
          title="Conversation details"
          aria-pressed={panel === "info"}
          onClick={() => toggle("info")}
        >
          <Info aria-hidden="true" />
        </button>
        <div className="narrow-only">
          <Menu label="More options" icon={<EllipsisVertical aria-hidden="true" />} items={more} />
        </div>
      </div>
    </header>
  );
}
