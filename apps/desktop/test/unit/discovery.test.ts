import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brandOf,
  discoverServer,
  DiscoveryError,
  parseBuildConfig,
  parseRtcTransports,
  parseServerInput,
  parseStoredProfile,
  toWebClientConfig,
  type FetchResult,
} from "../../src/core/discovery.ts";

const LUMEN_WK = {
  "m.homeserver": { base_url: "https://matrix.example.com" },
  "io.lumen.app": {
    version: 1,
    brand: { name: "Acme Secure", short_name: "Acme" },
    portal_url: "https://example.com",
    signup_url: "https://example.com/accounts/signup/",
    privacy_url: "https://example.com/privacy/",
    help_url: "https://example.com/docs/",
    sso_idp_id: "oidc-lumen",
  },
};

function fakeServer(routes: Record<string, FetchResult | Error>) {
  const seen: string[] = [];
  return {
    seen,
    deps: {
      debug: false,
      now: () => new Date("2026-10-15T00:00:00Z"),
      async fetchJson(url: string): Promise<FetchResult> {
        seen.push(url);
        const r = routes[url];
        if (r instanceof Error) throw r;
        return r ?? { status: 404, json: undefined };
      },
    },
  };
}

const HS = "https://matrix.example.com";
const OK_ROUTES = {
  "https://example.com/.well-known/matrix/client": { status: 200, json: LUMEN_WK },
  [`${HS}/_matrix/client/versions`]: { status: 200, json: { versions: ["v1.11"] } },
  [`${HS}/_matrix/client/v3/login`]: {
    status: 200,
    json: { flows: [{ type: "m.login.sso", identity_providers: [{ id: "other", name: "Other" }, { id: "oidc-lumen", name: "Acme" }] }, { type: "m.login.token" }] },
  },
  [`${HS}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`]: { status: 401, json: { errcode: "M_MISSING_TOKEN" } },
};

test("parseServerInput accepts server names, Matrix IDs and https URLs", () => {
  assert.equal(parseServerInput("Example.COM"), "example.com");
  assert.equal(parseServerInput(" example.com:8448 "), "example.com:8448");
  assert.equal(parseServerInput("@alice:example.com"), "example.com");
  assert.equal(parseServerInput("https://example.com/whatever"), "example.com");
  for (const bad of ["", "http://example.com", "exa mple.com", "example..com", "-x.com", "@alice", "https://u:p@example.com", "example.com/path", "example.com:99999"]) {
    assert.throws(() => parseServerInput(bad), DiscoveryError, bad);
  }
});

test("discoverServer: Lumen server with io.lumen.app, SSO provider from the block, rtc needs auth", async () => {
  const { deps, seen } = fakeServer(OK_ROUTES);
  const p = await discoverServer("example.com", deps);
  assert.equal(p.homeserverUrl, HS);
  assert.equal(p.serverName, "example.com");
  assert.deepEqual(p.sso, { idpId: "oidc-lumen", name: "Acme" });
  assert.equal(p.passwordLogin, false);
  assert.deepEqual(p.rtc, { status: "auth-required", livekitUrls: [] });
  assert.equal(p.lumen?.brand_name, "Acme Secure");
  assert.ok(seen.every((u) => u.startsWith("https://")), "only https requests");
  const cfg = toWebClientConfig(p);
  assert.deepEqual(cfg, {
    brand: { name: "Acme Secure", short_name: "Acme" },
    homeserver: { base_url: HS, server_name: "example.com" },
    sso: { idp_id: "oidc-lumen", label: "Continue with your Acme account" },
    portal_url: "https://example.com/accounts/signup/",
    allow_custom_homeserver: false,
    calls: { enabled: false, rtc_domain: null },
    privacy_url: "https://example.com/privacy/",
    help_url: "https://example.com/docs/",
  });
});

test("discoverServer: advertised livekit transports enable calls", async () => {
  const { deps } = fakeServer({
    ...OK_ROUTES,
    [`${HS}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`]: {
      status: 200,
      json: { rtc_transports: [{ type: "livekit", url: "wss://rtc.example.com" }, { type: "livekit", url: "ws://rtc.example.com" }, { type: "other", url: "wss://x" }] },
    },
  });
  const p = await discoverServer("example.com", deps);
  assert.deepEqual(p.rtc, { status: "advertised", livekitUrls: ["wss://rtc.example.com"] });
  assert.deepEqual(toWebClientConfig(p).calls, { enabled: true, rtc_domain: "rtc.example.com" });
});

test("discoverServer: plain Matrix server without well-known falls back to https://<name>", async () => {
  const { deps } = fakeServer({
    "https://plain.org/_matrix/client/versions": { status: 200, json: { versions: ["v1.1"] } },
    "https://plain.org/_matrix/client/v3/login": { status: 200, json: { flows: [{ type: "m.login.password" }] } },
  });
  const p = await discoverServer("plain.org", deps);
  assert.equal(p.homeserverUrl, "https://plain.org");
  assert.equal(p.lumen, null);
  assert.equal(p.sso, null);
  assert.equal(p.passwordLogin, true);
  assert.deepEqual(brandOf(p), { name: "Lumen Secure", shortName: "Lumen" });
  assert.equal(toWebClientConfig(p).sso, null);
});

