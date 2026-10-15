/**
 * Deep-link routing (docs/apps/integration.md §8). Pure: parses and decides, never acts.
 * Contract: apps/shared/test-vectors/deeplinks.json.
 *
 * Only `io.lumen.secure:` is registered with the OS by the desktop app; the matrix.to and
 * `matrix:` routes are implemented for parity with the mobile apps and tested, but the
 * desktop app does not register the `matrix:` scheme (it would take it over from other
 * Matrix clients on the machine).
 */
import { isValidServerName } from "./url.ts";

export const APP_SCHEME = "io.lumen.secure";

export type DeepLinkRoute =
  | { type: "sso_callback"; loginToken: string }
  | { type: "room"; id: string }
  | { type: "user"; id: string }
  | { type: "reject" };

const REJECT: DeepLinkRoute = { type: "reject" };
const LOGIN_TOKEN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;

/** Constant-time comparison of two strings (nonces). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function serverPartOk(id: string): boolean {
  const i = id.indexOf(":");
  return i > 1 && isValidServerName(id.slice(i + 1).toLowerCase());
}

/** Validates a Matrix identifier and returns its route. */
export function routeIdentifier(id: string): DeepLinkRoute {
  if (!id || id.length > 255 || /\s/.test(id)) return REJECT;
  // Room version 12 room IDs have no server part ("!<hash>").
  if (id[0] === "!" && !id.includes(":")) return /^![A-Za-z0-9_-]{8,255}$/.test(id) ? { type: "room", id } : REJECT;
  if (!serverPartOk(id)) return REJECT;
  const local = id.slice(1, id.indexOf(":"));
  switch (id[0]) {
    case "@":
      return /^[a-z0-9._=\-/+]+$/i.test(local) ? { type: "user", id } : REJECT;
    case "!":
      return /^[^:/?#]+$/.test(local) ? { type: "room", id } : REJECT;
    case "#":
      return /^[^:/?#]+$/.test(local) ? { type: "room", id } : REJECT;
    default:
      return REJECT;
  }
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function routeSsoCallback(u: URL, pendingNonce: string | null): DeepLinkRoute {
  // "io.lumen.secure:/sso-callback" or the authority form "io.lumen.secure://sso-callback"
  const pathForm = u.host === "" && u.pathname === "/sso-callback";
  const authorityForm = u.host === "sso-callback" && (u.pathname === "" || u.pathname === "/");
  if (!pathForm && !authorityForm) return REJECT;
  if (!pendingNonce) return REJECT;
  const n = u.searchParams.get("n");
  const token = u.searchParams.get("loginToken");
  if (!n || !safeEqual(n, pendingNonce)) return REJECT;
  if (!token || !LOGIN_TOKEN.test(token)) return REJECT;
  return { type: "sso_callback", loginToken: token };
}

function routeMatrixTo(u: URL): DeepLinkRoute {
  if (u.protocol !== "https:" || u.hostname !== "matrix.to" || u.port || u.username || u.password) return REJECT;
  const frag = u.hash.replace(/^#\/?/, "");
  if (!frag) return REJECT;
  const first = frag.split("?")[0]!.split("/")[0]!;
  const id = decode(first);
  return id ? routeIdentifier(id) : REJECT;
}

function routeMatrixUri(raw: string): DeepLinkRoute {
  // MSC2312 / spec "matrix:" URIs: matrix:u/<user>, matrix:r/<alias>, matrix:roomid/<id>
  const body = raw.slice("matrix:".length).split("?")[0]!.split("#")[0]!;
  const parts = body.split("/");
  const kind = parts[0];
  const value = parts[1] ? decode(parts[1]) : null;
  if (!value) return REJECT;
  const sigil = kind === "u" ? "@" : kind === "r" ? "#" : kind === "roomid" ? "!" : null;
  if (!sigil) return REJECT;
  return routeIdentifier(sigil + value);
}

export function routeDeepLink(raw: string, pendingNonce: string | null): DeepLinkRoute {
  if (typeof raw !== "string" || raw.length > 4096) return REJECT;
  const s = raw.trim();
  if (/^matrix:/i.test(s)) return routeMatrixUri(s);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return REJECT;
  }
  if (u.protocol === `${APP_SCHEME}:`) return routeSsoCallback(u, pendingNonce);
  if (u.protocol === "https:") return routeMatrixTo(u);
  return REJECT;
}

/**
 * Finds an `io.lumen.secure:` link in a command line (Windows/Linux deliver the URL as an
 * argument of the app's executable, also to the already-running instance's
 * `second-instance` event). Chromium switches (`--foo`) are skipped.
 */
export function findAppLinkInArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a !== "string" || a.startsWith("--")) continue;
    if (a.toLowerCase().startsWith(`${APP_SCHEME}:`)) return a;
  }
  return null;
}
