/**
 * The unified inbox's merge logic (pure, unit-tested in test/unit/inbox-merge.test.ts).
 *
 * Four kinds of input become one sorted list of `InboxEntry`:
 * - native chat rooms, read in the browser from the Matrix client (already decrypted on this
 *   device; their previews never leave it and are never sent to the workspace server);
 * - synced items from the integrations API (Gmail threads, Slack messages, HighLevel
 *   conversations, missed calls), always external and untrusted;
 * - workspace notifications (the automation app), and meeting follow-ups (calendar events
 *   that ended without being marked done).
 *
 * Rules: an external item is never presented as native; only server items support
 * assignment, priority and labels; muted groups are hidden unless asked for; notification
 * groups (a Slack channel, a notification type) can be collapsed into one row.
 */

import type { Priority } from "../types";
import type { ServerInboxItem, WorkspaceNotification } from "./types";

export type EntrySource = "chat" | "gmail" | "slack" | "gohighlevel" | "nexus";
export type EntryOrigin = "native" | "synced_email" | "external_message" | "imported_record" | "external_notification" | "workspace";
export type EntryKind =
  | "conversation"
  | "invite"
  | "missed_call"
  | "email_thread"
  | "slack_message"
  | "ghl_conversation"
  | "notification"
  | "meeting_follow_up";

export type EntryRef =
  | { type: "room"; roomId: string }
  | { type: "item"; id: string }
  | { type: "notification"; id: string; link: string }
  | { type: "meeting"; id: string; contactId: string | null };

export interface InboxEntry {
  key: string;
  source: EntrySource;
  origin: EntryOrigin;
  kind: EntryKind;
  title: string;
  preview: string;
  /** ms since epoch */
  at: number;
  unread: boolean;
  unreadCount: number;
  highlight: boolean;
  priority: Priority;
  assigneeId: string | null;
  labels: string[];
  groupKey: string;
  groupLabel: string;
  muted: boolean;
  external: boolean;
  mock: boolean;
  /** Assignment, priority, labels and done are kept for synced items only. */
  supportsState: boolean;
  ref: EntryRef;
  /** Set on a collapsed group's first row. */
  groupCount?: number;
  groupKeys?: string[];
}

export interface NativeRoomInput {
  roomId: string;
  name: string;
  preview: string;
  lastTs: number;
  unread: number;
  highlight: number;
  membership: string;
  missedCall: { video: boolean; ts: number } | null;
}

export interface MeetingInput {
  id: string;
  title: string;
  end_at: string;
  status: string;
  contact: { id: string; display_name: string } | null;
}

export function nativeGroupKey(roomId: string): string {
  return `matrix:${roomId}`;
}

export function notificationGroupKey(n: Pick<WorkspaceNotification, "event_type">): string {
  return `nexus:notification:${n.event_type.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 120)}`;
}

const NO_STATE = { priority: "normal" as Priority, assigneeId: null, labels: [] as string[], supportsState: false };

export function fromNativeRooms(rooms: NativeRoomInput[], muted: ReadonlySet<string> = new Set()): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const r of rooms) {
    if (r.membership !== "join" && r.membership !== "invite") continue;
    const groupKey = nativeGroupKey(r.roomId);
    const invite = r.membership === "invite";
    out.push({
      key: `native:${r.roomId}`,
      source: "chat",
      origin: "native",
      kind: invite ? "invite" : "conversation",
      title: r.name || "Conversation",
      preview: invite ? "Invitation to join" : r.preview,
      at: r.lastTs,
      unread: invite || r.unread > 0,
      unreadCount: invite ? 1 : r.unread,
      highlight: r.highlight > 0,
      ...NO_STATE,
      groupKey,
      groupLabel: r.name,
      muted: muted.has(groupKey),
      external: false,
      mock: false,
      ref: { type: "room", roomId: r.roomId },
    });
    if (r.missedCall) {
      out.push({
        key: `native-call:${r.roomId}:${r.missedCall.ts}`,
        source: "chat",
        origin: "native",
        kind: "missed_call",
        title: `Missed ${r.missedCall.video ? "video " : ""}call · ${r.name}`,
        preview: "End-to-end encrypted call",
        at: r.missedCall.ts,
        unread: true,
        unreadCount: 1,
        highlight: true,
        ...NO_STATE,
        groupKey,
        groupLabel: r.name,
        muted: muted.has(groupKey),
        external: false,
        mock: false,
        ref: { type: "room", roomId: r.roomId },
      });
    }
  }
  return out;
}

