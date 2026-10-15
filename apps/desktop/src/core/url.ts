/**
 * URL validation shared by discovery, the CSP builder and the window/link policy.
 * Pure functions (no Electron imports) so they run under node:test.
 *
 * Contract: apps/shared/test-vectors/url-validation.json.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost");
}

/**
 * Validates a server or endpoint URL and normalises it: lowercase scheme and host (done by
 * the URL parser), no trailing slash, no query or fragment. `https` only; `http` only for a
 * loopback host and only in debug (unpackaged) builds; never user-info.
 * Returns null for anything else.
 */
export function validateEndpointUrl(raw: unknown, opts: { debug: boolean }): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.protocol === "http:" && !(opts.debug && isLoopbackHost(u.hostname))) return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  // The parser has already lowercased scheme and host and removed default ports.
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Like validateEndpointUrl but keeps path, query and fragment (links shown to the user). */
export function validateLinkUrl(raw: unknown, opts: { debug: boolean }): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!validateEndpointUrl(s, opts)) return null;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

/** Only `wss://` LiveKit URLs (`ws://` for loopback in debug builds); no user-info. */
export function validateLivekitUrl(raw: unknown, opts: { debug: boolean }): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && opts.debug && isLoopbackHost(u.hostname))) return null;
  if (u.username || u.password || !u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** The origin (`scheme://host[:port]`) of a URL that was already validated. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Links the app may hand to the OS (default browser / mail client): `https:` and `mailto:`
 * only. Everything else (file:, smb:, custom schemes, javascript:, http:) is refused, so a
 * message cannot make the app launch another program.
 */
export function isSafeExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "mailto:") return true;
  return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
}

/** Matrix server name (host with optional port, no scheme/path). */
export function isValidServerName(s: string): boolean {
  if (!s || s.length > 255) return false;
  if (/^\[[0-9a-fA-F:.]+\](:\d{1,5})?$/.test(s)) return true; // IPv6 literal
  const m = /^([A-Za-z0-9.-]+)(:(\d{1,5}))?$/.exec(s);
  if (!m) return false;
  const host = m[1]!;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  if (m[3] !== undefined) {
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return false;
  }
  return host.split(".").every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}
