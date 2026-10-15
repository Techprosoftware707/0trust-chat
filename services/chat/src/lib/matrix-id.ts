/** Matrix identifier helpers (pure). */

const USER_ID = /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-:[\]]+$/i;

export function isValidUserId(s: string): boolean {
  return s.length <= 255 && USER_ID.test(s);
}

export function isValidRoomId(s: string): boolean {
  return s.length <= 255 && /^![^:\s]+(:[^\s]+)?$/.test(s);
}

export function serverNameOf(userId: string): string {
  const i = userId.indexOf(":");
  return i >= 0 ? userId.slice(i + 1) : "";
}

export function localpartOf(userId: string): string {
  const i = userId.indexOf(":");
  return userId.slice(userId.startsWith("@") ? 1 : 0, i >= 0 ? i : undefined);
}

/**
 * Turns user input into a full Matrix ID: "alice" or "@alice" -> "@alice:<defaultServer>".
 * Returns null if it can't be a valid user ID.
 */
export function normaliseUserIdInput(input: string, defaultServer: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!s.startsWith("@")) s = "@" + s;
  if (!s.includes(":")) s = `${s}:${defaultServer}`;
  return isValidUserId(s) ? s : null;
}

export type Route =
  | { kind: "home" }
  | { kind: "room"; roomId: string }
  | { kind: "dm"; userId: string }
  | { kind: "invalid"; reason: string };

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Parses the location hash: "#/room/!id:server", "#/dm/@user:server" (optionally percent-encoded). */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (!h || h === "/") return { kind: "home" };
  const m = /^\/(room|dm)\/(.+)$/.exec(h);
  if (!m) return { kind: "home" };
  const value = safeDecode(m[2]);
  if (value === null) return { kind: "invalid", reason: "That link is malformed." };
  if (m[1] === "room") {
    return isValidRoomId(value) ? { kind: "room", roomId: value } : { kind: "invalid", reason: "That room link is not valid." };
  }
  return isValidUserId(value) ? { kind: "dm", userId: value } : { kind: "invalid", reason: "That link doesn't contain a valid Matrix ID." };
}

export function roomHash(roomId: string): string {
  return `#/room/${encodeURIComponent(roomId)}`;
}
