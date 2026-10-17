/**
 * Client of the Nexus JSON API (/api/v1). Bearer token from `WorkspaceAuth`; one retry
 * with a fresh token after a 401; errors normalised from the API's one error format
 * (`{"error": {"code", "message", "fields", "request_id"}}`) into `ApiError`.
 */

import { AuthError, type WorkspaceAuth } from "./auth";
import type { Page } from "./types";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string[]> = {},
    readonly requestId: string | null = null,
  ) {
    super(message);
  }

  /** The first message for a field, for inline form errors. */
  field(name: string): string | undefined {
    return this.fields[name]?.[0];
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

export class WorkspaceApi {
  /** Last value of the X-Nexus-Environment header (the server's own environment). */
  serverEnvironment: string | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly auth: WorkspaceAuth,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  url(path: string, query?: Query): string {
    const u = new URL(this.baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    let token: string | null;
    try {
      token = await this.auth.accessToken();
    } catch (e) {
      if (e instanceof AuthError && e.code === "network") throw new ApiError("The workspace server couldn't be reached.", 0, "network");
      throw e;
    }
    if (!token) throw new ApiError("Connect your workspace to continue.", 401, "unauthenticated");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, opts.query), { method, headers, body, signal: opts.signal, credentials: "omit", cache: "no-store" });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      throw new ApiError("The workspace server couldn't be reached. Check your connection.", 0, "network");
    }
    this.serverEnvironment = res.headers.get("X-Nexus-Environment") ?? this.serverEnvironment;
    if (res.status === 401 && !retried) {
      this.auth.invalidateAccessToken();
      return this.request<T>(method, path, opts, true);
    }
    if (res.status === 204) return undefined as T;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; fields?: Record<string, string[]>; request_id?: string } } | null)?.error;
      throw new ApiError(
        err?.message ?? `The request failed (HTTP ${res.status}).`,
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.fields ?? {},
        err?.request_id ?? null,
      );
    }
    return json as T;
  }

  async get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return (await this.request<{ data: T }>("GET", path, { query, signal })).data;
  }

  async list<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Page<T>> {
    return this.request<Page<T>>("GET", path, { query, signal });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<{ data: T }>("POST", path, { body })).data;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<{ data: T }>("PATCH", path, { body })).data;
  }

  async delete(path: string): Promise<void> {
    await this.request<void>("DELETE", path);
  }
}

/** A short, human message for any error the workspace UI can get. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network") return e.message;
    if (e.code === "rate_limited") return "That was a lot of requests in a short time. Try again in a moment.";
    if (e.status === 404) return "This item doesn't exist or you don't have access to it.";
    const field = Object.values(e.fields)[0]?.[0];
    return field ? `${e.message} ${field}` : e.message;
  }
  if (e instanceof AuthError) return e.message;
  return "Something went wrong.";
}
