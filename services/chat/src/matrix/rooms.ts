/** Room helpers: DM detection, summaries for the room list, room creation, invites. */
import {
  ClientEvent,
  EventStatus,
  EventType,
  KnownMembership,
  NotificationCountType,
  Preset,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { parseMessage, stripReplyFallback, toPlainText } from "../lib/markdown";
import { unseenMissedCall } from "../calls/history";

export const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

export const encryptionInitialState = () => ({
  type: EventType.RoomEncryption,
  state_key: "",
  content: { algorithm: MEGOLM_ALGORITHM },
});

/** roomId -> userId, from the `m.direct` account data. */
export function getDmMap(client: MatrixClient): Map<string, string> {
  const content = (client.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, unknown>;
  const map = new Map<string, string>();
  for (const [userId, rooms] of Object.entries(content)) {
    if (!Array.isArray(rooms)) continue;
    for (const r of rooms) if (typeof r === "string") map.set(r, userId);
  }
  return map;
}

/** The other user of a DM, or null for group rooms. */
export function dmPartner(client: MatrixClient, room: Room, dmMap = getDmMap(client)): string | null {
  const fromMap = dmMap.get(room.roomId);
  if (fromMap) return fromMap;
  if (room.getMyMembership() === KnownMembership.Invite) {
    const inviter = room.getDMInviter();
    if (inviter) return inviter;
  }
  return null;
}

/** Message text without markdown markers or a legacy reply fallback, on one line. */
function plainPreview(ev: MatrixEvent, body: string): string {
  const text = ev.replyEventId ? stripReplyFallback(body) : body;
  return toPlainText(parseMessage(text.slice(0, 2000))).replace(/\s+/g, " ").trim().slice(0, 140);
}

const PREVIEW_TYPES = new Set<string>([EventType.RoomMessage, EventType.RoomMessageEncrypted, EventType.Sticker]);

/** True for events that should appear as messages (not relations, not state). */
export function isMessageEvent(ev: MatrixEvent): boolean {
  if (!PREVIEW_TYPES.has(ev.getType())) return false;
  const rel = ev.getRelation()?.rel_type;
  if (rel === "m.replace" || rel === "m.annotation") return false;
  return true;
}

export function lastMessageEvent(room: Room): MatrixEvent | undefined {
  const pending = room.getPendingEvents();
  for (let i = pending.length - 1; i >= 0; i--) if (isMessageEvent(pending[i])) return pending[i];
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0 && i >= events.length - 60; i--) {
    if (isMessageEvent(events[i])) return events[i];
  }
  return undefined;
}

/** A short single-line preview of an event, honest about what we can show. */
export function previewText(ev: MatrixEvent | undefined, myUserId: string): string {
  if (!ev) return "";
  if (ev.isRedacted()) return "Message deleted";
  if (ev.isDecryptionFailure()) return "Unable to decrypt message";
  if (ev.isEncrypted() && ev.isBeingDecrypted()) return "Decrypting…";
  if (ev.getType() === EventType.RoomMessageEncrypted) return "Encrypted message";
  const c = ev.getContent() as { msgtype?: string; body?: unknown };
  const who = ev.getSender() === myUserId ? "You: " : "";
  if (ev.status === EventStatus.NOT_SENT) return "Failed to send";
  switch (c.msgtype) {
    case "m.key.verification.request":
      return "Verification request";
    case "m.image":
      return `${who}Sent an image`;
    case "m.file":
      return `${who}Sent a file`;
    case "m.video":
      return `${who}Sent a video`;
    case "m.audio":
      return `${who}Sent audio`;
    default:
      return typeof c.body === "string" ? who + plainPreview(ev, c.body) : "";
  }
}

export interface RoomSummary {
  room: Room;
  roomId: string;
  name: string;
  membership: string;
  isDm: boolean;
  dmUserId: string | null;
  lastTs: number;
  unread: number;
  highlight: number;
  preview: string;
  inviter: string | null;
  /** the latest call here was missed and not seen yet */
  missedCall: { video: boolean; ts: number } | null;
}

export function summarise(client: MatrixClient): RoomSummary[] {
  const me = client.getSafeUserId();
  const dmMap = getDmMap(client);
  const out: RoomSummary[] = [];
  for (const room of client.getRooms()) {
    const membership = room.getMyMembership();
    if (membership !== KnownMembership.Join && membership !== KnownMembership.Invite) continue;
    if (room.isSpaceRoom()) continue;
    const dmUserId = dmPartner(client, room, dmMap);
    const last = lastMessageEvent(room);
    let inviter: string | null = null;
    if (membership === KnownMembership.Invite) {
      inviter = room.getMember(me)?.events.member?.getSender() ?? null;
    }
    out.push({
      room,
      roomId: room.roomId,
      name: room.name || "Empty room",
      membership,
      isDm: dmUserId !== null,
      dmUserId,
      lastTs: room.getLastActiveTimestamp() > 0 ? room.getLastActiveTimestamp() : (last?.getTs() ?? 0),
      unread: room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
      highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
      preview: previewText(last, me),
      inviter,
      missedCall: missedCallOf(client, room, me),
    });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return out;
}

function missedCallOf(client: MatrixClient, room: Room, me: string): RoomSummary["missedCall"] {
  if (room.getMyMembership() !== KnownMembership.Join) return null;
  const devices = client.matrixRTC?.getActiveRoomSession(room)?.memberships.length ?? 0;
  const c = unseenMissedCall(room.getLiveTimeline().getEvents(), me, devices, room.getEventReadUpTo(me));
  return c ? { video: c.intent === "video", ts: c.startTs } : null;
}

export async function addToDmMap(client: MatrixClient, userId: string, roomId: string): Promise<void> {
  const content = { ...((client.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>) };
  const rooms = Array.isArray(content[userId]) ? content[userId] : [];
  if (rooms.includes(roomId)) return;
  content[userId] = [...rooms, roomId];
  await client.setAccountData(EventType.Direct, content);
}

/** An existing DM with `userId` that we are joined to and they are joined/invited to. */
export function findDm(client: MatrixClient, userId: string): Room | null {
  const dmMap = getDmMap(client);
  let best: Room | null = null;
  for (const [roomId, uid] of dmMap) {
    if (uid !== userId) continue;
    const room = client.getRoom(roomId);
    if (!room || room.getMyMembership() !== KnownMembership.Join) continue;
    const m = room.getMember(userId)?.membership;
    if (m !== KnownMembership.Join && m !== KnownMembership.Invite) continue;
    if (!best || room.getLastActiveTimestamp() > best.getLastActiveTimestamp()) best = room;
  }
  return best;
}

/** Waits until the client knows about a room we just created or joined. */
export function waitForRoom(client: MatrixClient, roomId: string, timeoutMs = 15_000): Promise<Room> {
  const existing = client.getRoom(roomId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      client.off(ClientEvent.Room, onRoom);
      reject(new Error("Timed out waiting for the room to appear"));
    }, timeoutMs);
    const onRoom = (room: Room) => {
      if (room.roomId !== roomId) return;
      clearTimeout(t);
      client.off(ClientEvent.Room, onRoom);
      resolve(room);
    };
    client.on(ClientEvent.Room, onRoom);
  });
}

