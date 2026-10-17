import { useId, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  KeyRound,
  LockKeyhole,
  LogOut,
  PhoneCall,
  PhoneMissed,
  MessageSquarePlus,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useClient, useMatrix } from "../matrix/context";
import { acceptInvite, declineInvite, type RoomSummary } from "../matrix/rooms";
import { formatListTimestamp } from "../lib/format";
import { roomHash } from "../lib/matrix-id";
import { usePresence, useUserProfile } from "../hooks/matrix";
import { useRoomCall } from "../calls/store";
import { navigate } from "../hooks/useRoute";
import { errorMessage } from "../lib/errors";
import { Avatar, type PresenceDot } from "./primitives/Avatar";
import { Menu } from "./primitives/Menu";
import { Spinner } from "./primitives/Spinner";
import { BrandLogo } from "./BrandLogo";
import { useUi } from "./UiContext";

type Filter = "all" | "unread" | "dm" | "group";

export function presenceDot(p: { presence: string; currentlyActive: boolean } | null): PresenceDot {
  if (!p) return null;
  if (p.presence === "online") return "online";
  if (p.presence === "unavailable") return "unavailable";
  return "offline";
}

function RoomAvatar({ s, size = 44 }: { s: RoomSummary; size?: number }) {
  const client = useClient();
  const presence = usePresence(client, s.dmUserId);
  const mxc = s.room.getMxcAvatarUrl() ?? (s.isDm ? s.room.getAvatarFallbackMember()?.getMxcAvatarUrl() : null) ?? null;
  return <Avatar name={s.name} seed={s.dmUserId ?? s.roomId} mxc={mxc} size={size} presence={s.isDm ? presenceDot(presence) : null} />;
}

