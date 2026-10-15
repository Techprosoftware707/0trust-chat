/**
 * App-wide call state: the one active call, the pre-join lobby request, and per-room
 * MatrixRTC membership (for "call in progress" indicators). React hooks over plain stores.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { MatrixRTCSessionManagerEvents } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSessionManager.js";
import type { CallIntent, CallSession, CallSnapshot } from "./CallSession";
import { callParticipants, roomSession } from "./rtc";

function simpleStore<T>(initial: T) {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      ls.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      ls.add(l);
      return () => ls.delete(l);
    },
  };
}

const active = simpleStore<CallSession | null>(null);
export const getActiveCall = active.get;
export const setActiveCall = active.set;
export function useActiveCall(): CallSession | null {
  return useSyncExternalStore(active.subscribe, active.get, active.get);
}

export interface LobbyRequest {
  roomId: string;
  intent: CallIntent;
  /** joining an ongoing call rather than starting one */
  joining: boolean;
}
const lobby = simpleStore<LobbyRequest | null>(null);
export const openLobby = (r: LobbyRequest) => lobby.set(r);
export const closeLobby = () => lobby.set(null);
export function useLobby(): LobbyRequest | null {
  return useSyncExternalStore(lobby.subscribe, lobby.get, lobby.get);
}

/** "full" = call screen, "mini" = floating card while chatting. */
const view = simpleStore<"full" | "mini">("full");
export const setCallView = view.set;
export function useCallView(): "full" | "mini" {
  return useSyncExternalStore(view.subscribe, view.get, view.get);
}

const NOOP_SNAPSHOT_SUB = () => () => undefined;
export function useCallSnapshot(session: CallSession | null): CallSnapshot | null {
  return useSyncExternalStore(session?.subscribe ?? NOOP_SNAPSHOT_SUB, session ? session.getSnapshot : () => null, session ? session.getSnapshot : () => null);
}

export interface RoomCallInfo {
  /** distinct users currently in the room's call */
  userIds: string[];
  /** number of devices (memberships) */
  devices: number;
  joinedHere: boolean;
  intent: CallIntent | null;
}

const EMPTY: RoomCallInfo = { userIds: [], devices: 0, joinedHere: false, intent: null };

function readRoomCall(client: MatrixClient, room: Room): RoomCallInfo {
  const s = roomSession(client, room);
  if (!s.memberships.length) return EMPTY;
  const me = client.getUserId();
  const dev = client.getDeviceId();
  const intent = s.getConsensusCallIntent();
  return {
    userIds: callParticipants(s),
    devices: s.memberships.length,
    joinedHere: s.memberships.some((m) => m.userId === me && m.deviceId === dev),
    intent: intent === "video" ? "video" : intent === "audio" ? "audio" : null,
  };
}

/** Live MatrixRTC participation in one room (updates on membership changes and expiry). */
export function useRoomCall(client: MatrixClient, room: Room | null): RoomCallInfo {
  const [info, setInfo] = useState<RoomCallInfo>(() => (room ? readRoomCall(client, room) : EMPTY));
  useEffect(() => {
    if (!room) {
      setInfo(EMPTY);
      return;
    }
    const s = roomSession(client, room);
    const update = () => setInfo(readRoomCall(client, room));
    update();
    s.on(MatrixRTCSessionEvent.MembershipsChanged, update);
    // the session object can be created lazily by the manager: also follow its start/end events
    const onManager = (roomId: string) => roomId === room.roomId && update();
    client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onManager);
    client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onManager);
    return () => {
      s.off(MatrixRTCSessionEvent.MembershipsChanged, update);
      client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onManager);
      client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, onManager);
    };
  }, [client, room]);
  return info;
}
