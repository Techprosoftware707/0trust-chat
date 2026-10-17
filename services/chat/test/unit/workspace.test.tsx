import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseConfig, parseWorkspace, type WorkspaceConfig } from "../../src/config";
import { WorkspaceAuth, pkceChallenge } from "../../src/workspace/auth";
import { ApiError, WorkspaceApi, describeError } from "../../src/workspace/api";
import { BUILTIN_PANELS, allAreas, allRoomPanels, areaHash, defineArea, findArea, isAreaVisible, parseWorkspaceRoute } from "../../src/workspace/registry";
import { EnvBanner, envLabel, withEnvPrefix } from "../../src/workspace/Shell";
import { ComingSoon, formatMoney, formatWhen, fromLocalInput, toLocalInput } from "../../src/workspace/ui";
import type { WorkspaceDetail } from "../../src/workspace/types";
import { House } from "lucide-react";

const CFG: WorkspaceConfig = {
  apiUrl: "https://example.com/api/v1",
  clientId: "nexus-web",
  authorizeUrl: "https://example.com/identity/o/authorize",
  tokenUrl: "https://example.com/identity/o/api/token",
  revokeUrl: "https://example.com/identity/o/api/revoke",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("workspace config", () => {
  it("derives the OAuth endpoints from the portal", () => {
    expect(parseWorkspace({ api_url: "https://example.com/api/v1/", client_id: "nexus-web" }, "https://example.com/")).toEqual(CFG);
  });
  it("disables the workspace instead of breaking chat when the block is malformed", () => {
    expect(parseWorkspace(undefined, null)).toBeNull();
    expect(parseWorkspace({}, null)).toBeNull();
    expect(parseWorkspace({ api_url: "http://example.com/api/v1" }, null)).toBeNull(); // http only on loopback
    expect(parseWorkspace({ api_url: "https://example.com/api/v1", client_id: "bad id!" }, null)).toBeNull();
    expect(parseWorkspace({ api_url: "https://example.com/api/v1", token_url: "javascript:x" }, null)).toBeNull();
  });
  it("allows loopback http for the local test environment and explicit endpoints", () => {
    const w = parseWorkspace({ api_url: "http://127.0.0.1:8710/api/v1", token_url: "http://127.0.0.1:8710/t" }, "http://127.0.0.1:8710");
    expect(w?.authorizeUrl).toBe("http://127.0.0.1:8710/identity/o/authorize");
    expect(w?.tokenUrl).toBe("http://127.0.0.1:8710/t");
  });
  it("reads the environment", () => {
    const base = { homeserver: { base_url: "https://m.example.com", server_name: "example.com" } };
    expect(parseConfig({ ...base, environment: "test" }).environment).toBe("test");
    expect(parseConfig({ ...base, environment: "development" }).environment).toBe("development");
    expect(parseConfig({ ...base, environment: "staging" }).environment).toBe("production");
    expect(parseConfig(base).workspace).toBeNull();
  });
});

describe("environment banner", () => {
  it("labels test and development builds and stays silent in production", () => {
    expect(envLabel("test")).toBe("Test");
    expect(withEnvPrefix("Nexus Office AI", "test")).toBe("[Test] Nexus Office AI");
    expect(withEnvPrefix("Nexus Office AI", "production")).toBe("Nexus Office AI");
    const html = renderToStaticMarkup(<EnvBanner env="test" />);
    expect(html).toContain("Test environment");
    expect(html).toContain("synthetic demo data");
    expect(renderToStaticMarkup(<EnvBanner env="production" />)).toBe("");
  });
});

describe("route and feature registry", () => {
  it("parses workspace routes and leaves chat routes alone", () => {
    expect(parseWorkspaceRoute("")).toEqual({ kind: "chat" });
    expect(parseWorkspaceRoute("#/")).toEqual({ kind: "chat" });
    expect(parseWorkspaceRoute("#/room/!abc:example.com")).toEqual({ kind: "chat" });
    expect(parseWorkspaceRoute("#/dm/@a:example.com")).toEqual({ kind: "chat" });
    expect(parseWorkspaceRoute("#/contacts")).toEqual({ kind: "area", area: "contacts", path: [] });
    expect(parseWorkspaceRoute("#/contacts/abc/edit")).toEqual({ kind: "area", area: "contacts", path: ["abc", "edit"] });
    expect(parseWorkspaceRoute("#/tasks/a%2Fb")).toEqual({ kind: "area", area: "tasks", path: ["a/b"] });
    expect(areaHash("contacts", "a/b")).toBe("#/contacts/a%2Fb");
  });

  it("discovers every nav entry, in order, ready ones with a component", () => {
    const ids = allAreas().map((a) => a.id);
    expect(ids).toEqual(["home", "notifications", "inbox", "calls", "contacts", "crm", "pipelines", "properties", "lending", "tasks", "calendar", "assistant", "reports",
      "integrations", "automations", "settings"]);
    for (const a of allAreas()) {
      if (a.status === "ready") expect(a.component, a.id).toBeTypeOf("function");
      expect(a.summary.length, a.id).toBeGreaterThan(10);
    }
    // Inbox and Integrations are delivered (integrations team): nothing is a placeholder any more.
    expect(allAreas().filter((a) => a.status === "coming_soon").map((a) => a.id)).toEqual([]);
    expect(allRoomPanels().map((p) => p.id)).toEqual(["crm"]);
    for (const p of allRoomPanels()) expect(BUILTIN_PANELS.has(p.id)).toBe(false);
  });

  it("refuses reserved or invalid ids", () => {
    expect(() => defineArea({ id: "room", label: "x", icon: House, order: 1, status: "coming_soon", summary: "x" })).toThrow();
    expect(() => defineArea({ id: "Bad id", label: "x", icon: House, order: 1, status: "coming_soon", summary: "x" })).toThrow();
    expect(() => defineArea({ id: "thing", label: "x", icon: House, order: 1, status: "ready", summary: "x" })).toThrow(/no component/);
  });

  it("hides by feature and capability, keeps coming-soon entries listed", () => {
    const ws = (features: Record<string, boolean>, caps: Record<string, boolean>) => ({ features, capabilities: caps }) as unknown as WorkspaceDetail;
    const contacts = findArea("contacts")!;
    const reports = findArea("reports")!;
    const inbox = findArea("inbox")!;
    expect(isAreaVisible(contacts, null)).toBe(true); // not connected yet: shows its connect state
    expect(isAreaVisible(contacts, ws({ crm: true }, {}))).toBe(true);
    expect(isAreaVisible(contacts, ws({ crm: false }, {}))).toBe(false);
    expect(isAreaVisible(inbox, ws({}, {}))).toBe(false);
    expect(isAreaVisible(inbox, ws({ integrations: true }, {}))).toBe(true);
    expect(isAreaVisible(reports, ws({ crm: true }, { "reports.view": false }))).toBe(false);
    expect(isAreaVisible(reports, ws({ crm: true }, { "reports.view": true }))).toBe(true);
  });

  it("renders coming-soon areas honestly, without data", () => {
    const area = { ...findArea("calls")!, status: "coming_soon" as const, owner: "integrations team" };
    const html = renderToStaticMarkup(<ComingSoon area={area} />);
    expect(html).toContain("Coming in this test build");
    expect(html).toContain("integrations team");
    expect(html).not.toMatch(/<table|<li/);
  });
});

describe("workspace auth (code + PKCE)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => vi.restoreAllMocks());

  it("computes the RFC 7636 S256 challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("runs the whole flow, keeps the access token in memory only and rotates refresh tokens", async () => {
    const navigations: string[] = [];
    const calls: { url: string; body: URLSearchParams }[] = [];
    let n = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
      n++;
      return json({ access_token: `at-${n}`, token_type: "Bearer", expires_in: 300, refresh_token: `rt-${n}`, scope: "workspace:read workspace:write" });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const auth = new WorkspaceAuth(CFG, fetchFn, () => now, (u) => navigations.push(u));
    expect(auth.shouldAutoAuthorize()).toBe(true);
    await auth.beginAuthorization("#/contacts", { silent: true });
    const url = new URL(navigations[0]);
    expect(url.origin + url.pathname).toBe(CFG.authorizeUrl);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("nexus-web");
    expect(p.get("redirect_uri")).toBe(`${window.location.origin}/oauth/callback`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("prompt")).toBe("none");
    expect(p.get("scope")).toBe("workspace:read workspace:write");
    expect(auth.shouldAutoAuthorize()).toBe(false); // once per tab
    const pending = JSON.parse(sessionStorage.getItem("nexus-oauth-pending")!);
    expect(await pkceChallenge(pending.verifier)).toBe(p.get("code_challenge"));

    window.history.replaceState(null, "", `/oauth/callback?code=abc&state=${p.get("state")}`);
    const back = await auth.completeAuthorization();
    expect(back).toBe("#/contacts");
    expect(window.location.pathname + window.location.hash).toBe("/#/contacts"); // code removed from the URL
    expect(calls[0].body.get("grant_type")).toBe("authorization_code");
    expect(calls[0].body.get("code_verifier")).toBe(pending.verifier);
    expect(calls[0].body.get("client_secret")).toBeNull();
    expect(await auth.accessToken()).toBe("at-1");
    expect(sessionStorage.getItem("nexus-oauth-rt")).toBe("rt-1");
    expect(sessionStorage.getItem("nexus-oauth-pending")).toBeNull();
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toMatch(/at-|rt-/);

    now += 290_000; // inside the refresh margin: two callers share one refresh
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe("at-2");
    expect(b).toBe("at-2");
    expect(calls.filter((c) => c.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(calls[1].body.get("refresh_token")).toBe("rt-1");
    expect(sessionStorage.getItem("nexus-oauth-rt")).toBe("rt-2");

    await auth.signOut();
    const revoke = calls[calls.length - 1];
    expect(revoke.url).toBe(CFG.revokeUrl);
    expect(revoke.body.get("token")).toBe("rt-2");
    expect(sessionStorage.getItem("nexus-oauth-rt")).toBeNull();
    expect(auth.state).toBe("signed-out");
  });

  it("rejects a callback whose state doesn't match", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const auth = new WorkspaceAuth(CFG, fetchFn, Date.now, () => undefined);
    await auth.beginAuthorization("#/home");
    window.history.replaceState(null, "", "/oauth/callback?code=abc&state=forged");
    await auth.completeAuthorization();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth.lastError?.code).toBe("state_mismatch");
    expect(window.location.search).toBe("");
  });

  it("treats login_required from the silent attempt as 'connect later', not an error", async () => {
    const auth = new WorkspaceAuth(CFG, vi.fn() as unknown as typeof fetch, Date.now, () => undefined);
    await auth.beginAuthorization("#/home", { silent: true });
    const state = JSON.parse(sessionStorage.getItem("nexus-oauth-pending")!).state;
    window.history.replaceState(null, "", `/oauth/callback?error=login_required&state=${state}`);
    await auth.completeAuthorization();
    expect(auth.lastError).toBeNull();
    expect(auth.state).toBe("signed-out");
  });

  it("drops a refresh token the portal no longer accepts", async () => {
    sessionStorage.setItem("nexus-oauth-rt", "revoked");
    const fetchFn = vi.fn(async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
    const auth = new WorkspaceAuth(CFG, fetchFn, Date.now, () => undefined);
    expect(await auth.accessToken()).toBeNull();
    expect(sessionStorage.getItem("nexus-oauth-rt")).toBeNull();
    expect(auth.lastError?.code).toBe("invalid_grant");
  });
});

