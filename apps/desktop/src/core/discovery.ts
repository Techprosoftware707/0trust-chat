/**
 * Server discovery (docs/apps/integration.md §2) and the mapping of what was discovered to
 * the web client's config.json schema (services/chat/src/config.ts).
 *
 * Pure code: the HTTP fetcher is injected (the app passes one built on Electron's `net.fetch`,
 * which uses the OS certificate store; certificate validation is never relaxed).
 *
 * Contract: apps/shared/test-vectors/wellknown.json.
 */
import { isValidServerName, validateEndpointUrl, validateLivekitUrl } from "./url.ts";

export interface LumenBlock {
  brand_name: string | null;
  brand_short_name: string | null;
  portal_url: string | null;
  signup_url: string | null;
  account_url: string | null;
  privacy_url: string | null;
  help_url: string | null;
  sso_idp_id: string | null;
  web_app_url: string | null;
  call_widget_url: string | null;
  push_gateway_url: string | null;
}

export type WellKnownResult =
  | { homeserver: string; lumen: LumenBlock | null }
  | { error: "invalid_document" | "missing_homeserver" | "invalid_homeserver" };

const URL_FIELDS = [
  "portal_url",
  "signup_url",
  "account_url",
  "privacy_url",
  "help_url",
  "web_app_url",
  "call_widget_url",
  "push_gateway_url",
] as const;

export const IDP_ID = /^[A-Za-z0-9._~-]{1,255}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A display string from the server: trimmed, no control characters, at most `max` chars. */
function cleanText(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * An optional link from the `io.lumen.app` block: kept exactly as served (trimmed) when it is
 * a valid https URL without user-info; otherwise dropped (null), never followed.
 */
function optionalUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return validateEndpointUrl(s, { debug: false }) ? s : null;
}

export function parseLumenBlock(raw: unknown): LumenBlock | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const brand = isObject(raw.brand) ? raw.brand : {};
  const idp = typeof raw.sso_idp_id === "string" && IDP_ID.test(raw.sso_idp_id) ? raw.sso_idp_id : null;
  const out: LumenBlock = {
    brand_name: cleanText(brand.name),
    brand_short_name: cleanText(brand.short_name, 32),
    portal_url: null,
    signup_url: null,
    account_url: null,
    privacy_url: null,
    help_url: null,
    sso_idp_id: idp,
    web_app_url: null,
    call_widget_url: null,
    push_gateway_url: null,
  };
  for (const k of URL_FIELDS) out[k] = optionalUrl(raw[k]);
  return out;
}

/** Parses `/.well-known/matrix/client`. */
export function parseWellKnown(json: unknown, opts: { debug: boolean } = { debug: false }): WellKnownResult {
  if (!isObject(json)) return { error: "invalid_document" };
  const hs = json["m.homeserver"];
  if (!isObject(hs) || typeof hs.base_url !== "string" || !hs.base_url.trim()) return { error: "missing_homeserver" };
  const homeserver = validateEndpointUrl(hs.base_url, opts);
  if (!homeserver) return { error: "invalid_homeserver" };
  return { homeserver, lumen: parseLumenBlock(json["io.lumen.app"]) };
}

export type DiscoveryErrorCode = "bad_input" | "unreachable" | "invalid_wellknown" | "not_matrix" | "no_login";

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
  readonly code: DiscoveryErrorCode;
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Turns what the user typed into a Matrix server name: "example.com", "example.com:8448",
 * "@alice:example.com" or "https://example.com" (the host is used). Lowercased.
 */
export function parseServerInput(input: string): string {
  let s = (input ?? "").trim();
  if (!s) throw new DiscoveryError("bad_input", "Enter your server name, for example example.com.");
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.username || u.password) throw new Error("user-info");
      s = u.host;
    } catch {
      throw new DiscoveryError("bad_input", "That doesn't look like a server name.");
    }
  } else if (s.startsWith("@")) {
    const i = s.indexOf(":");
    if (i < 0) throw new DiscoveryError("bad_input", "A Matrix ID looks like @name:example.com.");
    s = s.slice(i + 1);
  }
  s = s.toLowerCase();
  if (!isValidServerName(s)) throw new DiscoveryError("bad_input", "That doesn't look like a server name.");
  return s;
}

export interface FetchResult {
  status: number;
  /** Parsed JSON body, or undefined if the body was not JSON. */
  json: unknown;
}

export interface DiscoveryDeps {
  /** GET a URL and parse JSON. Throws on network/TLS errors. */
  fetchJson(url: string): Promise<FetchResult>;
  debug: boolean;
  now?: () => Date;
}

