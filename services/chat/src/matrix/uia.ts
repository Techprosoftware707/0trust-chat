/**
 * User-interactive authentication (UIA) for sensitive account operations
 * (uploading cross-signing keys, signing out devices, resetting encryption).
 *
 * Supports the password stage and the SSO fallback stage. For SSO the
 * homeserver's fallback page is opened in a new window; because the app is
 * served with `Cross-Origin-Opener-Policy: same-origin` we cannot observe that
 * window, so the user tells us when they have finished and we retry.
 */
import { MatrixError, type MatrixClient } from "matrix-js-sdk";
import type { AuthDict, UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth.js";

export interface UiaFlow {
  stages: string[];
}

export type UiaPromptRequest =
  | { kind: "password"; action: string; error?: string }
  | { kind: "sso"; action: string; fallbackUrl: string; error?: string };

/** UI bridge: resolves with true when the user completed/confirmed, a password string, or null to cancel. */
export type UiaPrompt = (req: UiaPromptRequest) => Promise<string | true | null>;

let prompt: UiaPrompt | null = null;
export function setUiaPrompt(fn: UiaPrompt | null): void {
  prompt = fn;
}

export class UiaCancelledError extends Error {
  override name = "UiaCancelledError";
  constructor() {
    super("Authentication was cancelled");
  }
}

export interface UiaErrorData {
  session?: string;
  flows?: UiaFlow[];
  completed?: string[];
  errcode?: string;
  error?: string;
}

export function uiaData(e: unknown): UiaErrorData | null {
  if (e instanceof MatrixError && e.httpStatus === 401 && Array.isArray((e.data as UiaErrorData)?.flows)) {
    return e.data as UiaErrorData;
  }
  return null;
}

/** Picks the stage we can complete: a single-stage password or SSO flow. */
export function chooseStage(flows: UiaFlow[]): "m.login.password" | "m.login.sso" | null {
  const single = (t: string) => flows.some((f) => f.stages.length === 1 && f.stages[0] === t);
  if (single("m.login.password")) return "m.login.password";
  if (single("m.login.sso")) return "m.login.sso";
  return null;
}

export function ssoFallbackUrl(baseUrl: string, session: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/_matrix/client/v3/auth/m.login.sso/fallback/web?session=${encodeURIComponent(session)}`;
}

/**
 * Runs `makeRequest` (first without auth); if the server demands UIA, asks the
 * user via the registered prompt and retries.
 */
export async function withUia<T>(
  client: MatrixClient,
  action: string,
  makeRequest: (auth: AuthDict | null) => Promise<T>,
): Promise<T> {
  let data: UiaErrorData | null;
  try {
    return await makeRequest(null);
  } catch (e) {
    data = uiaData(e);
    if (!data) throw e;
  }
  let error: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const stage = chooseStage(data.flows ?? []);
    if (!stage || !data.session) throw new Error("Your homeserver asked for a kind of confirmation this app doesn't support.");
    if (!prompt) throw new Error("Authentication is required but no prompt is available");
    const session = data.session;
    let auth: AuthDict;
    if (stage === "m.login.password") {
      const pw = await prompt({ kind: "password", action, error });
      if (pw === null || pw === true) throw new UiaCancelledError();
      auth = { type: "m.login.password", identifier: { type: "m.id.user", user: client.getSafeUserId() }, password: pw, session };
    } else {
      const ok = await prompt({ kind: "sso", action, fallbackUrl: ssoFallbackUrl(client.getHomeserverUrl(), session), error });
      if (ok !== true) throw new UiaCancelledError();
      auth = { session };
    }
    try {
      return await makeRequest(auth);
    } catch (e) {
      const next = uiaData(e);
      if (!next) throw e;
      data = next;
      error =
        stage === "m.login.password"
          ? next.errcode === "M_FORBIDDEN"
            ? "That password is incorrect."
            : next.error || "That didn't work. Please try again."
          : "The confirmation wasn't completed. Finish the steps in the sign-in window, then try again.";
    }
  }
  throw new Error("Too many failed attempts");
}

/** Adapter for the SDK's `UIAuthCallback` parameters. */
export function uiaCallback<T>(client: MatrixClient, action: string): UIAuthCallback<T> {
  return (makeRequest) => withUia(client, action, makeRequest);
}