describe("workspace API client", () => {
  beforeEach(() => sessionStorage.clear());

  function authWith(token: string | null) {
    const a = new WorkspaceAuth(CFG, vi.fn() as unknown as typeof fetch, Date.now, () => undefined);
    let current = token;
    vi.spyOn(a, "accessToken").mockImplementation(async () => current);
    vi.spyOn(a, "invalidateAccessToken").mockImplementation(() => {
      current = "fresh";
    });
    return a;
  }

  it("sends the bearer token, reads data and the environment header", async () => {
    const fetchFn = vi.fn(async () => json({ data: { ok: 1 } }, 200, { "X-Nexus-Environment": "test" })) as unknown as typeof fetch;
    const api = new WorkspaceApi(CFG.apiUrl, authWith("tok"), fetchFn);
    expect(await api.get("/me", { q: "a b", empty: "", n: 2 })).toEqual({ ok: 1 });
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://example.com/api/v1/me?q=a+b&n=2");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.credentials).toBe("omit");
    expect(api.serverEnvironment).toBe("test");
  });

  it("retries once with a fresh token after a 401", async () => {
    const responses = [json({ error: { code: "unauthenticated", message: "x" } }, 401), json({ data: 5 })];
    const fetchFn = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const api = new WorkspaceApi(CFG.apiUrl, authWith("old"), fetchFn);
    expect(await api.get("/me")).toBe(5);
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer fresh");
  });

  it("turns the error envelope into ApiError with field messages", async () => {
    const fetchFn = vi.fn(async () =>
      json({ error: { code: "validation_error", message: "Some fields are not valid.", fields: { email: ["Enter a valid email address."] }, request_id: "r1" } }, 400),
    ) as unknown as typeof fetch;
    const api = new WorkspaceApi(CFG.apiUrl, authWith("tok"), fetchFn);
    const err = await api.post("/x", { a: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("validation_error");
    expect((err as ApiError).field("email")).toBe("Enter a valid email address.");
    expect((err as ApiError).requestId).toBe("r1");
    expect(describeError(err)).toContain("Enter a valid email address.");
  });

  it("reports network failures and missing tokens plainly", async () => {
    const api = new WorkspaceApi(CFG.apiUrl, authWith("tok"), vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    const err = (await api.get("/me").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("network");
    const none = new WorkspaceApi(CFG.apiUrl, authWith(null), vi.fn() as unknown as typeof fetch);
    expect(((await none.get("/me").catch((e: unknown) => e)) as ApiError).status).toBe(401);
    expect(describeError(new ApiError("x", 404, "not_found"))).toMatch(/doesn't exist or you don't have access/);
  });

  it("handles 204 deletes", async () => {
    const api = new WorkspaceApi(CFG.apiUrl, authWith("tok"), vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch);
    await expect(api.delete("/x")).resolves.toBeUndefined();
  });
});

describe("formatting helpers", () => {
  it("formats dates relative to today", () => {
    const now = new Date(2026, 9, 17, 9, 0);
    expect(formatWhen(new Date(2026, 9, 17, 15, 0).toISOString(), { now })).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 9, 18, 15, 0).toISOString(), { now, time: false })).toBe("Tomorrow");
    expect(formatWhen(new Date(2026, 9, 16, 15, 0).toISOString(), { now, time: false })).toBe("Yesterday");
    expect(formatWhen(null)).toBe("");
  });
  it("round-trips datetime-local values and formats money", () => {
    const iso = new Date(2030, 0, 2, 3, 4).toISOString();
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput("")).toBeNull();
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney("1234.5", "USD")).toMatch(/1,?235|1\.235|1 235/);
  });
});