test("discoverServer: errors", async () => {
  await assert.rejects(discoverServer("down.org", fakeServer({ "https://down.org/.well-known/matrix/client": new Error("ECONNREFUSED") }).deps), { code: "unreachable" });
  await assert.rejects(
    discoverServer("evil.org", fakeServer({ "https://evil.org/.well-known/matrix/client": { status: 200, json: { "m.homeserver": { base_url: "http://evil.org" } } } }).deps),
    { code: "invalid_wellknown" },
  );
  await assert.rejects(
    discoverServer(
      "web.org",
      fakeServer({ "https://web.org/.well-known/matrix/client": { status: 200, json: { "m.homeserver": { base_url: "https://web.org" } } }, "https://web.org/_matrix/client/versions": { status: 200, json: "<html>" } }).deps,
    ),
    { code: "not_matrix" },
  );
  await assert.rejects(
    discoverServer(
      "nologin.org",
      fakeServer({
        "https://nologin.org/_matrix/client/versions": { status: 200, json: { versions: [] } },
        "https://nologin.org/_matrix/client/v3/login": { status: 200, json: { flows: [{ type: "m.login.application_service" }] } },
      }).deps,
    ),
    { code: "no_login" },
  );
});

test("toWebClientConfig output is accepted by the web client's own parser rules", async () => {
  const { deps } = fakeServer(OK_ROUTES);
  const cfg = toWebClientConfig(await discoverServer("example.com", deps)) as { homeserver: { base_url: string; server_name: string }; sso: { idp_id: string } };
  assert.match(cfg.homeserver.server_name, /^[A-Za-z0-9.\-:[\]]+$/);
  assert.match(cfg.sso.idp_id, /^[A-Za-z0-9._~-]{1,255}$/);
  assert.ok(cfg.homeserver.base_url.startsWith("https://") && !cfg.homeserver.base_url.endsWith("/"));
});

test("io.lumen.app account_delete_url is parsed and validated like the other links", async () => {
  const { parseWellKnown } = await import("../../src/core/discovery.ts");
  const ok = parseWellKnown({ "m.homeserver": { base_url: HS }, "io.lumen.app": { version: 1, account_delete_url: "https://example.com/portal/privacy/delete/" } });
  assert.ok("lumen" in ok && ok.lumen?.account_delete_url === "https://example.com/portal/privacy/delete/");
  const bad = parseWellKnown({ "m.homeserver": { base_url: HS }, "io.lumen.app": { version: 1, account_delete_url: "http://example.com/delete/" } });
  assert.ok("lumen" in bad && bad.lumen?.account_delete_url === null);
});

test("parseRtcTransports keeps at most 4 valid wss URLs", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ type: "livekit", url: `wss://rtc${i}.example.com` }));
  assert.equal(parseRtcTransports({ rtc_transports: many }, { debug: false }).length, 4);
  assert.deepEqual(parseRtcTransports({ rtc_transports: [{ type: "livekit", url: "wss://u:p@x.org" }] }, { debug: false }), []);
  assert.deepEqual(parseRtcTransports("nope", { debug: false }), []);
  assert.deepEqual(parseRtcTransports({ rtc_transports: [{ type: "livekit", url: "ws://localhost:7880" }] }, { debug: true }), ["ws://localhost:7880"]);
});

test("parseStoredProfile re-validates a tampered server.json", async () => {
  const { deps } = fakeServer(OK_ROUTES);
  const p = await discoverServer("example.com", deps);
  assert.deepEqual(parseStoredProfile(JSON.parse(JSON.stringify(p)), { debug: false }), p);
  assert.equal(parseStoredProfile({ ...p, homeserverUrl: "http://matrix.example.com" }, { debug: false }), null);
  assert.equal(parseStoredProfile({ ...p, serverName: "bad name" }, { debug: false }), null);
  const t = parseStoredProfile({ ...p, rtc: { status: "advertised", livekitUrls: ["wss://ok.example", "https://not-wss.example"] }, lumen: { ...p.lumen, help_url: "javascript:alert(1)" } }, { debug: false });
  assert.deepEqual(t?.rtc.livekitUrls, ["wss://ok.example"]);
  assert.equal(t?.lumen?.help_url, null);
});

test("parseBuildConfig: LUMEN_DEFAULT_SERVER is a server name, empty means ask", () => {
  assert.deepEqual(parseBuildConfig({ default_server: "Lumen.Test" }), { defaultServer: "lumen.test" });
  assert.deepEqual(parseBuildConfig({ default_server: "" }), { defaultServer: null });
  assert.deepEqual(parseBuildConfig({ default_server: "http://x" }), { defaultServer: null });
  assert.deepEqual(parseBuildConfig(null), { defaultServer: null });
});
