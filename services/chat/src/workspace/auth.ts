/**
 * API tokens for the business workspace, from the portal's own OAuth server.
 *
 * Flow (OAuth 2.0 authorization code + PKCE S256, public client "nexus-web"):
 *   1. `beginAuthorization()` stores a random PKCE verifier and `state` in sessionStorage and
 *      navigates to the portal's authorize endpoint. The person is already signed in to the
 *      portal (chat sign-in is SSO through it) and the first-party client skips consent, so
 *      the portal answers at once with a redirect to /oauth/callback?code=...&state=...
 *   2. `completeAuthorization()` (at boot, on /oauth/callback) checks `state`, exchanges the
 *      code with the verifier, removes code/state from the address bar and returns to the
 *      hash the person was on.
 *   3. `accessToken()` returns a valid access token, refreshing it shortly before expiry.
 *
 * Where tokens live, and why:
 *   - the ACCESS token (5 minutes) only in memory: never persisted, gone on reload;
 *   - the REFRESH token in sessionStorage: survives a reload of this tab (so a reload doesn't
 *     bounce through the portal) but not closing the tab, is not shared with other tabs, and
 *     is rotated on every use (a replayed old one is rejected). It is revoked at sign-out, and
 *     the portal revokes all of them when the person signs out there or changes password.
 *     Script injection could read it, exactly as it could read the Matrix session the app
 *     already keeps in this origin; the CSP (no inline script, no third-party origins) is the
 *     defence for both.
 *   - the PKCE verifier and state: sessionStorage, only between steps 1 and 2.
 * No token is ever written to localStorage, IndexedDB, cookies, the URL or logs.
 */

import type { WorkspaceConfig } from "../config";

const RT_KEY = "nexus-oauth-rt";
const PENDING_KEY = "nexus-oauth-pending";
const AUTO_KEY = "nexus-oauth-auto";
export const SCOPES = ["workspace:read", "workspace:write"];
const REFRESH_MARGIN_MS = 45_000;

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export type AuthState = "signed-out" | "authorized" | "error";

export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

interface Pending {
  verifier: string;
  state: string;
  returnHash: string;
  at: number;
}

type Listener = () => void;

export class WorkspaceAuth {
  private tokens: TokenSet | null = null;
  private refreshing: Promise<TokenSet | null> | null = null;
  private listeners = new Set<Listener>();
  /** The last authorization or refresh failure, for the "Connect workspace" screen. */
  lastError: AuthError | null = null;

  constructor(
    readonly config: WorkspaceConfig,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = () => Date.now(),
    private readonly navigateTo: (url: string) => void = (url) => window.location.assign(url),
  ) {}

  get redirectUri(): string {
    return `${window.location.origin}/oauth/callback`;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get state(): AuthState {
    if (this.tokens || this.hasRefreshToken()) return "authorized";
    return this.lastError ? "error" : "signed-out";
  }

  hasRefreshToken(): boolean {
    return !!storage()?.getItem(RT_KEY);
  }

  /** True once per tab: start the (silent) authorization automatically at boot. */
  shouldAutoAuthorize(): boolean {
    const s = storage();
    if (!s) return false;
    return !s.getItem(RT_KEY) && !s.getItem(AUTO_KEY) && !this.tokens;
  }

  isCallback(location: Location = window.location): boolean {
    return location.pathname === "/oauth/callback";
  }

  /**
   * Navigates to the portal's authorize endpoint (the page unloads). `silent` adds
   * `prompt=none`: with a portal session the code comes straight back, without one the
   * portal answers `login_required` (the person stays in the app and can connect later).
   */
  async beginAuthorization(returnHash: string = window.location.hash, { silent = false }: { silent?: boolean } = {}): Promise<void> {
    const s = storage();
    if (!s) throw new AuthError("This browser blocks session storage, which the workspace sign-in needs.", "storage");
    const verifier = randomString(48);
    const pending: Pending = { verifier, state: randomString(24), returnHash: returnHash.startsWith("#") ? returnHash : "", at: this.now() };
    s.setItem(PENDING_KEY, JSON.stringify(pending));
    s.setItem(AUTO_KEY, "1");
    const url = new URL(this.config.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES.join(" "),
      state: pending.state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      ...(silent ? { prompt: "none" } : {}),
    }).toString();
    this.navigateTo(url.toString());
  }

