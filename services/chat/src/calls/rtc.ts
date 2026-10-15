/**
 * MatrixRTC protocol glue (independent implementation on matrix-js-sdk 44, compatible with
 * Element Call's "compatibility" mode, which is its default):
 *
 *  - slot `m.call#ROOM` (application "m.call", id "ROOM"); memberships are
 *    `org.matrix.msc3401.call.member` state events written by the js-sdk MembershipManager,
 *    with membership/member id `${userId}:${deviceId}` and a delayed leave event;
 *  - transport: `{type: "livekit", url}` as advertised by the homeserver
 *    (`/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`); the focus we connect to is
 *    the transport of the oldest membership in the session, or our own homeserver's when we
 *    are first;
 *  - SFU token: MSC4195 `get_token` through the homeserver (lk-jwt-service), body
 *    `{url, server_name, room_id, slot_id, member_id}`; the LiveKit identity in the token is
 *    `unpaddedBase64(sha256(JSON([userId, memberId])))`, the same value the js-sdk reports as a
 *    membership's backend identity, which keys the media encryption keys;
 *  - media keys: per participant, generated/rotated/distributed by the js-sdk
 *    (`manageMediaKeys`, encrypted to-device messages) and fed to LiveKit's frame encryptor;
 *  - ringing: `org.matrix.msc4075.rtc.notification` (DM: "ring", group: "notification"),
 *    declining: `org.matrix.msc4310.rtc.decline` referencing the notification.
 */
import { EventType, RelationType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { type CallMembership, type MatrixRTCSession, type Transport } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { AppConfig } from "../config";

export const SLOT = { application: "m.call", id: "ROOM" } as const;
export const SLOT_ID = "m.call#ROOM";
export const CALL_MEMBER_EVENT = "org.matrix.msc3401.call.member";
export const RTC_NOTIFICATION_EVENT = "org.matrix.msc4075.rtc.notification";
export const RTC_DECLINE_EVENT = "org.matrix.msc4310.rtc.decline";
export const LEGACY_CALL_INVITE = "m.call.invite";
/** Notifications are honoured for at most this long (MSC4075 caps lifetime at 2 min). */
export const MAX_NOTIFICATION_LIFETIME_MS = 120_000;
export const RING_LIFETIME_MS = 45_000;

export interface LivekitFocus {
  url: string;
  /** server name of the homeserver that owns the SFU (token requests go through ours) */
  serverName: string;
}

export function memberIdFor(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export function serverNameOf(userId: string): string {
  return userId.slice(userId.indexOf(":") + 1);
}

export function roomSession(client: MatrixClient, room: Room): MatrixRTCSession {
  return client.matrixRTC.getRoomSession(room);
}

/** Only wss:// SFU URLs (ws:// for loopback development) are ever used. */
export function validLivekitUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "wss:" && !(u.protocol === "ws:" && loopback)) return null;
    if (u.username || u.password) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function livekitUrlOf(t: Transport | undefined | null): string | null {
  if (!t || t.type !== "livekit") return null;
  return validLivekitUrl(t.url);
}

/**
 * Our homeserver's LiveKit transport: from `/rtc/transports` (MSC4143), else the deployment's
 * configured `calls.rtc_domain`.
 */
export async function discoverOwnTransport(client: MatrixClient, config: AppConfig): Promise<LivekitFocus> {
  const server = client.getDomain() ?? config.homeserver.serverName;
  try {
    const transports = await client._unstable_getRTCTransports();
    for (const t of transports) {
      const url = livekitUrlOf(t);
      if (url) return { url, serverName: server };
    }
  } catch {
    /* not advertised: fall back to the configured domain */
  }
  if (config.calls.rtcDomain) return { url: `wss://${config.calls.rtcDomain}`, serverName: server };
  throw new CallSetupError("no-transport", "Your server doesn't offer a media server for calls.");
}

/**
 * Focus selection ("oldest membership"): join the SFU used by the longest-standing participant,
 * so everybody meets on one media server; if we are first, use our own.
 */
export function selectFocus(memberships: CallMembership[], own: LivekitFocus): { focus: LivekitFocus; fromMembership: CallMembership | null } {
  const sorted = [...memberships].sort((a, b) => a.createdTs() - b.createdTs());
  for (const m of sorted) {
    const url = livekitUrlOf(m.getTransport());
    if (url) return { focus: { url, serverName: serverNameOf(m.userId) }, fromMembership: m };
    // A membership published with a JWT-service-only transport (`livekit_service_url`) can't be
    // joined through MSC4195; skip it rather than guess.
  }
  return { focus: own, fromMembership: null };
}

export class CallSetupError extends Error {
  override name = "CallSetupError";
  constructor(
    readonly code: "no-transport" | "forbidden" | "token" | "media" | "network" | "not-joined",
    message: string,
  ) {
    super(message);
  }
}

export interface SfuToken {
  jwt: string;
  identity: string;
  livekitRoom: string;
  expiresAt: number | null;
}

export function parseJwt(jwt: string): { sub?: string; exp?: number; video?: { room?: string } } {
  const part = jwt.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(b64)) as { sub?: string; exp?: number; video?: { room?: string } };
}

