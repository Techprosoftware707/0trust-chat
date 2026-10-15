/**
 * App-level call plumbing (mounted when the deployment enables calls): incoming ring /
 * notification cards with ringtone, the pre-join lobby, the active call, and a notice for
 * legacy 1:1 VoIP invites (`m.call.invite`), which this app no longer supports.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MatrixEventEvent, RoomEvent, type IRoomTimelineData, type MatrixEvent, type Room } from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { Phone, PhoneOff, Video } from "lucide-react";
import { startRingtone } from "../../calls/audio";
import { startCall } from "../../calls/controller";
import { getCallPrefs } from "../../calls/prefs";
import { getActiveCall, useActiveCall, useLobby } from "../../calls/store";
import { LEGACY_CALL_INVITE, roomSession, RTC_NOTIFICATION_EVENT, sendDecline, validateNotification, type IncomingNotification } from "../../calls/rtc";
import { getPrefs } from "../../lib/prefs";
import { roomHash } from "../../lib/matrix-id";
import { useMatrix } from "../../matrix/context";
import { notificationPermission } from "../../matrix/notifications";
import { Avatar } from "../primitives/Avatar";
import { useUi } from "../UiContext";
import { CallLobby } from "./CallLobby";
import { CallScreen } from "./CallScreen";

const MAX_EVENT_AGE_MS = 2 * 60 * 1000;

/** A room whose notifications the user muted (room push rule with no "notify" action). */
function roomMuted(room: Room): boolean {
  const rule = room.client.getRoomPushRule("global", room.roomId);
  if (!rule) return false;
  return !rule.actions.some((a) => a === "notify" || (typeof a === "object" && "set_tweak" in a && a.set_tweak === "sound"));
}

