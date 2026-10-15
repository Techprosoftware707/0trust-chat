import { describe, expect, it } from "vitest";
import { formatBytes, formatDayLabel, formatRelative, initials, isSameDay } from "../../src/lib/format";
import { isValidUserId, normaliseUserIdInput, parseRoute, roomHash } from "../../src/lib/matrix-id";
import { parsePrefs, DEFAULT_PREFS } from "../../src/lib/prefs";

describe("format", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });

  it("labels days", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    expect(formatDayLabel(new Date(2026, 9, 15, 0, 5).getTime(), now)).toBe("Today");
    expect(formatDayLabel(new Date(2026, 9, 14, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(formatDayLabel(new Date(2026, 9, 12).getTime(), now, "en-US")).toBe("Monday");
    expect(formatDayLabel(new Date(2025, 0, 2).getTime(), now, "en-US")).toContain("2025");
  });

  it("compares days", () => {
    expect(isSameDay(new Date(2026, 1, 1, 0, 1).getTime(), new Date(2026, 1, 1, 23, 59).getTime())).toBe(true);
    expect(isSameDay(new Date(2026, 1, 1, 23, 59).getTime(), new Date(2026, 1, 2, 0, 0).getTime())).toBe(false);
  });

  it("formats relative times", () => {
    const now = 1_000_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe("Just now");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelative(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatRelative(undefined, now)).toBe("Unknown");
  });

  it("derives avatar initials", () => {
    expect(initials("alice")).toBe("A");
    expect(initials("@bob:example.org")).toBe("B");
    expect(initials("élodie")).toBe("É");
    expect(initials("")).toBe("?");
  });
});

describe("matrix ids and routes", () => {
  it("validates user ids", () => {
    expect(isValidUserId("@alice:example.org")).toBe(true);
    expect(isValidUserId("@alice:example.org:8448")).toBe(true);
    expect(isValidUserId("alice")).toBe(false);
    expect(isValidUserId("@al ice:example.org")).toBe(false);
  });

  it("normalises user input", () => {
    expect(normaliseUserIdInput("alice", "example.org")).toBe("@alice:example.org");
    expect(normaliseUserIdInput("@bob", "example.org")).toBe("@bob:example.org");
    expect(normaliseUserIdInput("@carol:other.net", "example.org")).toBe("@carol:other.net");
    expect(normaliseUserIdInput("not valid!", "example.org")).toBeNull();
  });

  it("parses deep links, including percent-encoded ones from the portal", () => {
    expect(parseRoute("#/dm/@alice:example.org")).toEqual({ kind: "dm", userId: "@alice:example.org" });
    expect(parseRoute("#/dm/%40alice%3Aexample.org")).toEqual({ kind: "dm", userId: "@alice:example.org" });
    expect(parseRoute("#/room/" + encodeURIComponent("!abc:example.org"))).toEqual({ kind: "room", roomId: "!abc:example.org" });
    expect(parseRoute("#/dm/not-a-user").kind).toBe("invalid");
    expect(parseRoute("#/dm/%E0%A4%A").kind).toBe("invalid");
    expect(parseRoute("")).toEqual({ kind: "home" });
    expect(parseRoute("#/whatever")).toEqual({ kind: "home" });
    expect(roomHash("!a:b")).toBe("#/room/!a%3Ab");
  });
});

describe("prefs", () => {
  it("defaults to private settings and ignores junk", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.notificationPreviews).toBe(false);
    expect(DEFAULT_PREFS.notifications).toBe(false);
    expect(parsePrefs("{bad json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ notifications: "yes", sendReadReceipts: false }))).toEqual({ ...DEFAULT_PREFS, sendReadReceipts: false });
  });
});
