/**
 * Desktop notifications for new messages while the tab is hidden, driven by
 * the user's push rules (`getPushActionsForEvent(...).notify`).
 * Message text is only included when the user enabled previews.
 */
import { RoomEvent, type IRoomTimelineData, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { getPrefs } from "../lib/prefs";
import { roomHash } from "../lib/matrix-id";
import { isMessageEvent, previewText } from "./rooms";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Must be called from a user gesture (settings toggle). */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  return Notification.requestPermission();
}

export function startDesktopNotifications(client: MatrixClient, brandName: string): () => void {
  const me = client.getUserId();
  const onTimeline = async (
    ev: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData,
  ) => {
    if (toStartOfTimeline || removed || !data?.liveEvent || !room) return;
    if (ev.getSender() === me) return;
    const prefs = getPrefs();
    if (!prefs.notifications || notificationPermission() !== "granted") return;
    if (!document.hidden) return;
    await client.decryptEventIfNeeded(ev);
    if (!isMessageEvent(ev) || ev.isRedacted()) return;
    const actions = client.getPushActionsForEvent(ev, true);
    if (!actions?.notify) return;
    const sender = room.getMember(ev.getSender() ?? "")?.name ?? ev.getSender() ?? "";
    let body: string;
    if (prefs.notificationPreviews && !ev.isDecryptionFailure()) {
      body = previewText(ev, me ?? "");
      if (room.getJoinedMemberCount() > 2) body = `${sender}: ${body}`;
    } else {
      body = ev.isEncrypted() ? "New encrypted message" : "New message";
    }
    try {
      const n = new Notification(room.name || brandName, {
        body,
        tag: room.roomId,
        icon: "/brand/logo.svg",
        silent: !actions.tweaks?.sound,
      });
      n.onclick = () => {
        window.focus();
        window.location.hash = roomHash(room.roomId);
        n.close();
      };
    } catch {
      /* e.g. Android Chrome requires a service worker for notifications */
    }
  };
  const handler = (...args: Parameters<typeof onTimeline>) => void onTimeline(...args);
  client.on(RoomEvent.Timeline, handler);
  return () => {
    client.off(RoomEvent.Timeline, handler);
  };
}
