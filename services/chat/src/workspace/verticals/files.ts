/**
 * Secure lending documents from the browser: raw-body upload (the file's own Content-Type, its
 * name in X-Nexus-Filename) and download through a short-lived single-use token that travels
 * in a POST body (never in a URL). The decrypted file only exists in this tab's memory until
 * the browser saves it.
 */

import { ApiError } from "../api";
import type { WorkspaceContextValue } from "../context";

type Ws = Pick<WorkspaceContextValue, "api" | "auth">;

async function bearer(ws: Ws): Promise<string> {
  const token = await ws.auth.accessToken();
  if (!token) throw new ApiError("Connect your workspace to continue.", 401, "unauthenticated");
  return token;
}

async function apiError(res: Response): Promise<ApiError> {
  let err: { code?: string; message?: string; fields?: Record<string, string[]>; request_id?: string } | undefined;
  try {
    err = ((await res.json()) as { error?: typeof err })?.error;
  } catch {
    err = undefined;
  }
  return new ApiError(err?.message ?? `The request failed (HTTP ${res.status}).`, res.status, err?.code ?? `http_${res.status}`, err?.fields ?? {}, err?.request_id ?? null);
}

async function send(ws: Ws, path: string, init: RequestInit, retried = false): Promise<Response> {
  const token = await bearer(ws);
  let res: Response;
  try {
    res = await fetch(ws.api.url(path), { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store" });
  } catch {
    throw new ApiError("The workspace server couldn't be reached. Check your connection.", 0, "network");
  }
  if (res.status === 401 && !retried) {
    ws.auth.invalidateAccessToken();
    return send(ws, path, init, true);
  }
  return res;
}

/** Uploads one file to an application (optionally to a checklist item). */
export async function uploadDocument<T>(ws: Ws, crm: string, applicationId: string, file: File, checklistItemId?: string | null): Promise<T> {
  const q = checklistItemId ? `?checklist_item=${encodeURIComponent(checklistItemId)}` : "";
  const res = await send(ws, `${crm}/lending/applications/${applicationId}/documents${q}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Nexus-Filename": encodeURIComponent(file.name), Accept: "application/json" },
  });
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { data: T }).data;
}

/** Gets a single-use token, redeems it, and hands the decrypted file to the browser to save. */
export async function downloadDocument(ws: Ws, crm: string, doc: { id: string; name: string }): Promise<void> {
  const { token } = await ws.api.post<{ token: string; expires_at: string }>(`${crm}/lending/documents/${doc.id}/download-token`, {});
  const res = await send(ws, `${crm}/lending/documents/download`, {
    method: "POST",
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