/** MSC4195 token request through the homeserver (it checks that we are joined to the room). */
export async function getSfuToken(client: MatrixClient, focus: LivekitFocus, roomId: string, memberId: string): Promise<SfuToken> {
  let res: { jwt?: string };
  try {
    // The js-sdk 44 typings describe an older body ({member: {id, claimed_device_id}}); the
    // deployed lk-jwt-service (and Element Call) use `member_id`.
    res = await client._unstable_getLivekitToken({
      url: focus.url,
      server_name: focus.serverName,
      room_id: roomId,
      slot_id: SLOT_ID,
      member_id: memberId,
    } as unknown as Parameters<MatrixClient["_unstable_getLivekitToken"]>[0]);
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus;
    if (status === 403) throw new CallSetupError("forbidden", "You aren't allowed to join calls in this conversation.");
    if (status === 404) throw new CallSetupError("token", "Your server doesn't support MatrixRTC calls (no token service).");
    if (status === undefined) throw new CallSetupError("network", "Couldn't reach your server to start the call.");
    throw new CallSetupError("token", `The server couldn't authorise the call (HTTP ${status}).`);
  }
  if (!res?.jwt) throw new CallSetupError("token", "The server returned no media token.");
  const p = parseJwt(res.jwt);
  if (!p.sub || !p.video?.room) throw new CallSetupError("token", "The media token is malformed.");
  return { jwt: res.jwt, identity: p.sub, livekitRoom: p.video.room, expiresAt: p.exp ? p.exp * 1000 : null };
}

// ---- Notifications ------------------------------------------------------------------------

export interface IncomingNotification {
  eventId: string;
  roomId: string;
  sender: string;
  type: "ring" | "notification";
  intent: "audio" | "video";
  expiresAt: number;
}

/**
 * Validates a received `rtc.notification` for the local user (after decryption). Follows the
 * MSC4075 receiving rules that apply without sticky events: not from us, mentions us (or the
 * room), not expired (lifetime from `sender_ts` unless that's > 20 s ahead of the server
 * timestamp, capped at 2 min), we didn't decline it, we aren't in the call, and the call it
 * announces still has participants. (The js-sdk's own parser additionally requires an open
 * `m.rtc.slot` state event, which Element Call doesn't send.)
 */
export function validateNotification(ev: MatrixEvent, room: Room, me: string, session: MatrixRTCSession | null, now = Date.now()): IncomingNotification | null {
  if (ev.getType() !== RTC_NOTIFICATION_EVENT || ev.isRedacted()) return null;
  const sender = ev.getSender();
  const id = ev.getId();
  if (!sender || !id || sender === me) return null;
  const c = ev.getContent() as Record<string, unknown>;
  const mentions = (c["m.mentions"] ?? {}) as { room?: unknown; user_ids?: unknown };
  const mentionsMe = (Array.isArray(mentions.user_ids) && mentions.user_ids.includes(me)) || mentions.room === true;
  if (!mentionsMe) return null;
  const senderTs = typeof c.sender_ts === "number" ? c.sender_ts : ev.getTs();
  const lifetime = Math.min(typeof c.lifetime === "number" && c.lifetime >= 0 ? c.lifetime : RING_LIFETIME_MS, MAX_NOTIFICATION_LIFETIME_MS);
  const base = senderTs - ev.getTs() > 20_000 ? ev.getTs() : senderTs;
  const expiresAt = base + lifetime;
  if (now >= expiresAt) return null;
  if (hasDeclined(room, id, me)) return null;
  if (session) {
    if (session.memberships.length === 0) return null;
    if (session.memberships.some((m) => m.userId === me)) return null;
  }
  const t = c.notification_type ?? c.notify_type;
  const intent = c["m.call.intent"] === "video" ? "video" : "audio";
  return { eventId: id, roomId: room.roomId, sender, type: t === "ring" ? "ring" : "notification", intent, expiresAt };
}

export function hasDeclined(room: Room, notificationId: string, userId: string): boolean {
  const rel = room.getUnfilteredTimelineSet().relations.getChildEventsForEvent(notificationId, RelationType.Reference, RTC_DECLINE_EVENT);
  if (rel?.getRelations().some((d) => d.getSender() === userId)) return true;
  // relations aren't always aggregated (e.g. encrypted events decrypted late): scan the timeline
  return room
    .getLiveTimeline()
    .getEvents()
    .some((e) => e.getType() === RTC_DECLINE_EVENT && e.getSender() === userId && e.getRelation()?.event_id === notificationId);
}

export async function sendDecline(client: MatrixClient, roomId: string, notificationId: string): Promise<void> {
  await client.sendEvent(roomId, RTC_DECLINE_EVENT as EventType.RTCDecline, {
    "m.relates_to": { rel_type: RelationType.Reference, event_id: notificationId },
  });
}

/** Distinct users with a current membership in the room's call (devices of one user count once). */
export function callParticipants(session: MatrixRTCSession | null): string[] {
  if (!session) return [];
  return [...new Set(session.memberships.map((m) => m.userId))];
}
