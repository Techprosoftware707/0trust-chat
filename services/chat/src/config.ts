/**
 * Runtime configuration, fetched from /config.json (rendered by the installer).
 * Everything brand- or deployment-specific comes from here, never from code.
 */

export interface AppConfig {
  brand: { name: string; shortName: string };
  homeserver: { baseUrl: string; serverName: string };
  sso: { idpId: string; label: string } | null;
  portalUrl: string | null;
  allowCustomHomeserver: boolean;
  voipEnabled: boolean;
  privacyUrl: string | null;
  helpUrl: string | null;
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

  return {
    brand: { name, shortName },
    homeserver: { baseUrl, serverName },
    sso,
    portalUrl: optionalUrl("portal_url"),
    allowCustomHomeserver: raw.allow_custom_homeserver === true,
    voipEnabled: raw.voip_enabled === true,
    privacyUrl: optionalUrl("privacy_url"),
    helpUrl: optionalUrl("help_url"),
  };
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