  /**
   * Handles /oauth/callback: validates state, exchanges the code, cleans the URL.
   * Returns the hash to continue on. Errors are kept in `lastError` (never thrown), so
   * the chat app keeps starting normally.
   */
  async completeAuthorization(href: string = window.location.href): Promise<string> {
    const url = new URL(href);
    const params = url.searchParams;
    const s = storage();
    let pending: Pending | null;
    try {
      pending = JSON.parse(s?.getItem(PENDING_KEY) ?? "null") as Pending | null;
    } catch {
      pending = null;
    }
    s?.removeItem(PENDING_KEY);
    const returnHash = pending?.returnHash || "#/home";
    window.history.replaceState(window.history.state, "", `/${returnHash}`);
    const error = params.get("error");
    if (error) {
      if (error === "login_required" || error === "consent_required" || error === "interaction_required") {
        // The silent attempt found no portal session: not an error, just "connect later".
        this.lastError = null;
        this.emit();
        return returnHash;
      }
      this.fail(
        error === "access_denied" ? "The portal didn't allow access to the workspace." : `The portal refused the sign-in (${error.slice(0, 40)}).`,
        error,
      );
      return returnHash;
    }
    const code = params.get("code");
    if (!pending || !code || params.get("state") !== pending.state || this.now() - pending.at > 10 * 60_000) {
      this.fail("The workspace sign-in response didn't match this tab. Try connecting again.", "state_mismatch");
      return returnHash;
    }
    try {
      await this.tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        code_verifier: pending.verifier,
        client_id: this.config.clientId,
      });
    } catch (e) {
      this.fail(e instanceof AuthError ? e.message : "Couldn't finish the workspace sign-in.", e instanceof AuthError ? e.code : "exchange_failed");
    }
    return returnHash;
  }

  private fail(message: string, code: string) {
    this.lastError = new AuthError(message, code);
    this.emit();
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.fetchFn(this.config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new AuthError("The portal couldn't be reached.", "network");
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok || typeof body.access_token !== "string") {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      if (code === "invalid_grant" || res.status === 400 || res.status === 401) storage()?.removeItem(RT_KEY);
      throw new AuthError(code === "invalid_grant" ? "Your workspace session has ended." : "The portal refused the token request.", code);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
    this.tokens = {
      accessToken: body.access_token,
      expiresAt: this.now() + expiresIn * 1000,
      scopes: typeof body.scope === "string" ? body.scope.split(" ") : SCOPES,
    };
    if (typeof body.refresh_token === "string") storage()?.setItem(RT_KEY, body.refresh_token);
    this.lastError = null;
    this.emit();
    return this.tokens;
  }

  /** A valid access token (refreshing if needed), or null when (re)authorization is needed. */
  async accessToken(force = false): Promise<string | null> {
    if (!force && this.tokens && this.tokens.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.tokens.accessToken;
    const set = await this.refresh();
    return set?.accessToken ?? null;
  }

  refresh(): Promise<TokenSet | null> {
    if (this.refreshing) return this.refreshing;
    const rt = storage()?.getItem(RT_KEY);
    if (!rt) {
      this.tokens = null;
      return Promise.resolve(null);
    }
    this.refreshing = this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt, client_id: this.config.clientId })
      .catch((e: unknown) => {
        this.tokens = null;
        if (e instanceof AuthError && e.code !== "network") this.fail(e.message, e.code);
        else if (e instanceof AuthError) throw e;
        return null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** Forget tokens after the API answered 401 for the current one. */
  invalidateAccessToken(): void {
    this.tokens = null;
  }

  /** Revokes the refresh token at the portal (best effort) and forgets everything. */
  async signOut(): Promise<void> {
    const s = storage();
    const rt = s?.getItem(RT_KEY);
    s?.removeItem(RT_KEY);
    s?.removeItem(PENDING_KEY);
    s?.removeItem(AUTO_KEY);
    this.tokens = null;
    this.emit();
    if (!rt) return;
    try {
      await this.fetchFn(this.config.revokeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: rt, token_type_hint: "refresh_token", client_id: this.config.clientId }).toString(),
        credentials: "omit",
        keepalive: true,
      });
    } catch {
      /* the portal also revokes these tokens at its own sign-out */
    }
  }
}

let current: WorkspaceAuth | null = null;

/** The app-wide instance (created once the config is known). */
export function workspaceAuth(config?: WorkspaceConfig | null): WorkspaceAuth | null {
  if (config && (!current || current.config !== config)) current = new WorkspaceAuth(config);
  return config === null ? null : current;
}
