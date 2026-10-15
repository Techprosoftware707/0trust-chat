/** React hooks over matrix-js-sdk state. Everything shown comes from real SDK state. */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  UserEvent,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { CryptoEvent, type UserVerificationStatus } from "matrix-js-sdk/lib/crypto-api/index.js";
import { summarise, type RoomSummary } from "../matrix/rooms";
import { useEmitterVersion } from "./useEmitter";

const ROOM_LIST_EVENTS = [
  ClientEvent.Room,
  ClientEvent.DeleteRoom,
  ClientEvent.AccountData,
  RoomEvent.Timeline,
  RoomEvent.Name,
  RoomEvent.MyMembership,
  RoomEvent.Receipt,
  RoomEvent.UnreadNotifications,
  RoomEvent.LocalEchoUpdated,
  RoomEvent.Redaction,
  RoomEvent.TimelineReset,
  MatrixEventEvent.Decrypted,
] as const;

export function useRoomSummaries(client: MatrixClient): RoomSummary[] {
  const v = useEmitterVersion(client, ROOM_LIST_EVENTS, 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => summarise(client), [client, v]);
}

export function useRoom(client: MatrixClient, roomId: string | null): Room | null {
  const v = useEmitterVersion(client, [ClientEvent.Room, ClientEvent.DeleteRoom, RoomEvent.MyMembership]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (roomId ? client.getRoom(roomId) : null), [client, roomId, v]);
}

export function useSyncState(client: MatrixClient): { state: SyncState | null; error: Error | undefined } {
  const [s, setS] = useState<{ state: SyncState | null; error: Error | undefined }>(() => ({
    state: client.getSyncState(),
    error: client.getSyncStateData()?.error,
  }));
  useEffect(() => {
    const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }) => setS({ state, error: data?.error });
    client.on(ClientEvent.Sync, onSync);
    return () => {
      client.off(ClientEvent.Sync, onSync);
    };
  }, [client]);
  return s;
}

/** Whether encryption is enabled in a room, from the crypto layer (null while loading). */
export function useRoomEncrypted(client: MatrixClient, room: Room | null): boolean | null {
  const [enc, setEnc] = useState<boolean | null>(() => (room?.hasEncryptionStateEvent() ? true : null));
  const v = useEmitterVersion(room, [RoomStateEvent.Events]);
  useEffect(() => {
    let alive = true;
    if (!room) return;
    const crypto = client.getCrypto();
    if (!crypto) {
      setEnc(room.hasEncryptionStateEvent());
      return;
    }
    // Same rule as the SDK uses when sending: encrypted if the room has an m.room.encryption
    // state event OR the crypto layer has it configured as encrypted.
    crypto
      .isEncryptionEnabledInRoom(room.roomId)
      .then((e) => alive && setEnc(e || room.hasEncryptionStateEvent()))
      .catch(() => alive && setEnc(room.hasEncryptionStateEvent()));
    return () => {
      alive = false;
    };
  }, [client, room, v]);
  return enc;
}

/** Cross-signing verification status of a user (null while loading / unknown). */
export function useUserTrust(client: MatrixClient, userId: string | null): { status: UserVerificationStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<UserVerificationStatus | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!userId) return;
    const onChange = (changed: string) => {
      if (changed === userId) refresh();
    };
    const onDevices = (users: string[]) => {
      if (users.includes(userId)) refresh();
    };
    client.on(CryptoEvent.UserTrustStatusChanged, onChange);
    client.on(CryptoEvent.DevicesUpdated, onDevices);
    client.on(CryptoEvent.KeysChanged, refresh);
    return () => {
      client.off(CryptoEvent.UserTrustStatusChanged, onChange);
      client.off(CryptoEvent.DevicesUpdated, onDevices);
      client.off(CryptoEvent.KeysChanged, refresh);
    };
  }, [client, userId, refresh]);
  useEffect(() => {
    let alive = true;
    if (!userId) {
      setStatus(null);
      return;
    }
    client
      .getCrypto()
      ?.getUserVerificationStatus(userId)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [client, userId, tick]);
  return { status, refresh };
}

export interface PresenceInfo {
  presence: string;
  currentlyActive: boolean;
  lastActiveAgo: number;
  lastPresenceTs: number;
}

/** Presence, only if the server has actually sent presence for this user. */
export function usePresence(client: MatrixClient, userId: string | null): PresenceInfo | null {
  const user = userId ? client.getUser(userId) : null;
  useEmitterVersion(user, [UserEvent.Presence, UserEvent.CurrentlyActive, UserEvent.LastPresenceTs]);
  // Users that appear later (first presence event) are created by the SDK: listen on the client too.
  useEmitterVersion(client, [UserEvent.Presence]);
  if (!user || !user.events.presence) return null;
  return {
    presence: user.presence,
    currentlyActive: user.currentlyActive,
    lastActiveAgo: user.lastActiveAgo,
    lastPresenceTs: user.lastPresenceTs,
  };
}

export function useTypingMembers(client: MatrixClient, room: Room | null): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!room) return;
    const me = client.getUserId();
    const update = () =>
      setNames(
        room
          .getMembers()
          .filter((m) => m.typing && m.userId !== me)
          .map((m) => m.name),
      );
    update();
    const onTyping = (_ev: unknown, member: { roomId: string }) => {
      if (member.roomId === room.roomId) update();
    };
    client.on(RoomMemberEvent.Typing, onTyping);
    return () => {
      client.off(RoomMemberEvent.Typing, onTyping);
    };
  }, [client, room]);
  return names;
}

const profileCache = new Map<string, Promise<{ displayname?: string; avatar_url?: string } | null>>();

/** Forget cached profiles (e.g. after the user edits their own profile). */
export function invalidateProfile(userId: string): void {
  profileCache.delete(userId);
}

/** Display name + avatar of a user: from the room membership if available, else the profile API. */
export function useUserProfile(client: MatrixClient, userId: string | null, room?: Room | null) {
  const member = userId && room ? room.getMember(userId) : null;
  const user = userId ? client.getUser(userId) : null;
  const v = useEmitterVersion(user, [UserEvent.DisplayName, UserEvent.AvatarUrl]);
  const [profile, setProfile] = useState<{ displayname?: string; avatar_url?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setProfile(null);
    if (!userId || member) return;
    let p = profileCache.get(userId);
    if (!p) {
      p = client.getProfileInfo(userId).catch(() => null);
      profileCache.set(userId, p);
    }
    void p.then((res) => alive && setProfile(res));
    return () => {
      alive = false;
    };
  }, [client, userId, member, v]);
  const userName = user?.displayName && user.displayName !== userId ? user.displayName : null;
  return {
    displayName: member?.name || userName || profile?.displayname || userId || "",
    avatarMxc: member?.getMxcAvatarUrl() || user?.avatarUrl || profile?.avatar_url || null,
  };
}

/** m.direct changes, for DM-aware components. */
export function useDirectVersion(client: MatrixClient): number {
  const v = useEmitterVersion(client, [ClientEvent.AccountData]);
  return v + (client.getAccountData(EventType.Direct) ? 0 : 0);
}
