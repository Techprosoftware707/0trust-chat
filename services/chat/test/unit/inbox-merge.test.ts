import { describe, expect, it } from "vitest";
import {
  filterEntries,
  fromMeetings,
  fromNativeRooms,
  fromNotifications,
  fromServerItems,
  groupEntries,
  highLevelContactToAdd,
  mergeInbox,
  nativeGroupKey,
  notificationGroupKey,
  unreadTotal,
  type NativeRoomInput,
} from "../../src/workspace/integrations/merge";
import type { ServerInboxItem, WorkspaceNotification } from "../../src/workspace/integrations/types";

const T0 = Date.parse("2026-10-17T12:00:00Z");

function room(over: Partial<NativeRoomInput> = {}): NativeRoomInput {
  return { roomId: "!a:chatdev.test", name: "Avery", preview: "Decrypted locally", lastTs: T0 - 60_000, unread: 2, highlight: 0, membership: "join",
           missedCall: null, ...over };
}

function item(over: Partial<ServerInboxItem> = {}): ServerInboxItem {
  return {
    id: "11111111-1111-1111-1111-111111111111", type: "integrations.inboxitem", source: "gmail", source_label: "Gmail", kind: "email_thread",
    kind_label: "Email thread", origin: "synced_email", external: true, untrusted: true, is_mock: true, mock_label: "Mock provider (development)",
    visibility: "personal", title: "Sample thread (mock data)", snippet: "snippet", participants: [], occurred_at: new Date(T0 - 30_000).toISOString(),
    unread: true, provider_unread: true, priority: "normal", assignee: null, labels: [], status: "open", group: { key: "gmail:x:from:a@example.com", label: "A" },
    muted: false, message_count: 1, has_attachments: false, external_url: "", open_label: "Open in Gmail",
    connection: { id: "c", provider: "gmail", account_label: "me@example.com", status: "connected" }, links: [], meta: {},
    capabilities: { change: true, link: true, reply: true, reply_unsupported_reason: "" }, ...over,
  } as ServerInboxItem;
}

function slack(id: string, at: number, unread = true): ServerInboxItem {
  return item({ id, source: "slack", source_label: "Slack", kind: "slack_message", origin: "external_message", visibility: "workspace",
                title: "#sales-mock", occurred_at: new Date(at).toISOString(), unread, group: { key: "slack:c:channel:C1", label: "#sales-mock" } });
}

