/**
 * Multi-step flows: server set-up (discovery → confirm), sign-out wipe, "Change server…".
 */
import { randomUUID } from "node:crypto";
import { dialog, net, session } from "electron";
import { discoverServer, DiscoveryError, brandOf, type FetchResult, type ServerProfile } from "../core/discovery.ts";
import { ctx, PAGE, WEB_URL } from "./context.ts";
import { log } from "./log.ts";
import { destroyStoreKey } from "./secrets.ts";
import { clearWebStorage } from "./session.ts";
import { getServerProfile, isDebugBuild, saveServerProfile } from "./store.ts";

// ---------------------------------------------------------------------------------------
// Discovery over Electron's network stack (OS trust store, system proxy; certificates are
// always validated), with a size limit, a timeout and https-only redirects.
// ---------------------------------------------------------------------------------------

const MAX_BODY = 256 * 1024;

export async function fetchJson(url: string, hops = 0): Promise<FetchResult> {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(isDebugBuild() && u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) {
    throw new Error("refusing a non-https request");
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await net.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
      bypassCustomProtocolHandlers: true,
    } as RequestInit & { bypassCustomProtocolHandlers: boolean });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hops >= 3) throw new Error("too many redirects");
      return fetchJson(new URL(loc, url).toString(), hops + 1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY) throw new Error("response too large");
    let json: unknown;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

let pendingProfile: ServerProfile | null = null;

export interface DiscoverySummary {
  serverName: string;
  homeserverUrl: string;
  brandName: string;
  isLumen: boolean;
  sso: boolean;
  passwordLogin: boolean;
  signupUrl: string | null;
  calls: "advertised" | "after-sign-in" | "none";
}

export async function setupDiscover(input: unknown): Promise<{ ok: true; summary: DiscoverySummary } | { ok: false; error: string }> {
  pendingProfile = null;
  try {
    const p = await discoverServer(typeof input === "string" ? input : "", { fetchJson, debug: isDebugBuild() });
    pendingProfile = p;
    log.info(`discovered ${p.serverName} (homeserver ${p.homeserverUrl}, lumen block: ${p.lumen ? "yes" : "no"})`);
    return {
      ok: true,
      summary: {
        serverName: p.serverName,
        homeserverUrl: p.homeserverUrl,
        brandName: brandOf(p).name,
        isLumen: !!p.lumen,
        sso: !!p.sso,
        passwordLogin: p.passwordLogin,
        signupUrl: p.lumen?.signup_url ?? null,
        calls: p.rtc.status === "advertised" ? "advertised" : p.rtc.status === "auth-required" ? "after-sign-in" : "none",
      },
    };
  } catch (e) {
    const msg = e instanceof DiscoveryError ? e.message : "Discovery failed.";
    log.warn(`discovery failed: ${e instanceof DiscoveryError ? e.code : (e as Error).message}`);
    return { ok: false, error: msg };
  }
}

export function pendingSignupUrl(): string | null {
  return pendingProfile?.lumen?.signup_url ?? null;
}

export async function setupConnect(): Promise<boolean> {
  if (!pendingProfile || !ctx.mainWindow) return false;
  saveServerProfile(pendingProfile);
  pendingProfile = null;
  await ctx.mainWindow.loadURL(WEB_URL);
  return true;
}

/**
 * The web client reported its call transports after sign-in (Synapse answers /rtc/transports
 * only for signed-in users). New origins change the CSP, so the web client is reloaded once.
 */
export function rtcTransportsReported(urls: string[]): void {
  const p = getServerProfile();
  if (!p) return;
  const merged = [...new Set([...p.rtc.livekitUrls, ...urls])].slice(0, 4);
  if (merged.length === p.rtc.livekitUrls.length) return;
  saveServerProfile({ ...p, rtc: { status: "advertised", livekitUrls: merged } });
  log.info(`call transports updated (${merged.length}); reloading the web client to apply the new policy`);
  ctx.mainWindow?.webContents.reload();
}

// ---------------------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------------------

/** Called after the web client wiped its own data: delete the store key and the browser storage. */
export async function wipeAfterSignOut(): Promise<void> {
  destroyStoreKey();
  await clearWebStorage(session.defaultSession);
}

const signOutWaiters = new Map<string, (r: { ok: boolean; error?: string }) => void>();

export function signOutResult(id: unknown, ok: unknown, error: unknown): void {
  if (typeof id !== "string") return;
  const w = signOutWaiters.get(id);
  if (!w) return;
  signOutWaiters.delete(id);
  w({ ok: ok === true, ...(typeof error === "string" ? { error: error.slice(0, 300) } : {}) });
}

/** Asks the web client to sign out (server logout + local wipe). */
function requestRendererSignOut(timeoutMs = 30_000): Promise<{ ok: boolean; error?: string }> {
  const wc = ctx.mainWindow?.webContents;
  if (!wc || !wc.getURL().startsWith(WEB_URL)) return Promise.resolve({ ok: true });
  const id = randomUUID();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signOutWaiters.delete(id);
      resolve({ ok: false, error: "The app didn't respond." });
    }, timeoutMs);
    signOutWaiters.set(id, (r) => {
      clearTimeout(t);
      resolve(r);
    });
    wc.send("lumen:sign-out-request", id);
  });
}

let changing = false;

export async function changeServer(): Promise<void> {
  const win = ctx.mainWindow;
  if (!win || changing || ctx.locked) return;
  const p = getServerProfile();
  if (!p) {
    void win.loadURL(PAGE.setup);
    return;
  }
  changing = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Sign out and change server"],
      defaultId: 0,
      cancelId: 0,
      title: "Change server",
      message: `Sign out of ${p.serverName}?`,
      detail:
        "To use another server, this device is signed out and its local data and encryption keys are deleted. " +
        "You can read your encrypted messages again only with your recovery key or another verified device.",
    });
    if (response !== 1) return;
    const r = await requestRendererSignOut();
    if (!r.ok) {
      const { response: anyway } = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["Cancel", "Delete local data anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "Change server",
        message: "Couldn't sign out on the server.",
        detail: `${r.error ?? ""}\nThe session may stay listed on the server until you remove it from another device.`,
      });
      if (anyway !== 1) return;
    }
    await wipeAfterSignOut();
    saveServerProfile(null);
    log.info("server configuration removed (change server)");
    await win.loadURL(PAGE.setup);
  } finally {
    changing = false;
  }
}
