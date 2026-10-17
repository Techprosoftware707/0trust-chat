import { describe, expect, it, vi } from "vitest";
import { MatrixError, MatrixEvent } from "matrix-js-sdk";
import { appRedirectUrl, deviceDisplayName, extractLoginToken, ssoRedirectUrl } from "../../src/matrix/login";
import { editContent, reactionContent, textContent } from "../../src/matrix/send";
import { chooseStage, setUiaPrompt, ssoFallbackUrl, UiaCancelledError, withUia } from "../../src/matrix/uia";
import { buildTimeline, noticeText } from "../../src/matrix/timeline";
import { inlineKind, msgtypeFor } from "../../src/matrix/media";
import { blockUser, canBlock, unblockUser } from "../../src/matrix/block";

describe("SSO login URLs", () => {
  it("builds the homeserver SSO redirect URL for the configured IdP", () => {
    expect(ssoRedirectUrl("https://matrix.example.com/", "oidc-lumen", appRedirectUrl({ origin: "https://app.example.com" }))).toBe(
      "https://matrix.example.com/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=https%3A%2F%2Fapp.example.com%2F",
    );
    expect(ssoRedirectUrl("https://m.x", null, "https://a.x/")).toBe("https://m.x/_matrix/client/v3/login/sso/redirect?redirectUrl=https%3A%2F%2Fa.x%2F");
  });

  it("extracts and removes the login token from the URL", () => {
    expect(extractLoginToken("https://app.x/?loginToken=abc123")).toEqual({ token: "abc123", cleanedUrl: "/" });
    expect(extractLoginToken("https://app.x/?a=1&loginToken=t#/dm/%40b%3Ax")).toEqual({ token: "t", cleanedUrl: "/?a=1#/dm/%40b%3Ax" });
    expect(extractLoginToken("https://app.x/#/room/!r").token).toBeNull();
  });

  it("names the device after the brand and browser", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(deviceDisplayName("Lumen", ua)).toBe("Lumen Web (Chrome on Linux)");
  });
});

describe("outgoing content", () => {
  it("sends plain text without HTML", () => {
    expect(textContent("hello https://x.org")).toEqual({ msgtype: "m.text", body: "hello https://x.org", "m.mentions": {} });
  });
  it("adds escaped formatted_body only when there is formatting", () => {
    const c = textContent("**hi** <script>");
    expect(c.format).toBe("org.matrix.custom.html");
    expect(c.formatted_body).toBe("<p><strong>hi</strong> &lt;script&gt;</p>");
  });
  it("builds replies without fallbacks", () => {
    expect(textContent("yes", "$orig")["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig" } });
  });
  it("builds edits", () => {
    const e = editContent("$orig", "fixed");
    expect(e.body).toBe("* fixed");
    expect(e["m.new_content"]).toEqual({ msgtype: "m.text", body: "fixed", "m.mentions": {} });
    expect(e["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" });
  });
  it("builds reactions", () => {
    expect(reactionContent("$e", "👍")).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: "$e", key: "👍" } });
  });
});

describe("attachments", () => {
  it("only previews safe raster/media types inline", () => {
    expect(inlineKind("image/png")).toBe("image");
    expect(inlineKind("image/svg+xml")).toBeNull();
    expect(inlineKind("text/html")).toBeNull();
    expect(inlineKind("video/mp4")).toBe("video");
    expect(msgtypeFor("image/jpeg")).toBe("m.image");
    expect(msgtypeFor("image/svg+xml")).toBe("m.file");
    expect(msgtypeFor("application/pdf")).toBe("m.file");
  });
});

