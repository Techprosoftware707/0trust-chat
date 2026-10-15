/**
 * SSO sign-in through the system browser (RFC 8252), desktop side.
 *
 *   renderer: lumenDesktop.sso.start(baseUrl, idpId)
 *   main:     new per-attempt nonce -> open
 *             <baseUrl>/_matrix/client/v3/login/sso/redirect/<idp>?redirectUrl=io.lumen.secure:/sso-callback?n=<nonce>
 *             in the default browser
 *   browser:  homeserver -> portal (password, MFA, sign-up) -> homeserver ->
 *             io.lumen.secure:/sso-callback?n=<nonce>&loginToken=<token>
 *   OS:       hands that URL to the app (macOS open-url, Windows/Linux second-instance argv)
 *   main:     nonce matches the pending attempt -> resolve start() with the login token
 *
 * A callback without a pending attempt, with another nonce, after the attempt was cancelled
 * or timed out, or a second callback for the same attempt is ignored. The nonce is single
 * use. Pure code: browser opening, randomness and timers are injected.
 */
import { routeDeepLink } from "./deeplink.ts";
import { IDP_ID } from "./discovery.ts";

export const SSO_REDIRECT_URI = "io.lumen.secure:/sso-callback";
export const SSO_TIMEOUT_MS = 10 * 60 * 1000;

export type SsoErrorCode = "cancelled" | "timeout" | "superseded" | "invalid_request" | "open_failed";

export class SsoError extends Error {
  override name = "SsoError";
  readonly code: SsoErrorCode;
  constructor(code: SsoErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function ssoRedirectUrl(baseUrl: string, idpId: string | null, nonce: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = idpId ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idpId)}` : "/_matrix/client/v3/login/sso/redirect";
  const redirectUrl = `${SSO_REDIRECT_URI}?n=${encodeURIComponent(nonce)}`;
  return `${base}${path}?redirectUrl=${encodeURIComponent(redirectUrl)}`;
}

export interface SsoDeps {
  openExternal(url: string): Promise<void>;
  /** base64url nonce from a CSPRNG */
  newNonce(): string;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  log?(msg: string): void;
}

interface Pending {
  nonce: string;
  resolve(token: string): void;
  reject(e: Error): void;
  timer: unknown;
}

export class SsoCoordinator {
  private pending: Pending | null = null;
  private readonly deps: SsoDeps;
  constructor(deps: SsoDeps) {
    this.deps = deps;
  }

  /** The nonce of the attempt in progress (for routing), or null. */
  get pendingNonce(): string | null {
    return this.pending?.nonce ?? null;
  }

  /**
   * Starts an attempt. `allowedBaseUrl` is the homeserver the app is configured for: the
   * renderer can only start SSO there.
   */
  start(baseUrl: string, idpId: string | null, allowedBaseUrl: string): Promise<string> {
    if (typeof baseUrl !== "string" || baseUrl.replace(/\/+$/, "") !== allowedBaseUrl.replace(/\/+$/, "")) {
      return Promise.reject(new SsoError("invalid_request", "Sign-in can only be started for the configured server."));
    }
    if (idpId !== null && (typeof idpId !== "string" || !IDP_ID.test(idpId))) {
      return Promise.reject(new SsoError("invalid_request", "Invalid identity provider."));
    }
    this.finish(new SsoError("superseded", "A newer sign-in attempt was started."));
    const nonce = this.deps.newNonce();
    return new Promise<string>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        if (this.pending?.nonce === nonce) this.finish(new SsoError("timeout", "Sign-in timed out. Please try again."));
      }, SSO_TIMEOUT_MS);
      this.pending = { nonce, resolve, reject, timer };
      this.deps.openExternal(ssoRedirectUrl(allowedBaseUrl, idpId, nonce)).catch(() => {
        if (this.pending?.nonce === nonce) this.finish(new SsoError("open_failed", "Couldn't open your web browser."));
      });
    });
  }

  cancel(): void {
    this.finish(new SsoError("cancelled", "Sign-in was cancelled."));
  }

  /**
   * Handles an `io.lumen.secure:` URL delivered by the OS. Returns true if it completed the
   * pending attempt; false if it was ignored.
   */
  handleCallback(url: string): boolean {
    const route = routeDeepLink(url, this.pendingNonce);
    if (route.type !== "sso_callback" || !this.pending) {
      this.deps.log?.("ignored an io.lumen.secure link (no matching sign-in in progress)");
      return false;
    }
    const p = this.pending;
    this.pending = null;
    this.deps.clearTimeout(p.timer);
    p.resolve(route.loginToken);
    return true;
  }

  private finish(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.deps.clearTimeout(p.timer);
    p.reject(err);
  }
}
