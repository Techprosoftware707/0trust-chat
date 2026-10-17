/**
 * Workspace connection state for the shell and every area: the API client, who the portal
 * says we are, the selected workspace (role, features, capabilities) and its members.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceConfig } from "../config";
import { ApiError, WorkspaceApi, describeError } from "./api";
import { workspaceAuth, type WorkspaceAuth } from "./auth";
import type { Me, Member, WorkspaceDetail } from "./types";

export type WorkspaceStatus = "connecting" | "needs-auth" | "ready" | "no-workspace" | "error";

export interface WorkspaceContextValue {
  api: WorkspaceApi;
  auth: WorkspaceAuth;
  status: WorkspaceStatus;
  error: string | null;
  me: Me | null;
  workspace: WorkspaceDetail | null;
  members: Member[];
  /** `/workspaces/<id>/crm` for the selected workspace. */
  crm: string;
  /** Starts the portal sign-in (navigates away and back). */
  connect: () => void;
  disconnect: () => Promise<void>;
  selectWorkspace: (id: string) => void;
  reload: () => void;
  can: (capability: string) => boolean;
  hasFeature: (feature: string) => boolean;
  /** Matrix user ID of the chat session, to warn when the two accounts differ. */
  chatUserId: string;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);
const SELECTED_KEY = "nexus-workspace";

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function writeSelected(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* a remembered choice is only a convenience */
  }
}

export function WorkspaceProvider({ config, chatUserId, children }: { config: WorkspaceConfig; chatUserId: string; children: ReactNode }) {
  const auth = workspaceAuth(config)!;
  const api = useMemo(() => new WorkspaceApi(config.apiUrl, auth), [config.apiUrl, auth]);
  const [status, setStatus] = useState<WorkspaceStatus>(auth.state === "authorized" ? "connecting" : auth.lastError ? "error" : "needs-auth");
  const [error, setError] = useState<string | null>(auth.lastError?.message ?? null);
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string | null>(readSelected);
  const [generation, setGeneration] = useState(0);
  const loading = useRef(0);

  useEffect(() => auth.subscribe(() => setGeneration((g) => g + 1)), [auth]);

  useEffect(() => {
    if (auth.state !== "authorized") {
      setStatus(auth.lastError ? "error" : "needs-auth");
      setError(auth.lastError?.message ?? null);
      return;
    }
    const run = ++loading.current;
    const ctrl = new AbortController();
    setStatus((s) => (s === "ready" ? s : "connecting"));
    void (async () => {
      try {
        const who = await api.get<Me>("/me", undefined, ctrl.signal);
        if (run !== loading.current) return;
        setMe(who);
        if (!who.workspaces.length) {
          setWorkspace(null);
          setStatus("no-workspace");
          return;
        }
        const pick =
          who.workspaces.find((w) => w.id === selected) ?? who.workspaces.find((w) => w.features.crm) ?? who.workspaces[0];
        const [detail, people] = await Promise.all([
          api.get<WorkspaceDetail>(`/workspaces/${pick.id}`, undefined, ctrl.signal),
          api.list<Member>(`/workspaces/${pick.id}/members`, { limit: 200 }, ctrl.signal),
        ]);
        if (run !== loading.current) return;
        setWorkspace(detail);
        setMembers(people.data);
        setError(null);
        setStatus("ready");
      } catch (e) {
        if (run !== loading.current || (e as { name?: string })?.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 401) {
          setStatus("needs-auth");
          setError(auth.lastError?.message ?? null);
        } else {
          setStatus("error");
          setError(describeError(e));
        }
      }
    })();
    return () => ctrl.abort();
  }, [api, auth, selected, generation]);

  const connect = useCallback(() => {
    void auth.beginAuthorization(window.location.hash || "#/home").catch((e: unknown) => {
      setStatus("error");
      setError(describeError(e));
    });
  }, [auth]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      api,
      auth,
      status,
      error,
      me,
      workspace,
      members,
      crm: workspace ? `/workspaces/${workspace.id}/crm` : "",
      connect,
      disconnect: async () => {
        await auth.signOut();
        setMe(null);
        setWorkspace(null);
        setStatus("needs-auth");
      },
      selectWorkspace: (id: string) => {
        writeSelected(id);
        setSelected(id);
      },
      reload: () => setGeneration((g) => g + 1),
      can: (capability: string) => !!workspace?.capabilities[capability],
      hasFeature: (feature: string) => !!workspace?.features[feature],
      chatUserId,
    }),
    [api, auth, status, error, me, workspace, members, connect, chatUserId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The workspace context, or null when this deployment has no workspace (plain chat). */
export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(Ctx);
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}

/** Loads data with the API; reloads when `deps` change. */
export function useApiResource<T>(load: (api: WorkspaceApi, signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const { api, status } = useWorkspace();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (status !== "ready") return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    loader
      .current(api, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
        setError(e);
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, setData, error, loading, reload };
}
