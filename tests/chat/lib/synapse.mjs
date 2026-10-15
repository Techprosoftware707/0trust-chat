/** Helpers for the disposable dev homeserver (lumen-chatdev-synapse). */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function devServerInfo() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, "..", "output", "devserver.json"), "utf8"));
  } catch {
    throw new Error("Dev homeserver not set up. Run: npm run devserver:up (in services/chat)");
  }
}

export async function ensureReachable(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/_matrix/client/versions`);
    if (r.ok) return;
  } catch {
    /* fall through */
  }
  throw new Error(`Dev homeserver ${baseUrl} is not reachable. Run: npm run devserver:up (in services/chat)`);
}

/** Registers a user with the shared-secret admin API (HMAC-SHA1 flow). Returns the login response. */
export async function registerUser(info, { username, password, admin = false, displayname } = {}) {
  const base = info.baseUrl;
  const user = username ?? `t${randomBytes(4).toString("hex")}`;
  const pass = password ?? `pw-${randomBytes(12).toString("hex")}`;
  const { nonce } = await (await fetch(`${base}/_synapse/admin/v1/register`)).json();
  const mac = createHmac("sha1", info.registrationSharedSecret)
    .update(`${nonce}\0${user}\0${pass}\0${admin ? "admin" : "notadmin"}`)
    .digest("hex");
  const r = await fetch(`${base}/_synapse/admin/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, username: user, password: pass, admin, mac, displayname: displayname ?? user }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`register ${user} failed: ${r.status} ${JSON.stringify(body)}`);
  return { ...body, username: user, password: pass };
}
