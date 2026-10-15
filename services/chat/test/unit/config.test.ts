import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../../src/config";

const valid = {
  brand: { name: "Lumen Secure", short_name: "Lumen" },
  homeserver: { base_url: "https://matrix.example.com/", server_name: "example.com" },
  sso: { idp_id: "oidc-lumen", label: "Continue with your Lumen account" },
  portal_url: "https://example.com",
  allow_custom_homeserver: true,
  calls: { enabled: true, rtc_domain: "rtc.example.com" },
  privacy_url: "https://example.com/privacy/",
  help_url: "https://example.com/docs/",
};

describe("parseConfig", () => {
  it("parses the installer's schema", () => {
    expect(parseConfig(valid)).toEqual({
      brand: { name: "Lumen Secure", shortName: "Lumen" },
      homeserver: { baseUrl: "https://matrix.example.com", serverName: "example.com" },
      sso: { idpId: "oidc-lumen", label: "Continue with your Lumen account" },
      portalUrl: "https://example.com/",
      allowCustomHomeserver: true,
      calls: { enabled: true, rtcDomain: "rtc.example.com" },
      privacyUrl: "https://example.com/privacy/",
      helpUrl: "https://example.com/docs/",
    });
  });

  it("requires a homeserver", () => {
    expect(() => parseConfig({ brand: {} })).toThrow(ConfigError);
    expect(() => parseConfig({ homeserver: { server_name: "x" } })).toThrow(/base_url/);
  });

  it("rejects plain http except for loopback development servers", () => {
    expect(() => parseConfig({ ...valid, homeserver: { base_url: "http://matrix.example.com", server_name: "example.com" } })).toThrow(/https/);
    expect(parseConfig({ ...valid, homeserver: { base_url: "http://127.0.0.1:28008", server_name: "chatdev.test" } }).homeserver.baseUrl).toBe(
      "http://127.0.0.1:28008",
    );
  });

  it("rejects non-http schemes and credentials in URLs", () => {
    expect(() => parseConfig({ ...valid, homeserver: { base_url: "javascript:alert(1)", server_name: "x" } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, homeserver: { base_url: "https://u:p@m.example.com", server_name: "x" } })).toThrow(/credentials/);
  });

  it("validates the SSO provider id", () => {
    expect(() => parseConfig({ ...valid, sso: { idp_id: "../../evil" } })).toThrow(/idp_id/);
    expect(parseConfig({ ...valid, sso: undefined }).sso).toBeNull();
  });

  it("drops invalid optional links instead of failing", () => {
    const c = parseConfig({ ...valid, privacy_url: "javascript:alert(1)", help_url: 42 as unknown as string });
    expect(c.privacyUrl).toBeNull();
    expect(c.helpUrl).toBeNull();
  });

  it("only enables flags when explicitly true", () => {
    const c = parseConfig({ ...valid, allow_custom_homeserver: "yes", calls: { enabled: 1, rtc_domain: "rtc.example.com" } });
    expect(c.allowCustomHomeserver).toBe(false);
    expect(c.calls).toEqual({ enabled: false, rtcDomain: null });
    // the legacy 1:1 VoIP flag no longer enables anything
    expect(parseConfig({ ...valid, calls: undefined, voip_enabled: true }).calls.enabled).toBe(false);
  });

  it("validates the calls section", () => {
    expect(parseConfig({ ...valid, calls: { enabled: true } }).calls).toEqual({ enabled: true, rtcDomain: null });
    expect(parseConfig({ ...valid, calls: { enabled: true, rtc_domain: "wss://evil/x" } }).calls.rtcDomain).toBeNull();
    expect(parseConfig({ ...valid, calls: { enabled: true, rtc_domain: "RTC.Example.com:7443" } }).calls.rtcDomain).toBe("rtc.example.com:7443");
  });

  it("falls back to sane brand names", () => {
    const c = parseConfig({ homeserver: valid.homeserver });
    expect(c.brand.name).toBe("Secure Chat");
    expect(c.brand.shortName).toBe("Secure Chat");
  });

  it("loadConfig reports HTTP and JSON errors", async () => {
    await expect(loadConfig(async () => new Response("nope", { status: 404 }))).rejects.toThrow(/HTTP 404/);
    await expect(loadConfig(async () => new Response("{not json", { status: 200 }))).rejects.toThrow(/not valid JSON/);
    await expect(loadConfig(async () => new Response(JSON.stringify(valid)))).resolves.toMatchObject({ brand: { shortName: "Lumen" } });
  });
});
