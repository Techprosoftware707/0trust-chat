/**
 * The app:// scheme. Two hosts, two origins:
 *   app://lumen/    the bundled web client (services/chat production build) + /config.json
 *                   synthesized from discovery
 *   app://desktop/  the desktop's own pages (server picker, lock screen, settings, screen picker)
 * Files are read from inside the app bundle (asar); every response carries a CSP.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { protocol, type Session } from "electron";
import { resolveAppPath, mimeFor } from "../core/app-path.ts";
import { buildDesktopPageCsp, buildWebClientCsp, PERMISSIONS_POLICY } from "../core/csp.ts";
import { toWebClientConfig, type ServerProfile } from "../core/discovery.ts";
import { log } from "./log.ts";

export const SCHEME = "app";
export const WEB_ORIGIN = "app://lumen";
export const PAGES_ORIGIN = "app://desktop";

/** Must run before the app is ready. */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

export function webClientCsp(profile: ServerProfile | null): string {
  return buildWebClientCsp({
    homeserverUrl: profile?.homeserverUrl ?? null,
    livekitUrls: profile?.rtc.livekitUrls ?? [],
    portalUrl: profile?.lumen?.portal_url ?? null,
  });
}

function securityHeaders(csp: string): Record<string, string> {
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cache-Control": "no-cache",
  };
}

function notFound(csp: string): Response {
  return new Response("Not found", { status: 404, headers: { ...securityHeaders(csp), "Content-Type": "text/plain; charset=utf-8" } });
}

async function serveFile(root: string, pathname: string, csp: string, head: boolean): Promise<Response> {
  const file = resolveAppPath(root, pathname);
  if (!file) return notFound(csp);
  try {
    const data = await fs.readFile(file);
    const headers = { ...securityHeaders(csp), "Content-Type": mimeFor(file)!, "Content-Length": String(data.length) };
    return new Response(head ? null : data, { status: 200, headers });
  } catch {
    return notFound(csp);
  }
}

export interface ProtocolContext {
  webRoot: string;
  pagesRoot: string;
  getProfile(): ServerProfile | null;
}

export function handleAppProtocol(ses: Session, ctx: ProtocolContext): void {
  const webRoot = path.resolve(ctx.webRoot);
  const pagesRoot = path.resolve(ctx.pagesRoot);
  ses.protocol.handle(SCHEME, async (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return new Response(null, { status: 405 });
    if (url.host === "lumen") {
      const profile = ctx.getProfile();
      const csp = webClientCsp(profile);
      if (url.pathname === "/config.json") {
        if (!profile) return notFound(csp);
        const body = JSON.stringify(toWebClientConfig(profile));
        return new Response(head ? null : body, {
          status: 200,
          headers: { ...securityHeaders(csp), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return serveFile(webRoot, url.pathname, csp, head);
    }
    if (url.host === "desktop") return serveFile(pagesRoot, url.pathname, buildDesktopPageCsp(), head);
    log.warn(`refused app:// request for unknown host`);
    return new Response(null, { status: 404 });
  });
}
