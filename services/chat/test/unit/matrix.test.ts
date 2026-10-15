import { describe, expect, it, vi } from "vitest";
import { MatrixError, MatrixEvent } from "matrix-js-sdk";
import { appRedirectUrl, deviceDisplayName, extractLoginToken, ssoRedirectUrl } from "../../src/matrix/login";
import { editContent, reactionContent, textContent } from "../../src/matrix/send";
import { chooseStage, setUiaPrompt, ssoFallbackUrl, UiaCancelledError, withUia } from "../../src/matrix/uia";
import { buildTimeline, noticeText } from "../../src/matrix/timeline";
import { inlineKind, msgtypeFor } from "../../src/matrix/media";

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

  it("describes membership and encryption state events", () => {
    const m = ev("m.room.member", "@a:x", 1, { membership: "invite", displayname: "Bob" }, { state_key: "@b:x" });
    expect(noticeText(m, nameOf)).toBe("A invited Bob");
    const enc = ev("m.room.encryption", "@a:x", 2, { algorithm: "m.megolm.v1.aes-sha2" }, { state_key: "" });
    expect(noticeText(enc, nameOf)).toMatch(/End-to-end encryption is enabled/);
    const pl = ev("m.room.power_levels", "@a:x", 3, {}, { state_key: "" });
    expect(noticeText(pl, nameOf)).toBeNull();
  });
});

describe("call media protection (from getStats)", async () => {
  const { summariseTransportStats, formatDuration } = await import("../../src/matrix/calls");
  it("reports protected media only with a connected DTLS transport and an SRTP cipher", () => {
    const stats = [
      { type: "transport", id: "T1", dtlsState: "connected", srtpCipher: "AES_CM_128_HMAC_SHA1_80", dtlsCipher: "TLS_ECDHE", tlsVersion: "FEFD", selectedCandidatePairId: "P1" },
      { type: "candidate-pair", id: "P1", localCandidateId: "L1", state: "succeeded" },
      { type: "local-candidate", id: "L1", candidateType: "relay" },
    ];
    expect(summariseTransportStats(stats)).toEqual({
      dtlsState: "connected",
      srtpCipher: "AES_CM_128_HMAC_SHA1_80",
      dtlsCipher: "TLS_ECDHE",
      tlsVersion: "FEFD",
      relayed: true,
      protectedMedia: true,
    });
    expect(summariseTransportStats([{ type: "transport", dtlsState: "connecting" }]).protectedMedia).toBe(false);
    expect(summariseTransportStats([{ type: "transport", dtlsState: "connected" }]).protectedMedia).toBe(false);
    expect(summariseTransportStats([]).protectedMedia).toBe(false);
  });
  it("formats call durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