describe("inbox merge", () => {
  it("merges native rooms and synced items newest first, without duplicates", () => {
    const native = fromNativeRooms([room(), room({ roomId: "!b:chatdev.test", name: "Team", lastTs: T0 - 10_000, unread: 0 })]);
    const server = fromServerItems([item()]);
    const merged = mergeInbox(native, server, server);
    expect(merged.map((e) => e.key)).toEqual(["native:!b:chatdev.test", "item:11111111-1111-1111-1111-111111111111", "native:!a:chatdev.test"]);
  });

  it("never presents a synced item as native, whatever the payload claims", () => {
    const [e] = fromServerItems([item({ origin: "native" as never })]);
    expect(e.origin).toBe("external_message");
    expect(e.external).toBe(true);
    const [n] = fromNativeRooms([room()]);
    expect(n.origin).toBe("native");
    expect(n.external).toBe(false);
  });

  it("keeps state features for synced items only", () => {
    const merged = mergeInbox(fromNativeRooms([room()]), fromServerItems([item({ priority: "high", labels: ["VIP"], assignee: { id: "me", username: "u", name: "Me", matrix_id: "" } })]));
    expect(filterEntries(merged, { source: "all", priority: "high" }).map((e) => e.source)).toEqual(["gmail"]);
    expect(filterEntries(merged, { source: "all", label: "VIP" })).toHaveLength(1);
    expect(filterEntries(merged, { source: "all", assignedTo: "me" })).toHaveLength(1);
    expect(filterEntries(merged, { source: "all" })).toHaveLength(2);
  });

  it("filters by source, unread and text (native previews are searched on this device only)", () => {
    const merged = mergeInbox(
      fromNativeRooms([room({ preview: "about the closing" }), room({ roomId: "!c:x", name: "Quiet", unread: 0, preview: "hi" })]),
      fromServerItems([item(), slack("22222222-2222-2222-2222-222222222222", T0, false)]),
    );
    expect(filterEntries(merged, { source: "chat" })).toHaveLength(2);
    expect(filterEntries(merged, { source: "email" }).map((e) => e.source)).toEqual(["gmail"]);
    expect(filterEntries(merged, { source: "slack" })).toHaveLength(1);
    expect(filterEntries(merged, { source: "all", unread: true }).map((e) => e.key)).toEqual(["item:11111111-1111-1111-1111-111111111111", "native:!a:chatdev.test"]);
    expect(filterEntries(merged, { source: "all", q: "closing" }).map((e) => e.key)).toEqual(["native:!a:chatdev.test"]);
  });

  it("turns native missed calls into notification entries", () => {
    const entries = fromNativeRooms([room({ missedCall: { video: true, ts: T0 - 5_000 } })]);
    expect(entries.map((e) => e.kind)).toEqual(["conversation", "missed_call"]);
    expect(entries[1].title).toBe("Missed video call · Avery");
    expect(filterEntries(entries, { source: "notifications" }).map((e) => e.kind)).toEqual(["missed_call"]);
  });

  it("skips rooms we left and shows invitations as unread", () => {
    const entries = fromNativeRooms([room({ membership: "leave" }), room({ roomId: "!i:x", membership: "invite", unread: 0 })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "invite", unread: true });
  });

  it("hides muted groups unless asked for", () => {
    const muted = new Set([nativeGroupKey("!a:chatdev.test")]);
    const merged = mergeInbox(fromNativeRooms([room()], muted), fromServerItems([item({ muted: true })]));
    expect(filterEntries(merged, { source: "all" })).toHaveLength(0);
    expect(filterEntries(merged, { source: "all", showMuted: true })).toHaveLength(2);
    expect(unreadTotal(merged)).toBe(0);
  });

  it("groups notification-like entries of one group into a single row", () => {
    const merged = mergeInbox(
      fromServerItems([slack("a1111111-1111-1111-1111-111111111111", T0 - 1000), slack("b1111111-1111-1111-1111-111111111111", T0 - 2000, false),
                       slack("c1111111-1111-1111-1111-111111111111", T0 - 3000)]),
      fromServerItems([item()]),
    );
    const grouped = groupEntries(merged);
    expect(grouped).toHaveLength(2);
    const head = grouped.find((e) => e.source === "slack")!;
    expect(head.groupCount).toBe(3);
    expect(head.unreadCount).toBe(2);
    expect(groupEntries(merged, false)).toHaveLength(4);
    // Email threads and chats are never collapsed.
    const emails = fromServerItems([item(), item({ id: "d1111111-1111-1111-1111-111111111111" })]);
    expect(groupEntries(emails)).toHaveLength(2);
  });

  it("maps workspace notifications and meeting follow-ups", () => {
    const n: WorkspaceNotification = { id: "n1", event_type: "task.assigned", title: "Task assigned", body: "Call back", link: "#/tasks", related: null,
                                       count: 3, read: false, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() };
    const [entry] = fromNotifications([n]);
    expect(entry).toMatchObject({ source: "nexus", origin: "workspace", unread: true, groupKey: notificationGroupKey(n) });
    expect(entry.preview).toContain("3 updates");
    const meetings = fromMeetings([
      { id: "m1", title: "Showing", end_at: new Date(T0 - 3_600_000).toISOString(), status: "scheduled", contact: { id: "c1", display_name: "Harper" } },
      { id: "m2", title: "Future", end_at: new Date(T0 + 3_600_000).toISOString(), status: "scheduled", contact: null },
      { id: "m3", title: "Done", end_at: new Date(T0 - 3_600_000).toISOString(), status: "completed", contact: null },
      { id: "m4", title: "Old", end_at: new Date(T0 - 9 * 86_400_000).toISOString(), status: "scheduled", contact: null },
    ], T0);
    expect(meetings.map((m) => m.title)).toEqual(["Follow up: Showing"]);
    expect(meetings[0].ref).toEqual({ type: "meeting", id: "m1", contactId: "c1" });
  });

  it("counts unread across sources", () => {
    const merged = mergeInbox(fromNativeRooms([room({ unread: 4 })]), fromServerItems([item(), slack("e1111111-1111-1111-1111-111111111111", T0, false)]));
    expect(unreadTotal(merged)).toBe(5);
  });
});

describe("adding a HighLevel lead to Nexus from the inbox", () => {
  const ghl = (over: Partial<ServerInboxItem> = {}) =>
    item({ source: "gohighlevel", source_label: "HighLevel", kind: "missed_call", origin: "external_notification", visibility: "workspace",
           title: "Missed call from Pat Mockperson", participants: [{ name: "Pat Mockperson", address: "pat.mock@example.org" }],
           meta: { contact_id: "mockContact02" }, ...over });

  it("offers it for a HighLevel item that names its contact and isn't linked to one yet, with the person's name", () => {
    expect(highLevelContactToAdd(ghl(), true)).toEqual({ id: "mockContact02", name: "Pat Mockperson" });
    expect(highLevelContactToAdd(ghl({ participants: [] }), true)).toEqual({ id: "mockContact02", name: "this contact" });
  });

  it("not for other sources, without a HighLevel contact, once linked, or without the right to create or link", () => {
    expect(highLevelContactToAdd(item({ meta: { contact_id: "x" } }), true)).toBeNull();
    expect(highLevelContactToAdd(ghl({ meta: {} }), true)).toBeNull();
    expect(highLevelContactToAdd(ghl({ meta: { contact_id: "  " } }), true)).toBeNull();
    const linked = [{ id: "l", target: { type: "crm.contact", id: "c", label: "Pat" }, created_by: null, created_at: "", on_timeline: true, permissions: { delete: true } }];
    expect(highLevelContactToAdd(ghl({ links: linked }), true)).toBeNull();
    const dealOnly = [{ ...linked[0], target: { type: "crm.opportunity", id: "o", label: "Deal" } }];
    expect(highLevelContactToAdd(ghl({ links: dealOnly }), true)?.id).toBe("mockContact02");
    expect(highLevelContactToAdd(ghl(), false)).toBeNull();
    expect(highLevelContactToAdd(ghl({ capabilities: { change: true, link: false, reply: false, reply_unsupported_reason: "" } }), true)).toBeNull();
  });
});