function IncomingCallCard({ n, onDone }: { n: IncomingNotification; onDone: () => void }) {
  const { client, config } = useMatrix();
  const ui = useUi();
  const room = client.getRoom(n.roomId);
  const [busy, setBusy] = useState(false);
  const caller = room?.getMember(n.sender);
  const callerName = caller?.name ?? n.sender;
  const isRing = n.type === "ring";
  const title = isRing ? `${callerName} is calling` : `${callerName} started a call`;
  const sub = isRing ? (n.intent === "video" ? "Video call" : "Voice call") : `in ${room?.name ?? "a group"}`;

  const accept = async (intent: "audio" | "video") => {
    if (!room) return;
    setBusy(true);
    onDone();
    try {
      await startCall(client, config, room, { intent, notify: false });
      window.location.hash = roomHash(room.roomId);
    } catch (e) {
      ui.reportError(e, "Couldn't join the call");
    }
  };

  return (
    <div className={`incoming-call${isRing ? " ring" : ""}`} role="alertdialog" aria-label={title} aria-describedby={`ic-${n.eventId}`}>
      <Avatar name={callerName} seed={n.sender} mxc={caller?.getMxcAvatarUrl()} size={48} />
      <div className="incoming-main">
        <p className="incoming-title">{title}</p>
        <p className="incoming-sub" id={`ic-${n.eventId}`}>
          {sub}
          {getActiveCall() && getActiveCall()!.getSnapshot().phase !== "ended" ? " · accepting ends your current call" : ""}
        </p>
        <div className="incoming-actions">
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => {
              onDone();
              if (isRing) void sendDecline(client, n.roomId, n.eventId).catch((e: unknown) => ui.reportError(e, "Couldn't decline the call"));
            }}
          >
            <PhoneOff aria-hidden="true" /> {isRing ? "Decline" : "Dismiss"}
          </button>
          <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={() => void accept("audio")}>
            <Phone aria-hidden="true" /> {isRing ? "Accept" : "Join"}
          </button>
          <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={() => void accept("video")}>
            <Video aria-hidden="true" /> {isRing ? "Video" : "Join with video"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CallManager() {
  const { client, userId } = useMatrix();
  const ui = useUi();
  const active = useActiveCall();
  const lobby = useLobby();
  const [incoming, setIncoming] = useState<IncomingNotification[]>([]);
  const seen = useRef(new Set<string>());

  const remove = useCallback((id: string) => setIncoming((xs) => xs.filter((x) => x.eventId !== id)), []);

  // --- incoming notifications and legacy invites ---
  useEffect(() => {
    const consider = async (ev: MatrixEvent, room: Room) => {
      await client.decryptEventIfNeeded(ev);
      const id = ev.getId();
      if (!id || seen.current.has(id)) return;
      if (Date.now() - ev.getTs() > MAX_EVENT_AGE_MS) return;
      const type = ev.getType();
      if (type === LEGACY_CALL_INVITE && ev.getSender() !== userId) {
        seen.current.add(id);
        const who = room.getMember(ev.getSender() ?? "")?.name ?? ev.getSender();
        ui.toast({
          kind: "info",
          title: "Unsupported call type",
          body: `${who} tried to call you with an older calling method this app doesn't support. Ask them to start the call again from an up-to-date app, or call them from here.`,
          timeoutMs: 15000,
        });
        return;
      }
      if (type !== RTC_NOTIFICATION_EVENT) return;
      const n = validateNotification(ev, room, userId, roomSession(client, room));
      if (!n) return;
      seen.current.add(id);
      setIncoming((xs) => [...xs.filter((x) => x.roomId !== n.roomId), n]);
      // Desktop notification while the tab is in the background (same opt-in as messages).
      if (document.hidden && getPrefs().notifications && notificationPermission() === "granted" && !roomMuted(room)) {
        try {
          const who = room.getMember(n.sender)?.name ?? n.sender;
          const note = new Notification(n.type === "ring" ? `${who} is calling` : `Call in ${room.name}`, { tag: `call-${room.roomId}`, icon: "/brand/logo.svg" });
          note.onclick = () => {
            window.focus();
            window.location.hash = roomHash(room.roomId);
            note.close();
          };
        } catch {
          /* not available */
        }
      }
    };
    const onTimeline = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, removed: boolean, data: IRoomTimelineData) => {
      if (!room || toStart || removed || !data?.liveEvent) return;
      void consider(ev, room);
    };
    client.on(RoomEvent.Timeline, onTimeline);
    // events that were still encrypted when they arrived
    const onDecrypted = (ev: MatrixEvent) => {
      const room = client.getRoom(ev.getRoomId());
      if (room && (ev.getType() === RTC_NOTIFICATION_EVENT || ev.getType() === LEGACY_CALL_INVITE)) void consider(ev, room);
    };
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
    return () => {
      client.off(RoomEvent.Timeline, onTimeline);
      client.off(MatrixEventEvent.Decrypted, onDecrypted);
    };
  }, [client, userId, ui]);

  // --- expire / withdraw incoming cards: lifetime over, call ended, answered elsewhere, declined elsewhere ---
  useEffect(() => {
    if (!incoming.length) return;
    const check = () => {
      for (const n of incoming) {
        const room = client.getRoom(n.roomId);
        const s = room ? roomSession(client, room) : null;
        const ev = room?.findEventById(n.eventId);
        const stillValid = room && ev ? validateNotification(ev, room, userId, s) : null;
        if (!stillValid || Date.now() >= n.expiresAt || (active && active.roomId === n.roomId && active.getSnapshot().phase !== "ended")) remove(n.eventId);
      }
    };
    const t = setInterval(check, 1000);
    const unsubs = incoming.map((n) => {
      const room = client.getRoom(n.roomId);
      if (!room) return () => undefined;
      const s = roomSession(client, room);
      s.on(MatrixRTCSessionEvent.MembershipsChanged, check);
      return () => s.off(MatrixRTCSessionEvent.MembershipsChanged, check);
    });
    return () => {
      clearInterval(t);
      unsubs.forEach((u) => u());
    };
  }, [incoming, client, userId, active, remove]);

  // --- ringtone for 1:1 rings (respects the setting and muted rooms) ---
  const ringing = incoming.find((n) => n.type === "ring" && !roomMuted(client.getRoom(n.roomId)!));
  const inCall = !!active && active.getSnapshot().phase !== "ended";
  useEffect(() => {
    if (!ringing || inCall || !getCallPrefs().ringtone) return;
    return startRingtone(getCallPrefs().speakerDeviceId);
  }, [ringing, inCall]);

  return (
    <>
      {incoming.length ? (
        <section className="incoming-calls" aria-label="Incoming calls">
          {incoming.map((n) => (
            <IncomingCallCard key={n.eventId} n={n} onDone={() => remove(n.eventId)} />
          ))}
        </section>
      ) : null}
      {lobby ? <CallLobby key={`${lobby.roomId}-${lobby.intent}`} request={lobby} /> : null}
      {active ? <CallScreen key={active.roomId} session={active} /> : null}
    </>
  );
}