const SERVER_SOURCE: Record<ServerInboxItem["source"], EntrySource> = { gmail: "gmail", slack: "slack", gohighlevel: "gohighlevel" };

export function fromServerItems(items: ServerInboxItem[]): InboxEntry[] {
  return items.map((it) => ({
    key: `item:${it.id}`,
    source: SERVER_SOURCE[it.source],
    // Synced items keep the server's origin; never "native", whatever the payload says.
    origin: (["synced_email", "external_message", "imported_record", "external_notification"] as const).includes(it.origin)
      ? it.origin
      : "external_message",
    kind: it.kind,
    title: it.title || it.source_label,
    preview: it.snippet,
    at: Date.parse(it.occurred_at) || 0,
    unread: it.unread,
    unreadCount: it.unread ? 1 : 0,
    highlight: it.kind === "missed_call" || (it.source === "slack" && !!it.meta?.mentions_app),
    priority: it.priority,
    assigneeId: it.assignee?.id ?? null,
    labels: it.labels,
    supportsState: true,
    groupKey: it.group.key,
    groupLabel: it.group.label,
    muted: it.muted,
    external: true,
    mock: it.is_mock,
    ref: { type: "item", id: it.id },
  }));
}

export function fromNotifications(ns: WorkspaceNotification[], muted: ReadonlySet<string> = new Set()): InboxEntry[] {
  return ns.map((n) => {
    const groupKey = notificationGroupKey(n);
    return {
      key: `notification:${n.id}`,
      source: "nexus" as const,
      origin: "workspace" as const,
      kind: "notification" as const,
      title: n.title,
      preview: n.count > 1 ? `${n.body}${n.body ? " · " : ""}${n.count} updates` : n.body,
      at: Date.parse(n.updated_at || n.created_at) || 0,
      unread: !n.read,
      unreadCount: n.read ? 0 : 1,
      highlight: false,
      ...NO_STATE,
      groupKey,
      groupLabel: n.event_type.replace(/[._]/g, " "),
      muted: muted.has(groupKey),
      external: false,
      mock: false,
      ref: { type: "notification" as const, id: n.id, link: n.link },
    };
  });
}

/** Meetings that ended in the last `days` and are still "scheduled": time to follow up. */
export function fromMeetings(events: MeetingInput[], now: number, days = 7, done: ReadonlySet<string> = new Set()): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const e of events) {
    const end = Date.parse(e.end_at);
    if (!Number.isFinite(end) || end > now || end < now - days * 86_400_000 || e.status !== "scheduled" || done.has(e.id)) continue;
    out.push({
      key: `meeting:${e.id}`,
      source: "nexus",
      origin: "workspace",
      kind: "meeting_follow_up",
      title: `Follow up: ${e.title}`,
      preview: e.contact ? `With ${e.contact.display_name}` : "Add notes or a follow-up task",
      at: end,
      unread: true,
      unreadCount: 1,
      highlight: false,
      ...NO_STATE,
      groupKey: "nexus:meeting_follow_up",
      groupLabel: "Meeting follow-ups",
      muted: false,
      external: false,
      mock: false,
      ref: { type: "meeting", id: e.id, contactId: e.contact?.id ?? null },
    });
  }
  return out;
}

export type SourceFilter = "all" | "chat" | "email" | "slack" | "gohighlevel" | "notifications";

export interface InboxFilter {
  source: SourceFilter;
  unread?: boolean;
  q?: string;
  assignedTo?: string | null;
  label?: string;
  priority?: string;
  showMuted?: boolean;
}

export function isNotification(e: InboxEntry): boolean {
  return e.kind === "notification" || e.kind === "missed_call" || e.kind === "meeting_follow_up" || e.origin === "external_notification";
}