export interface ServerProfile {
  v: 1;
  /** Matrix server name (the part after ':' in user IDs). */
  serverName: string;
  homeserverUrl: string;
  lumen: LumenBlock | null;
  /** SSO provider to offer, if the server offers SSO with an identity provider. */
  sso: { idpId: string; name: string } | null;
  passwordLogin: boolean;
  /**
   * Call transports. Synapse only answers `/rtc/transports` for signed-in users, so before
   * sign-in this is usually "auth-required"; the web client reports the real list after
   * sign-in (`reportRtcTransports`).
   */
  rtc: { status: "advertised" | "auth-required" | "none"; livekitUrls: string[] };
  discoveredAt: string;
}

export function parseRtcTransports(json: unknown, opts: { debug: boolean }): string[] {
  const list = isObject(json) && Array.isArray(json.rtc_transports) ? json.rtc_transports : [];
  const out: string[] = [];
  for (const t of list) {
    if (!isObject(t) || t.type !== "livekit") continue;
    const url = validateLivekitUrl(t.url, opts);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= 4) break;
  }
  return out;
}

export async function discoverServer(input: string, deps: DiscoveryDeps): Promise<ServerProfile> {
  const serverName = parseServerInput(input);
  const debug = deps.debug;

  let wk: FetchResult;
  try {
    wk = await deps.fetchJson(`https://${serverName}/.well-known/matrix/client`);
  } catch {
    throw new DiscoveryError("unreachable", `Couldn't reach ${serverName}. Check the name and your connection.`);
  }
  let homeserverUrl: string;
  let lumen: LumenBlock | null = null;
  if (wk.status === 200) {
    const parsed = parseWellKnown(wk.json, { debug });
    if ("error" in parsed) {
      throw new DiscoveryError(
        "invalid_wellknown",
        parsed.error === "invalid_homeserver"
          ? `${serverName} points to a homeserver address this app doesn't accept (it must use https).`
          : `${serverName} has an invalid Matrix client configuration (.well-known/matrix/client).`,
      );
    }
    homeserverUrl = parsed.homeserver;
    lumen = parsed.lumen;
  } else if (wk.status === 404) {
    // No well-known: the server name itself may be the homeserver.
    homeserverUrl = `https://${serverName}`;
  } else {
    throw new DiscoveryError("unreachable", `${serverName} answered with an error (HTTP ${wk.status}).`);
  }

  let versions: FetchResult;
  try {
    versions = await deps.fetchJson(`${homeserverUrl}/_matrix/client/versions`);
  } catch {
    throw new DiscoveryError("unreachable", `Couldn't reach the homeserver ${homeserverUrl}.`);
  }
  if (versions.status !== 200 || !isObject(versions.json) || !Array.isArray(versions.json.versions)) {
    throw new DiscoveryError("not_matrix", `${serverName} is not a Matrix server.`);
  }

  let login: FetchResult;
  try {
    login = await deps.fetchJson(`${homeserverUrl}/_matrix/client/v3/login`);
  } catch {
    throw new DiscoveryError("unreachable", `Couldn't reach the homeserver ${homeserverUrl}.`);
  }
  const flows = isObject(login.json) && Array.isArray(login.json.flows) ? login.json.flows.filter(isObject) : [];
  const passwordLogin = flows.some((f) => f.type === "m.login.password");
  const providers: { id: string; name: string }[] = [];
  for (const f of flows) {
    if (f.type !== "m.login.sso") continue;
    const idps = Array.isArray(f.identity_providers) ? f.identity_providers : [];
    for (const p of idps) {
      if (isObject(p) && typeof p.id === "string" && IDP_ID.test(p.id)) {
        providers.push({ id: p.id, name: cleanText(p.name) ?? p.id });
      }
    }
  }
  let sso: ServerProfile["sso"] = null;
  const wanted = lumen?.sso_idp_id;
  const chosen = (wanted ? providers.find((p) => p.id === wanted) : undefined) ?? providers[0];
  if (chosen) sso = { idpId: chosen.id, name: chosen.name };
  if (!sso && !passwordLogin) {
    throw new DiscoveryError("no_login", `${serverName} doesn't offer a sign-in method this app supports.`);
  }

  let rtc: ServerProfile["rtc"] = { status: "none", livekitUrls: [] };
  try {
    const r = await deps.fetchJson(`${homeserverUrl}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`);
    if (r.status === 200) {
      const urls = parseRtcTransports(r.json, { debug });
      rtc = { status: urls.length ? "advertised" : "none", livekitUrls: urls };
    } else if (r.status === 401 || r.status === 403) {
      rtc = { status: "auth-required", livekitUrls: [] };
    }
  } catch {
    /* calls stay off until the web client reports transports */
  }

  return {
    v: 1,
    serverName,
    homeserverUrl,
    lumen,
    sso,
    passwordLogin,
    rtc,
    discoveredAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}

export const DEFAULT_BRAND = { name: "Lumen Secure", shortName: "Lumen" };

/** Brand shown by the desktop app for a server (fallback "Lumen Secure"). */
export function brandOf(profile: Pick<ServerProfile, "lumen"> | null): { name: string; shortName: string } {
  const name = profile?.lumen?.brand_name ?? DEFAULT_BRAND.name;
  const shortName = profile?.lumen?.brand_short_name ?? (profile?.lumen?.brand_name ? name : DEFAULT_BRAND.shortName);
  return { name, shortName };
}

/**
 * The web client's /config.json (schema: services/chat/src/config.ts `parseConfig`) for a
 * discovered server. Custom homeservers are off: in the desktop app the server is chosen in
 * the app's own server picker ("Change server…"), and the CSP only allows this server.
 */
export function toWebClientConfig(profile: ServerProfile): Record<string, unknown> {
  const brand = brandOf(profile);
  const rtcHost = profile.rtc.livekitUrls[0] ? new URL(profile.rtc.livekitUrls[0]).host : null;
  return {
    brand: { name: brand.name, short_name: brand.shortName },
    homeserver: { base_url: profile.homeserverUrl, server_name: profile.serverName },
    sso: profile.sso
      ? {
          idp_id: profile.sso.idpId,
          label: profile.lumen ? `Continue with your ${brand.shortName} account` : `Continue with ${profile.sso.name}`,
        }
      : null,
    portal_url: profile.lumen?.signup_url ?? profile.lumen?.portal_url ?? null,
    allow_custom_homeserver: false,
    calls: { enabled: profile.rtc.livekitUrls.length > 0, rtc_domain: rtcHost },
    privacy_url: profile.lumen?.privacy_url ?? null,
    help_url: profile.lumen?.help_url ?? null,
  };
}

/**
 * Re-validates a server profile read back from disk (server.json): the file is outside the
 * signed bundle, so it is treated like any other untrusted input.
 */
export function parseStoredProfile(raw: unknown, opts: { debug: boolean }): ServerProfile | null {
  if (!isObject(raw) || raw.v !== 1) return null;
  if (typeof raw.serverName !== "string" || !isValidServerName(raw.serverName)) return null;
  const homeserverUrl = validateEndpointUrl(raw.homeserverUrl, opts);
  if (!homeserverUrl) return null;
  const lumen = isObject(raw.lumen) ? parseLumenBlock({ ...raw.lumen, version: 1, brand: { name: raw.lumen.brand_name, short_name: raw.lumen.brand_short_name } }) : null;
  let sso: ServerProfile["sso"] = null;
  if (isObject(raw.sso) && typeof raw.sso.idpId === "string" && IDP_ID.test(raw.sso.idpId)) {
    sso = { idpId: raw.sso.idpId, name: cleanText(raw.sso.name) ?? raw.sso.idpId };
  }
  const rtcRaw = isObject(raw.rtc) ? raw.rtc : {};
  const urls = Array.isArray(rtcRaw.livekitUrls)
    ? rtcRaw.livekitUrls.map((u) => validateLivekitUrl(u, opts)).filter((u): u is string => !!u).slice(0, 4)
    : [];
  const status = rtcRaw.status === "advertised" || rtcRaw.status === "auth-required" ? rtcRaw.status : "none";
  return {
    v: 1,
    serverName: raw.serverName,
    homeserverUrl,
    lumen,
    sso,
    passwordLogin: raw.passwordLogin === true,
    rtc: { status: urls.length ? "advertised" : status, livekitUrls: urls },
    discoveredAt: typeof raw.discoveredAt === "string" ? raw.discoveredAt.slice(0, 40) : new Date(0).toISOString(),
  };
}

/** desktop-config.json, written at build time (LUMEN_DEFAULT_SERVER). */
export function parseBuildConfig(raw: unknown): { defaultServer: string | null } {
  if (!isObject(raw) || typeof raw.default_server !== "string" || !raw.default_server.trim()) return { defaultServer: null };
  try {
    return { defaultServer: parseServerInput(raw.default_server) };
  } catch {
    return { defaultServer: null };
  }
}