function RoomListItem({ s, active }: { s: RoomSummary; active: boolean }) {
  const { config } = useMatrix();
  const client = useClient();
  const callInfo = useRoomCall(client, config.calls.enabled ? s.room : null);
  const callLabel = callInfo.userIds.length ? `, call in progress with ${callInfo.userIds.length} ${callInfo.userIds.length === 1 ? "person" : "people"}` : "";
  const missedLabel = s.missedCall ? ", missed call" : "";
  const unreadLabel = `${s.unread > 0 ? `, ${s.unread} unread${s.highlight > 0 ? ", mentions you" : ""}` : ""}${callLabel}${missedLabel}`;
  return (
    <li>
      <a
        href={roomHash(s.roomId)}
        className={`room-item${active ? " active" : ""}${s.unread > 0 ? " has-unread" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={`${s.name}${unreadLabel}`}
      >
        <RoomAvatar s={s} />
        <span className="room-item-main">
          <span className="room-item-top">
            <span className="room-name">{s.name}</span>
            {callInfo.userIds.length ? (
              <span className="room-call-badge" aria-hidden="true" title={`${callInfo.userIds.length} in a call${callInfo.joinedHere ? " (including you)" : ""}`}>
                <PhoneCall /> {callInfo.userIds.length}
              </span>
            ) : null}
            {s.lastTs ? <time dateTime={new Date(s.lastTs).toISOString()}>{formatListTimestamp(s.lastTs)}</time> : null}
          </span>
          <span className="room-item-bottom">
            {s.missedCall ? (
              <span className="room-preview missed-call">
                <PhoneMissed aria-hidden="true" /> Missed {s.missedCall.video ? "video call" : "call"}
              </span>
            ) : (
              <span className={`room-preview${s.previewEncrypted ? " encrypted" : ""}`}>
                {s.previewEncrypted ? <LockKeyhole aria-hidden="true" /> : null}
                {s.preview || (s.isDm ? "Direct message" : "Group")}
              </span>
            )}
            {s.unread > 0 ? (
              <span className={`unread-badge${s.highlight > 0 ? " highlight" : ""}`} aria-hidden="true">
                {s.unread > 99 ? "99+" : s.unread}
              </span>
            ) : null}
          </span>
        </span>
      </a>
    </li>
  );
}

function InviteItem({ s }: { s: RoomSummary }) {
  const client = useClient();
  const ui = useUi();
  const [busy, setBusy] = useState<null | "accept" | "decline">(null);
  const inviter = s.inviter ? (s.room.getMember(s.inviter)?.name ?? s.inviter) : null;
  return (
    <li className="invite-item">
      <RoomAvatar s={s} size={40} />
      <div className="invite-main">
        <span className="room-name">{s.name}</span>
        <span className="room-preview">{inviter ? `${s.isDm ? "Direct message from" : "Invited by"} ${inviter}` : "Invitation"}</span>
        <div className="invite-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("accept");
              try {
                await acceptInvite(client, s.room);
                navigate(roomHash(s.roomId));
              } catch (e) {
                ui.toast({ kind: "error", title: "Couldn't join", body: errorMessage(e) });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "accept" ? <Spinner size="sm" /> : <Check aria-hidden="true" />} Accept
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("decline");
              try {
                await declineInvite(client, s.room);
              } catch (e) {
                ui.toast({ kind: "error", title: "Couldn't decline", body: errorMessage(e) });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "decline" ? <Spinner size="sm" /> : <X aria-hidden="true" />} Decline
          </button>
        </div>
      </div>
    </li>
  );
}

function SecurityNudge() {
  const ui = useUi();
  const { next, loading } = ui.security;
  if (loading || next === "ok" || next === "unknown") return null;
  // Setting up a backup is a good next step, not an emergency: a calm card with a clear action.
  // An unverified device can't read earlier messages yet, so that one is a (gentle) warning.
  const text =
    next === "setup"
      ? { tone: "info", icon: <KeyRound aria-hidden="true" />, title: "Set up secure backup", body: "Keep your messages safe with a recovery key.", action: () => ui.openDialog({ type: "setup-recovery", mode: "setup" }) }
      : next === "verify"
        ? { tone: "warn", icon: <ShieldAlert aria-hidden="true" />, title: "Verify this device", body: "Confirm it's you to read your earlier messages.", action: () => ui.openDialog({ type: "verify-device" }) }
        : { tone: "info", icon: <KeyRound aria-hidden="true" />, title: "Finish secure backup", body: "Your message keys aren't backed up yet.", action: () => ui.openDialog({ type: "settings", tab: "security" }) };
  return (
    <button type="button" className={`security-nudge ${text.tone}`} onClick={text.action}>
      <span className="security-nudge-icon">{text.icon}</span>
      <span className="security-nudge-text">
        <strong>{text.title}</strong>
        <span>{text.body}</span>
      </span>
      <ChevronRight aria-hidden="true" className="security-nudge-go" />
    </button>
  );
}

function UserChip({ onSignOut }: { onSignOut: () => void }) {
  const { client, userId } = useMatrix();
  const ui = useUi();
  const { displayName, avatarMxc } = useUserProfile(client, userId);
  const verified = ui.security.thisDeviceVerified;
  return (
    <div className="user-chip">
      <button type="button" className="user-chip-main" onClick={() => ui.openDialog({ type: "settings", tab: "profile" })}>
        <Avatar name={displayName} seed={userId} mxc={avatarMxc} size={36} />
        <span className="user-chip-text">
          <span className="user-chip-name">{displayName}</span>
          <span className="user-chip-id">{userId}</span>
        </span>
      </button>
      <span
        className={`device-state ${verified ? "ok" : "warn"}`}
        title={verified ? "This device is verified" : "This device is not verified"}
        role="img"
        aria-label={verified ? "This device is verified" : "This device is not verified"}
      >
        {verified ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
      </span>
      <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
        <LogOut aria-hidden="true" />
      </button>
    </div>
  );
}

export function Sidebar({ summaries, activeRoomId, onSignOut }: { summaries: RoomSummary[]; activeRoomId: string | null; onSignOut: () => void }) {
  const { config } = useMatrix();
  const ui = useUi();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const filterId = useId();
  const invitesId = useId();

  const invites = summaries.filter((s) => s.membership === "invite");
  const joined = useMemo(() => {
    const q = query.trim().toLowerCase();
    return summaries.filter((s) => {
      if (s.membership !== "join") return false;
      if (filter === "unread" && s.unread === 0) return false;
      if (filter === "dm" && !s.isDm) return false;
      if (filter === "group" && s.isDm) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.dmUserId ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [summaries, query, filter]);
  const totalJoined = summaries.filter((s) => s.membership === "join").length;

  return (
    <aside className="sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <a className="brand" href="#/" aria-label={`${config.brand.name} home`}>
          <BrandLogo size={30} />
          <span>{config.brand.shortName}</span>
        </a>
        <div className="sidebar-actions">
          <button type="button" className="icon-btn" aria-label="Search messages" title="Search messages" onClick={() => ui.openPanel("search")}>
            <Search aria-hidden="true" />
          </button>
          <Menu
            label="Start a conversation"
            icon={<Plus aria-hidden="true" />}
            items={[
              { label: "New direct message", icon: <UserRound aria-hidden="true" />, onSelect: () => ui.openDialog({ type: "new-dm" }) },
              { label: "New group", icon: <Users aria-hidden="true" />, onSelect: () => ui.openDialog({ type: "new-group" }) },
            ]}
          />
          <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={() => ui.openDialog({ type: "settings" })}>
            <Settings aria-hidden="true" />
          </button>
        </div>
      </header>
      <SecurityNudge />
      <div className="room-filter">
        <label htmlFor={filterId} className="visually-hidden">
          Filter conversations
        </label>
        <Search aria-hidden="true" />
        <input id={filterId} type="search" placeholder="Filter conversations" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      </div>
      <div className="chips" role="group" aria-label="Show">
        {(
          [
            ["all", "All"],
            ["unread", "Unread"],
            ["dm", "Direct"],
            ["group", "Groups"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <nav className="room-list-scroll" aria-label="Conversation list">
        {invites.length > 0 ? (
          <section aria-labelledby={invitesId} className="invites">
            <h2 id={invitesId} className="list-heading">
              Invitations <span className="count">{invites.length}</span>
            </h2>
            <ul className="list-plain">
              {invites.map((s) => (
                <InviteItem key={s.roomId} s={s} />
              ))}
            </ul>
          </section>
        ) : null}
        {totalJoined === 0 ? (
          invites.length ? null : (
            <div className="list-empty">
              <span className="empty-art" aria-hidden="true">
                <MessageSquarePlus />
              </span>
              <p className="list-empty-title">No conversations yet</p>
              <p>Say hello to someone — every new conversation is end-to-end encrypted.</p>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => ui.openDialog({ type: "new-dm" })}>
                New message
              </button>
            </div>
          )
        ) : joined.length === 0 ? (
          <div className="list-empty">
            <span className="empty-art" aria-hidden="true">
              <Search />
            </span>
            <p className="list-empty-title">Nothing matches</p>
            <p>Try another name, or show all conversations.</p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Show all
            </button>
          </div>
        ) : (
          <ul className="room-list list-plain">
            {joined.map((s) => (
              <RoomListItem key={s.roomId} s={s} active={s.roomId === activeRoomId} />
            ))}
          </ul>
        )}
      </nav>
      <footer className="sidebar-footer">
        <UserChip onSignOut={onSignOut} />
      </footer>
    </aside>
  );
}
