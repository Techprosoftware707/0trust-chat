/** Sign-in: SSO redirect + token exchange, homeserver discovery, password login. */
import { AutoDiscovery, AutoDiscoveryAction, createClient, type LoginResponse } from "matrix-js-sdk";
import { normaliseBaseUrl } from "../config";

const PENDING_SSO_KEY = "lumen-sso-pending-homeserver";

export function ssoRedirectUrl(baseUrl: string, idpId: string | null, redirectUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = idpId
    ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idpId)}`
    : "/_matrix/client/v3/login/sso/redirect";
  return `${base}${path}?redirectUrl=${encodeURIComponent(redirectUrl)}`;
}

/** Where the homeserver sends the browser back to after SSO. */
export function appRedirectUrl(loc: Pick<Location, "origin"> = window.location): string {
  return `${loc.origin}/`;
}

/**
 * Starts SSO: remembers which homeserver we are signing in to (for custom
 * servers) and navigates away.
 */
export function startSso(baseUrl: string, idpId: string | null): void {
  try {
    sessionStorage.setItem(PENDING_SSO_KEY, baseUrl);
  } catch {
    /* sessionStorage unavailable: the configured homeserver will be assumed */
  }
  window.location.assign(ssoRedirectUrl(baseUrl, idpId, appRedirectUrl()));
}

export function takePendingSsoHomeserver(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_SSO_KEY);
    sessionStorage.removeItem(PENDING_SSO_KEY);
    return v;
  } catch {
    return null;
  }
}

/**
 * Extracts `loginToken` from a URL and returns the URL without it. The caller
 * must immediately `history.replaceState` to the cleaned URL so the token
 * doesn't linger in the address bar or history.
 */
export function extractLoginToken(href: string): { token: string | null; cleanedUrl: string } {
  const url = new URL(href);
  const token = url.searchParams.get("loginToken");
  if (token === null) return { token: null, cleanedUrl: href };
  url.searchParams.delete("loginToken");
  return { token: token || null, cleanedUrl: url.pathname + (url.search === "?" ? "" : url.search) + url.hash };
}

export function deviceDisplayName(brandShortName: string, ua: string = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return `${brandShortName} Web (${browser}${os ? ` on ${os}` : ""})`;
}

export async function loginWithToken(baseUrl: string, token: string, deviceName: string): Promise<LoginResponse> {
  const tmp = createClient({ baseUrl });
  return tmp.loginRequest({ type: "m.login.token", token, initial_device_display_name: deviceName });
}

export async function loginWithPassword(
  baseUrl: string,
  user: string,
  password: string,
  deviceName: string,
): Promise<LoginResponse> {
  const tmp = createClient({ baseUrl });
  return tmp.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user },
    password,
    initial_device_display_name: deviceName,
  });
}

export interface LoginOptions {
  baseUrl: string;
  password: boolean;
  sso: { id: string | null; name: string }[];
}

export async function getLoginOptions(baseUrl: string): Promise<LoginOptions> {
  const tmp = createClient({ baseUrl });
  const { flows } = await tmp.loginFlows();
  const password = flows.some((f) => f.type === "m.login.password");
  const sso: LoginOptions["sso"] = [];
  for (const f of flows) {
    if (f.type !== "m.login.sso" && f.type !== "m.login.cas") continue;
    const idps = (f as { identity_providers?: { id: string; name: string }[] }).identity_providers;
    if (idps?.length) for (const p of idps) sso.push({ id: p.id, name: p.name });
    else sso.push({ id: null, name: "Single sign-on" });
  }
  return { baseUrl, password, sso };
}

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

/**
 * Resolves user input to a homeserver base URL. A bare server name is resolved
 * through `.well-known/matrix/client` (AutoDiscovery); a full URL is validated
 * directly.
 */
export async function discoverHomeserver(input: string): Promise<string> {
  const s = input.trim();
  if (!s) throw new DiscoveryError("Enter a server name, e.g. example.org");
  if (/^https?:\/\//i.test(s)) {
    let url: string;
    try {
      url = normaliseBaseUrl(s);
    } catch {
      throw new DiscoveryError("That doesn't look like a valid URL.");
    }
    const res = await AutoDiscovery.fromDiscoveryConfig({ "m.homeserver": { base_url: url } });
    const hs = res["m.homeserver"];
    if (hs.state !== AutoDiscoveryAction.SUCCESS || !hs.base_url) {
      throw new DiscoveryError("That server doesn't look like a Matrix homeserver.");
    }
    return normaliseBaseUrl(hs.base_url);
  }
  const domain = s.replace(/^@?[^:]*:/, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(domain)) throw new DiscoveryError("That doesn't look like a server name.");
  const res = await AutoDiscovery.findClientConfig(domain);
  const hs = res["m.homeserver"];
  if (hs.state === AutoDiscoveryAction.SUCCESS && hs.base_url) return normaliseBaseUrl(hs.base_url);
  if (hs.state === AutoDiscoveryAction.IGNORE || hs.state === AutoDiscoveryAction.FAIL_PROMPT) {
    // No well-known: try the server name itself as the homeserver URL.
    const direct = await AutoDiscovery.fromDiscoveryConfig({ "m.homeserver": { base_url: `https://${domain}` } });
    if (direct["m.homeserver"].state === AutoDiscoveryAction.SUCCESS && direct["m.homeserver"].base_url) {
      return normaliseBaseUrl(direct["m.homeserver"].base_url);
    }
  }
  throw new DiscoveryError(`Couldn't find a Matrix homeserver for ${domain}.`);
}
