import assert from "node:assert/strict";
import { test } from "node:test";
import { findAppLinkInArgv, routeDeepLink, safeEqual } from "../../src/core/deeplink.ts";
import { SsoCoordinator, SsoError, ssoRedirectUrl, SSO_TIMEOUT_MS } from "../../src/core/sso.ts";

const HS = "https://matrix.example.com";

function harness() {
  const opened: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let n = 0;
  const sso = new SsoCoordinator({
    openExternal: async (u) => {
      opened.push(u);
    },
    newNonce: () => `nonce${++n}`,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { sso, opened, timers };
}

test("ssoRedirectUrl builds the RFC 8252 redirect with the nonce inside redirectUrl", () => {
  assert.equal(
    ssoRedirectUrl(HS + "/", "oidc-lumen", "abc"),
    `${HS}/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=${encodeURIComponent("io.lumen.secure:/sso-callback?n=abc")}`,
  );
  assert.equal(ssoRedirectUrl(HS, null, "x"), `${HS}/_matrix/client/v3/login/sso/redirect?redirectUrl=io.lumen.secure%3A%2Fsso-callback%3Fn%3Dx`);
});

test("a callback with the pending nonce completes sign-in exactly once", async () => {
  const { sso, opened, timers } = harness();
  const p = sso.start(HS, "oidc-lumen", HS);
  assert.equal(opened.length, 1);
  const redirect = new URL(opened[0]!).searchParams.get("redirectUrl")!;
  assert.equal(redirect, "io.lumen.secure:/sso-callback?n=nonce1");
  // what the homeserver appends
  assert.equal(sso.handleCallback(`${redirect}&loginToken=syl_abc.DEF-123`), true);
  assert.equal(await p, "syl_abc.DEF-123");
  assert.equal(timers[0]!.cleared, true);
  // replay of the same callback is ignored: the nonce was single-use
  assert.equal(sso.handleCallback(`${redirect}&loginToken=syl_abc.DEF-123`), false);
});

test("stray callbacks (no attempt, wrong nonce, no token, other path) are ignored", async () => {
  const { sso } = harness();
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?n=nonce1&loginToken=t"), false, "no attempt pending");
  const p = sso.start(HS, null, HS);
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?loginToken=t"), false, "missing nonce");
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?n=nonce2&loginToken=t"), false, "wrong nonce");
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?n=nonce1"), false, "no token");
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?n=nonce1&loginToken=bad%20token"), false, "token charset");
  assert.equal(sso.handleCallback("io.lumen.secure:/elsewhere?n=nonce1&loginToken=t"), false, "other path");
  assert.equal(sso.handleCallback("https://evil.example/?n=nonce1&loginToken=t"), false, "other scheme");
  assert.equal(sso.pendingNonce, "nonce1", "still waiting");
  assert.equal(sso.handleCallback("io.lumen.secure://sso-callback?n=nonce1&loginToken=t"), true, "authority form");
  assert.equal(await p, "t");
});

test("a new attempt supersedes the old one; cancel and timeout reject", async () => {
  const { sso, timers } = harness();
  const first = sso.start(HS, "oidc-lumen", HS);
  const second = sso.start(HS, "oidc-lumen", HS);
  await assert.rejects(first, (e: unknown) => e instanceof SsoError && e.code === "superseded");
  assert.equal(sso.handleCallback("io.lumen.secure:/sso-callback?n=nonce1&loginToken=t"), false, "old nonce is dead");
  sso.cancel();
  await assert.rejects(second, (e: unknown) => e instanceof SsoError && e.code === "cancelled");
  const third = sso.start(HS, "oidc-lumen", HS);
  const t = timers.at(-1)!;
  assert.equal(t.ms, SSO_TIMEOUT_MS);
  t.fn();
  await assert.rejects(third, (e: unknown) => e instanceof SsoError && e.code === "timeout");
  assert.equal(sso.pendingNonce, null);
});

test("the renderer can only start SSO at the configured homeserver with a valid IdP id", async () => {
  const { sso, opened } = harness();
  await assert.rejects(sso.start("https://evil.example", "oidc-lumen", HS), { code: "invalid_request" });
  await assert.rejects(sso.start(HS, "../../evil", HS), { code: "invalid_request" });
  await assert.rejects(sso.start(HS, 42 as unknown as string, HS), { code: "invalid_request" });
  assert.equal(opened.length, 0);
});

test("browser failing to open rejects the attempt", async () => {
  const sso = new SsoCoordinator({
    openExternal: () => Promise.reject(new Error("no browser")),
    newNonce: () => "n",
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  await assert.rejects(sso.start(HS, null, HS), { code: "open_failed" });
});

test("findAppLinkInArgv: Windows/Linux deliver the URL as an argument", () => {
  assert.equal(findAppLinkInArgv(["/opt/Lumen/lumen", "--flag", "io.lumen.secure:/sso-callback?n=a"]), "io.lumen.secure:/sso-callback?n=a");
  assert.equal(findAppLinkInArgv(["C:\\Lumen\\Lumen Secure.exe", "IO.LUMEN.SECURE:/sso-callback"]), "IO.LUMEN.SECURE:/sso-callback");
  assert.equal(findAppLinkInArgv(["/opt/Lumen/lumen", "--io.lumen.secure:/x", "https://x"]), null);
});

test("safeEqual and routeDeepLink edge cases", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.deepEqual(routeDeepLink("https://matrix.to/#/%40bob%3Aexample.org", null), { type: "user", id: "@bob:example.org" });
  assert.deepEqual(routeDeepLink("https://matrix.to:8443/#/@bob:example.org", null), { type: "reject" });
  assert.deepEqual(routeDeepLink("matrix:u/bob", null), { type: "reject" });
  assert.deepEqual(routeDeepLink("matrix:x/bob:example.org", null), { type: "reject" });
  assert.deepEqual(routeDeepLink("x".repeat(5000), null), { type: "reject" });
  // room version 12: room IDs have no server part
  assert.deepEqual(routeDeepLink("https://matrix.to/#/!-MOADax__CI4aq6hI_3NCx71nCQaGGqteq4OqMXcY64", null), { type: "room", id: "!-MOADax__CI4aq6hI_3NCx71nCQaGGqteq4OqMXcY64" });
  assert.deepEqual(routeDeepLink("https://matrix.to/#/!a", null), { type: "reject" });
});