export async function createDm(client: MatrixClient, userId: string): Promise<string> {
  const { room_id } = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: Preset.TrustedPrivateChat,
    initial_state: [encryptionInitialState()],
  });
  await addToDmMap(client, userId, room_id);
  return room_id;
}

export async function openOrCreateDm(client: MatrixClient, userId: string): Promise<string> {
  return findDm(client, userId)?.roomId ?? createDm(client, userId);
}

export async function createGroup(
  client: MatrixClient,
  opts: { name: string; topic?: string; invite: string[]; encrypted: boolean },
): Promise<string> {
  const { room_id } = await client.createRoom({
    name: opts.name,
    topic: opts.topic || undefined,
    preset: Preset.PrivateChat,
    invite: opts.invite,
    initial_state: opts.encrypted ? [encryptionInitialState()] : [],
  });
  return room_id;
}

/** Accepts an invite; DM invites are recorded in m.direct like other clients do. */
export async function acceptInvite(client: MatrixClient, room: Room): Promise<void> {
  const me = client.getSafeUserId();
  const memberEvent = room.getMember(me)?.events.member;
  const isDirect = memberEvent?.getContent()?.is_direct === true;
  const inviter = memberEvent?.getSender();
  await client.joinRoom(room.roomId);
  if (isDirect && inviter && inviter !== me) await addToDmMap(client, inviter, room.roomId).catch(() => undefined);
}

export async function declineInvite(client: MatrixClient, room: Room): Promise<void> {
  await client.leave(room.roomId);
  await client.forget(room.roomId).catch(() => undefined);
}
