/**
 * Runtime configuration, fetched from /config.json (rendered by the installer).
 * Everything brand- or deployment-specific comes from here, never from code.
 * (The legacy `voip_enabled` flag of 1:1 Matrix VoIP is gone: calls are MatrixRTC only.)
 */

export interface AppConfig {
  brand: { name: string; shortName: string };
  homeserver: { baseUrl: string; serverName: string };
  sso: { idpId: string; label: string } | null;
  portalUrl: string | null;
  allowCustomHomeserver: boolean;
  /**
   * MatrixRTC calls (LiveKit SFU, media end-to-end encrypted with per-participant keys).
   * `rtcDomain` is the operator's SFU host, used only as a fallback when the homeserver
   * doesn't advertise its transports (`/rtc/transports`).
   */
  calls: { enabled: boolean; rtcDomain: string | null };
  privacyUrl: string | null;
  helpUrl: string | null;
  /**
   * Nexus business workspace (CRM, pipelines, tasks...) on top of chat. `null` means a
   * plain chat deployment: no workspace navigation, nothing changes for chat.
   * The SPA gets an API token from the portal's OAuth server (authorization code + PKCE,
   * public client `clientId`), see src/workspace/auth.ts.
   */
  workspace: WorkspaceConfig | null;
  /** "production" | "test" | "development": anything but production shows a banner. */
  environment: AppEnvironment;
}

export type AppEnvironment = "production" | "test" | "development";

export interface WorkspaceConfig {
  apiUrl: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Json, key: string, path: string, required: true): string;
function str(obj: Json, key: string, path: string, required: false): string | null;
function str(obj: Json, key: string, path: string, required: boolean): string | null {
  const v = obj[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ConfigError(`config.json: "${path}${key}" is required`);
    return null;
  }
  if (typeof v !== "string") throw new ConfigError(`config.json: "${path}${key}" must be a string`);
  return v.trim();
}

/**
 * Validates an http(s) URL. Plain http is only accepted for loopback hosts
 * (local development); anything else must be https.
 */
export function validateHttpUrl(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`config.json: "${field}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`config.json: "${field}" must be an http(s) URL`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ConfigError(`config.json: "${field}" must use https`);
  }
  if (url.username || url.password) throw new ConfigError(`config.json: "${field}" must not contain credentials`);
  return url.toString();
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** Normalises a homeserver base URL: no trailing slash, no query or fragment. */
export function normaliseBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function parseConfig(raw: unknown): AppConfig {
  if (!isObject(raw)) throw new ConfigError("config.json must contain a JSON object");

  const brandRaw = isObject(raw.brand) ? raw.brand : {};
  const name = str(brandRaw, "name", "brand.", false) ?? "Secure Chat";
  const shortName = str(brandRaw, "short_name", "brand.", false) ?? name;

  if (!isObject(raw.homeserver)) throw new ConfigError('config.json: "homeserver" is required');
  const baseUrl = normaliseBaseUrl(validateHttpUrl(str(raw.homeserver, "base_url", "homeserver.", true), "homeserver.base_url"));
  const serverName = str(raw.homeserver, "server_name", "homeserver.", true);
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(serverName)) throw new ConfigError('config.json: "homeserver.server_name" is invalid');

  let sso: AppConfig["sso"] = null;
  if (isObject(raw.sso)) {
    const idpId = str(raw.sso, "idp_id", "sso.", false);
    if (idpId) {
      if (!/^[A-Za-z0-9._~-]{1,255}$/.test(idpId)) throw new ConfigError('config.json: "sso.idp_id" is invalid');
      sso = { idpId, label: str(raw.sso, "label", "sso.", false) ?? `Continue with your ${shortName} account` };
    }
  }

  const optionalUrl = (key: string): string | null => {
    try {
      const v = str(raw, key, "", false);
      return v ? validateHttpUrl(v, key) : null;
    } catch {
      return null; // a bad link must not break the app; it is simply not shown
    }
  };

  let calls: AppConfig["calls"] = { enabled: false, rtcDomain: null };
  if (isObject(raw.calls) && raw.calls.enabled === true) {
    let domain: string | null;
    try {
      domain = str(raw.calls, "rtc_domain", "calls.", false);
    } catch {
      domain = null; // a malformed fallback must not break the app
    }
    // a host name (optionally with port); anything else is ignored rather than trusted
    const rtcDomain = domain && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(domain) ? domain.toLowerCase() : null;
    calls = { enabled: true, rtcDomain };
  }

  const portalUrl = optionalUrl("portal_url");
  return {
    brand: { name, shortName },
    homeserver: { baseUrl, serverName },
    sso,
    portalUrl,
    allowCustomHomeserver: raw.allow_custom_homeserver === true,
    calls,
    privacyUrl: optionalUrl("privacy_url"),
    helpUrl: optionalUrl("help_url"),
    workspace: parseWorkspace(raw.workspace, portalUrl),
    environment: raw.environment === "test" || raw.environment === "development" ? raw.environment : "production",
  };
}

/**
 * `workspace: {api_url, client_id, authorize_url?, token_url?, revoke_url?}`. The OAuth
 * endpoints default to the portal's (`portal_url` + /identity/o/...). A malformed block
 * disables the workspace rather than breaking chat.
 */
export function parseWorkspace(raw: unknown, portalUrl: string | null): WorkspaceConfig | null {
  if (!isObject(raw)) return null;
  try {
    const apiUrl = normaliseBaseUrl(validateHttpUrl(str(raw, "api_url", "workspace.", true), "workspace.api_url"));
    const clientId = str(raw, "client_id", "workspace.", false) ?? "nexus-web";
    if (!/^[A-Za-z0-9._~-]{1,100}$/.test(clientId)) throw new ConfigError('config.json: "workspace.client_id" is invalid');
    const issuer = portalUrl ? normaliseBaseUrl(portalUrl) : new URL(apiUrl).origin;
    const endpoint = (key: string, fallback: string) => {
      const v = str(raw, key, "workspace.", false);
      return v ? validateHttpUrl(v, `workspace.${key}`) : `${issuer}${fallback}`;
    };
    return {
      apiUrl,
      clientId,
      authorizeUrl: endpoint("authorize_url", "/identity/o/authorize"),
      tokenUrl: endpoint("token_url", "/identity/o/api/token"),
      revokeUrl: endpoint("revoke_url", "/identity/o/api/revoke"),
    };
  } catch {
    return null;
  }
}

export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  let res: Response;
  try {
    res = await fetchFn("/config.json", { cache: "no-store", credentials: "omit" });
  } catch {
    throw new ConfigError("Couldn't load the app configuration. Check your connection and try again.");
  }
  if (!res.ok) throw new ConfigError(`Couldn't load the app configuration (HTTP ${res.status}).`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ConfigError("The app configuration is not valid JSON.");
  }
  return parseConfig(json);
}