export function matchesSource(e: InboxEntry, source: SourceFilter): boolean {
  switch (source) {
    case "all":
      return true;
    case "chat":
      return e.source === "chat";
    case "email":
      return e.source === "gmail";
    case "slack":
      return e.source === "slack";
    case "gohighlevel":
      return e.source === "gohighlevel";
    case "notifications":
      return isNotification(e);
  }
}

export function filterEntries(entries: InboxEntry[], f: InboxFilter): InboxEntry[] {
  const terms = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (!matchesSource(e, f.source)) return false;
    if (e.muted && !f.showMuted) return false;
    if (f.unread && !e.unread) return false;
    if ((f.assignedTo || f.label || f.priority) && !e.supportsState) return false;
    if (f.assignedTo && e.assigneeId !== f.assignedTo) return false;
    if (f.label && !e.labels.includes(f.label)) return false;
    if (f.priority && e.priority !== f.priority) return false;
    if (terms.length) {
      const hay = `${e.title} ${e.preview} ${e.groupLabel}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

/** Newest first; one entry per key (later lists don't override earlier ones). */
export function mergeInbox(...lists: InboxEntry[][]): InboxEntry[] {
  const seen = new Set<string>();
  const out: InboxEntry[] = [];
  for (const list of lists) {
    for (const e of list) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      out.push(e);
    }
  }
  return out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

const GROUPABLE: ReadonlySet<EntryKind> = new Set(["slack_message", "notification", "meeting_follow_up"]);

/** Collapses notification-like entries of one group into its newest row (with a count). */
export function groupEntries(entries: InboxEntry[], enabled = true): InboxEntry[] {
  if (!enabled) return entries;
  const heads = new Map<string, InboxEntry>();
  const out: InboxEntry[] = [];
  for (const e of entries) {
    if (!GROUPABLE.has(e.kind) || !e.groupKey) {
      out.push(e);
      continue;
    }
    const head = heads.get(e.groupKey);
    if (!head) {
      const copy: InboxEntry = { ...e, groupCount: 1, groupKeys: [e.key] };
      heads.set(e.groupKey, copy);
      out.push(copy);
      continue;
    }
    head.groupCount = (head.groupCount ?? 1) + 1;
    head.groupKeys = [...(head.groupKeys ?? [head.key]), e.key];
    head.unread = head.unread || e.unread;
    head.unreadCount += e.unreadCount;
  }
  return out;
}

export function unreadTotal(entries: InboxEntry[]): number {
  return entries.filter((e) => !e.muted).reduce((n, e) => n + (e.unread ? Math.max(1, e.unreadCount) : 0), 0);
}

export const ORIGIN_LABEL: Record<EntryOrigin, string> = {
  native: "Encrypted chat",
  synced_email: "Synced email",
  external_message: "External message",
  imported_record: "Imported record",
  external_notification: "External notification",
  workspace: "Workspace",
};

export const SOURCE_LABEL: Record<EntrySource, string> = {
  chat: "Chat",
  gmail: "Gmail",
  slack: "Slack",
  gohighlevel: "HighLevel",
  nexus: "Nexus",
};

/** The HighLevel contact a person may add to Nexus from this inbox item ("Add to Nexus"): a
 * HighLevel conversation or missed call that names its contact and isn't linked to a Nexus
 * contact yet, for people who may create contacts and link items. Otherwise null. The name is the
 * participant's (a missed call's title is "Missed call from …"). */
export function highLevelContactToAdd(
  item: Pick<ServerInboxItem, "source" | "meta" | "links" | "capabilities" | "participants" | "title">,
  canCreateRecords: boolean,
): { id: string; name: string } | null {
  if (item.source !== "gohighlevel" || !canCreateRecords || !item.capabilities.link) return null;
  const id = item.meta?.contact_id;
  if (typeof id !== "string" || !id.trim()) return null;
  if (item.links.some((l) => l.target.type === "crm.contact")) return null;
  const name = item.participants?.find((p) => p.name?.trim())?.name?.trim();
  return { id, name: name || "this contact" };
}