describe("user-interactive auth", () => {
  const uiaError = (extra: object = {}) =>
    new MatrixError({ errcode: "M_FORBIDDEN", error: "auth", session: "S1", flows: [{ stages: ["m.login.password"] }], ...extra }, 401);
  const client = { getSafeUserId: () => "@me:x", getHomeserverUrl: () => "https://m.x" } as never;

  it("chooses supported single-stage flows", () => {
    expect(chooseStage([{ stages: ["m.login.password"] }, { stages: ["m.login.sso"] }])).toBe("m.login.password");
    expect(chooseStage([{ stages: ["m.login.sso"] }])).toBe("m.login.sso");
    expect(chooseStage([{ stages: ["m.login.recaptcha", "m.login.password"] }])).toBeNull();
    expect(ssoFallbackUrl("https://m.x/", "a b")).toBe("https://m.x/_matrix/client/v3/auth/m.login.sso/fallback/web?session=a%20b");
  });

  it("retries with the password the user enters", async () => {
    setUiaPrompt(async () => "hunter2");
    const make = vi.fn(async (auth: unknown) => {
      if (!auth) throw uiaError();
      return "ok";
    });
    await expect(withUia(client, "Do it", make)).resolves.toBe("ok");
    expect(make).toHaveBeenLastCalledWith({ type: "m.login.password", identifier: { type: "m.id.user", user: "@me:x" }, password: "hunter2", session: "S1" });
  });

  it("supports the SSO fallback stage", async () => {
    const prompts: unknown[] = [];
    setUiaPrompt(async (req) => {
      prompts.push(req);
      return true;
    });
    const make = vi.fn(async (auth: unknown) => {
      if (!auth) throw uiaError({ flows: [{ stages: ["m.login.sso"] }] });
      return "done";
    });
    await expect(withUia(client, "Sign out devices", make)).resolves.toBe("done");
    expect(make).toHaveBeenLastCalledWith({ session: "S1" });
    expect(prompts[0]).toMatchObject({ kind: "sso", fallbackUrl: "https://m.x/_matrix/client/v3/auth/m.login.sso/fallback/web?session=S1" });
  });

  it("stops when the user cancels and passes through non-UIA errors", async () => {
    setUiaPrompt(async () => null);
    await expect(withUia(client, "x", async (auth) => { if (!auth) throw uiaError(); return 1; })).rejects.toBeInstanceOf(UiaCancelledError);
    await expect(withUia(client, "x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

describe("timeline building", () => {
  const ev = (type: string, sender: string, ts: number, content: object, extra: object = {}) =>
    new MatrixEvent({ type, sender, origin_server_ts: ts, content, event_id: `$${ts}`, room_id: "!r:x", ...extra });
  const nameOf = (u: string) => u.slice(1, 2).toUpperCase();

  it("groups consecutive messages and inserts day separators", () => {
    const d1 = new Date(2026, 9, 14, 10, 0).getTime();
    const d2 = new Date(2026, 9, 15, 9, 0).getTime();
    const items = buildTimeline(
      [
        ev("m.room.message", "@a:x", d1, { msgtype: "m.text", body: "1" }),
        ev("m.room.message", "@a:x", d1 + 60_000, { msgtype: "m.text", body: "2" }),
        ev("m.room.message", "@b:x", d1 + 120_000, { msgtype: "m.text", body: "3" }),
        ev("m.room.message", "@b:x", d1 + 120_000 + 6 * 60_000, { msgtype: "m.text", body: "4" }),
        ev("m.room.message", "@b:x", d2, { msgtype: "m.text", body: "5" }),
        ev("m.reaction", "@a:x", d2 + 1, { "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" } }),
        ev("m.room.message", "@a:x", d2 + 2, { msgtype: "m.text", body: "* edit", "m.new_content": {}, "m.relates_to": { rel_type: "m.replace", event_id: "$x" } }),
      ],
      nameOf,
    );
    expect(items.map((i) => (i.kind === "message" ? `${(i.event.getContent() as { body: string }).body}${i.continuation ? "+" : ""}` : i.kind))).toEqual([
      "day",
      "1",
      "2+",
      "3",
      "4",
      "day",
      "5",
    ]);
  });

  it("hides messages from blocked senders but keeps their membership changes", () => {
    const d = new Date(2026, 9, 14, 10, 0).getTime();
    const items = buildTimeline(
      [
        ev("m.room.message", "@a:x", d, { msgtype: "m.text", body: "from a" }),
        ev("m.room.message", "@spam:x", d + 1, { msgtype: "m.text", body: "from spam" }),
        ev("m.reaction", "@spam:x", d + 2, { "m.relates_to": { rel_type: "m.annotation", event_id: `$${d}`, key: "x" } }),
        ev("m.room.member", "@spam:x", d + 3, { membership: "leave" }, { state_key: "@spam:x" }),
        ev("m.room.message", "@a:x", d + 4, { msgtype: "m.text", body: "again a" }),
      ],
      nameOf,
      undefined,
      new Set(["@spam:x"]),
    );
    const shown = items.filter((i) => i.kind !== "day").map((i) => (i.kind === "message" ? (i.event.getContent() as { body: string }).body : i.kind));
    expect(shown).toEqual(["from a", "notice", "again a"]);
  });

  it("describes membership and encryption state events", () => {
    const m = ev("m.room.member", "@a:x", 1, { membership: "invite", displayname: "Bob" }, { state_key: "@b:x" });
    expect(noticeText(m, nameOf)).toBe("A invited Bob");
    const enc = ev("m.room.encryption", "@a:x", 2, { algorithm: "m.megolm.v1.aes-sha2" }, { state_key: "" });
    expect(noticeText(enc, nameOf)).toMatch(/End-to-end encryption is enabled/);
    const pl = ev("m.room.power_levels", "@a:x", 3, {}, { state_key: "" });
    expect(noticeText(pl, nameOf)).toBeNull();
  });
});


describe("blocking (m.ignored_user_list)", () => {
  const fakeClient = (initial: string[]) => {
    let list = [...initial];
    return {
      getUserId: () => "@me:x",
      getIgnoredUsers: () => list,
      setIgnoredUsers: vi.fn(async (next: string[]) => {
        list = next;
        return {};
      }),
    };
  };

  it("adds and removes one user, keeping the others", async () => {
    const c = fakeClient(["@old:x"]);
    await blockUser(c as never, "@spam:x");
    expect(c.setIgnoredUsers).toHaveBeenLastCalledWith(["@old:x", "@spam:x"]);
    await blockUser(c as never, "@spam:x"); // already blocked: no second write
    expect(c.setIgnoredUsers).toHaveBeenCalledTimes(1);
    await unblockUser(c as never, "@spam:x");
    expect(c.setIgnoredUsers).toHaveBeenLastCalledWith(["@old:x"]);
    await unblockUser(c as never, "@nobody:x");
    expect(c.setIgnoredUsers).toHaveBeenCalledTimes(2);
  });

  it("refuses to block yourself or something that isn't a user ID", async () => {
    const c = fakeClient([]);
    expect(canBlock(c as never, "@me:x")).toBe(false);
    expect(canBlock(c as never, "!room:x")).toBe(false);
    expect(canBlock(c as never, "@bob:x")).toBe(true);
    await expect(blockUser(c as never, "@me:x")).rejects.toThrow();
    expect(c.setIgnoredUsers).not.toHaveBeenCalled();
  });
});

describe("previews of messages this device can't decrypt", () => {
  async function utd(code: string): Promise<MatrixEvent> {
    const { DecryptionError } = await import("matrix-js-sdk/lib/common-crypto/CryptoBackend.js");
    const ev = new MatrixEvent({
      type: "m.room.encrypted",
      sender: "@a:x",
      event_id: "$utd",
      room_id: "!r:x",
      origin_server_ts: 1,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", session_id: "s", sender_key: "k", device_id: "D" },
    });
    const crypto = { decryptEvent: async () => Promise.reject(new DecryptionError(code as never, "test")) };
    await ev.attemptDecryption(crypto as never);
    return ev;
  }

  it("say the key may still arrive only when it may (unknown session), never alarmist", async () => {
    const { previewText } = await import("../../src/matrix/rooms");
    expect(previewText(await utd("MEGOLM_UNKNOWN_INBOUND_SESSION_ID"), "@me:x")).toBe("Encrypted message · waiting for its key");
    expect(previewText(await utd("HISTORICAL_MESSAGE_NO_KEY_BACKUP"), "@me:x")).toBe("Encrypted message");
    for (const code of ["MEGOLM_UNKNOWN_INBOUND_SESSION_ID", "UNKNOWN_ERROR"]) {
      expect(previewText(await utd(code), "@me:x")).not.toMatch(/unable|fail|error/i);
    }
  });
});

describe("timeline runs", () => {
  it("puts consecutive call items in one card and consecutive notices in one block", async () => {
    const { groupRuns } = await import("../../src/matrix/timeline");
    const e = new MatrixEvent({ type: "m.room.message", sender: "@a:x", event_id: "$m", content: { msgtype: "m.text", body: "hi" } });
    const call = (k: string) => ({ kind: "call" as const, key: k, event: e, marker: { kind: "call-declined" as const, sender: "@a:x" } });
    const notice = (k: string) => ({ kind: "notice" as const, key: k, event: e, text: k });
    const blocks = groupRuns([notice("n1"), notice("n2"), call("c1"), call("c2"), call("c3"), { kind: "message", key: "m", event: e, continuation: false }, call("c4")]);
    expect(blocks.map((b) => (b.kind === "call-run" || b.kind === "notice-run" ? `${b.kind}:${b.items.length}` : b.kind))).toEqual([
      "notice-run:2",
      "call-run:3",
      "message",
      "call-run:1",
    ]);
  });
});
