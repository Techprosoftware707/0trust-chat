/** Settings cards: the workspace's AI policy (owners/admins) and "Connected apps" (Claude connections). */

import { useState } from "react";
import { Copy, Lock, Plug, ShieldCheck, Sparkles, Unplug } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { ErrorState, LoadingState, formatWhen } from "../ui";
import type { Page } from "../types";
import { ProviderBadge, assistantBase, useAssistantStatus } from "./components";
import { connectorSteps } from "./logic";
import type { AiSettings, McpConnection, McpStatus } from "./types";

function Toggle({ id, label, help, checked, disabled, onChange }: {
  id: string; label: string; help: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="ai-toggle">
      <label className="checkbox" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <strong>{label}</strong>
          <span className="xsmall muted ai-toggle-help">{help}</span>
        </span>
      </label>
    </div>
  );
}

export function AiSettingsCard() {
  const ws = useWorkspace();
  const ui = useUi();
  const { status, error, reload } = useAssistantStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = ws.can("org.settings");
  const w = ws.workspace;
  if (!w || !ws.hasFeature("crm")) return null;
  const save = async (patch: Partial<AiSettings>, key: string) => {
    setBusy(key);
    try {
      await ws.api.patch(`${assistantBase(w.id)}/settings`, patch);
      reload();
      ws.reload();
      ui.toast({ kind: "success", title: "AI settings saved" });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  const saveToRecord = async (on: boolean) => {
    setBusy("str");
    try {
      await ws.api.patch(`/workspaces/${w.id}/settings`, { save_to_record_enabled: on });
      ws.reload();
      ui.toast({ kind: "success", title: on ? "“Save to record” is on" : "“Save to record” is off" });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ws-card" aria-labelledby="set-ai">
      <header className="ws-card-header">
        <h2 id="set-ai">
          <Sparkles aria-hidden="true" className="inline-icon" /> AI and connectors
        </h2>
        <ProviderBadge status={status} />
      </header>
      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}
      {!status && !error ? <LoadingState /> : null}
      {status ? (
        <div className="stack-sm">
          {!status.provider.configured ? <p className="xsmall muted">{status.provider.problem}</p> : null}
          <Toggle id="ai-on" label="AI assistant for members" checked={status.settings.assistant_enabled} disabled={!canEdit || !!busy}
            help="Members can ask about the records they're allowed to see. It prepares changes for them to confirm."
            onChange={(v) => void save({ assistant_enabled: v }, "ai")} />
          <Toggle id="mcp-on" label="Members may connect Claude (MCP connector)" checked={status.settings.mcp_enabled}
            disabled={!canEdit || !!busy || !status.mcp.installation_enabled}
            help={status.mcp.installation_enabled
              ? "Each person signs in and approves the connection; Claude then works with their permissions only."
              : "This installation hasn't enabled the connector yet (the operator sets NEXUS_MCP_ENABLED)."}
            onChange={(v) => void save({ mcp_enabled: v }, "mcp")} />
          <Toggle id="ai-sensitive" label="Allow lending-sensitive fields in AI context" checked={status.settings.sensitive_data_enabled}
            disabled={!canEdit || !!busy}
            help="Off by default. Even when on, only people whose role may see sensitive data get it. Documents are never shared with AI."
            onChange={(v) => void save({ sensitive_data_enabled: v }, "sens")} />
          <div className="field ai-retention">
            <label htmlFor="ai-ret">Keep the text of AI conversations</label>
            <select id="ai-ret" value={status.settings.content_retention_days} disabled={!canEdit || !!busy}
              onChange={(e) => void save({ content_retention_days: Number(e.target.value) }, "ret")}>
              <option value={0}>Don't keep it (default)</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <p className="xsmall subtle">The AI log always records who asked, which tools ran and which records they used, never more unless you choose a period here.</p>
          </div>
          <Toggle id="str-on" label="Allow “Save to record” from chat" checked={!!w.settings.save_to_record_enabled} disabled={!canEdit || !!busy}
            help="People may copy messages they select in an end-to-end encrypted conversation into a note on the linked record. That copy is stored in the workspace and is no longer end-to-end encrypted; the conversation itself stays encrypted. Off by default."
            onChange={(v) => void saveToRecord(v)} />
          {!canEdit ? <p className="xsmall subtle">Owners and admins change these settings.</p> : null}
          {busy ? <Spinner size="sm" label="Saving…" /> : null}
        </div>
      ) : null}
    </section>
  );
}

function ConnectionRow({ c, showUser, onRevoke }: { c: McpConnection; showUser: boolean; onRevoke: () => void }) {
  const [busy, setBusy] = useState(false);
  const who = c.client.kind === "cimd" ? `${c.client.name} · verified by ${c.client.host}` : `${c.client.name} · self-registered`;
  return (
    <li className="ai-connection">
      <div className="ws-row-main">
        <span className="ws-row-title">
          <Plug aria-hidden="true" className="inline-icon" /> {who}
        </span>
        <span className="ws-row-meta">
          {showUser && c.user ? `${c.user.name} · ` : ""}returns to {c.client.redirect_hosts.join(", ") || "unknown"}
          {c.client.loopback_only ? " (a program on that computer)" : ""} · {c.scopes.includes("mcp:write") ? "read + prepare changes" : "read only"}
        </span>
        <span className="ws-row-meta">
          Connected {formatWhen(c.created_at)} · last used {c.last_used_at ? formatWhen(c.last_used_at) : "never"}
          {c.active ? "" : " · signed out"}
        </span>
      </div>
      <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={async () => {
        if (!window.confirm(`Disconnect ${c.client.name}? It loses access immediately.`)) return;
        setBusy(true);
        await onRevoke();
        setBusy(false);
      }}>
        {busy ? <Spinner size="sm" /> : <Unplug aria-hidden="true" />} Disconnect
      </button>
    </li>
  );
}

export function ConnectedAppsCard() {
  const ws = useWorkspace();
  const ui = useUi();
  const w = ws.workspace;
  const [everyone, setEveryone] = useState(false);
  const base = w ? `/workspaces/${w.id}/mcp` : "";
  const status = useApiResource((api, signal) => api.get<McpStatus>(`${base}/status`, undefined, signal), [base]);
  const list = useApiResource((api, signal) => api.list<McpConnection>(`${base}/connections`, { scope: everyone ? "workspace" : "mine" }, signal), [base, everyone]);
  if (!w || !ws.hasFeature("crm")) return null;
  const s = status.data;
  const rows: McpConnection[] = (list.data as Page<McpConnection> | null)?.data ?? [];
  const revoke = async (c: McpConnection) => {
    try {
      await ws.api.delete(`${base}/connections/${c.id}`);
      list.setData((p) => (p ? { ...p, data: p.data.filter((x) => x.id !== c.id) } : p));
      ui.toast({ kind: "info", title: "Disconnected", body: c.client.name });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't disconnect", body: describeError(e) });
    }
  };
  return (
    <section className="ws-card" aria-labelledby="set-apps">
      <header className="ws-card-header">
        <h2 id="set-apps">
          <ShieldCheck aria-hidden="true" className="inline-icon" /> Connected apps
        </h2>
      </header>
      {status.error ? <ErrorState error={status.error} onRetry={status.reload} compact /> : null}
      {s ? (
        <div className="stack-sm">
          {s.workspace_enabled ? (
            <>
              <p className="small">Connect Claude to this workspace as a custom connector:</p>
              <ol className="small ai-steps">
                {connectorSteps(s.url).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="cluster">
                <code className="ai-url">{s.url}</code>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                  void navigator.clipboard?.writeText(s.url).then(() => ui.toast({ kind: "success", title: "Connector URL copied" }));
                }}>
                  <Copy aria-hidden="true" /> Copy
                </button>
              </div>
              <p className="xsmall subtle">
                <Lock aria-hidden="true" className="inline-icon" /> Claude works with your permissions only and can't read your encrypted chats or send
                anything. Connecting Claude doesn't give the in-app assistant a model; that needs its own provider.
              </p>
            </>
          ) : (
            <p className="xsmall muted">
              {s.installation_enabled ? "Connecting Claude is off for this workspace. Owners and admins can turn it on above." : "This installation hasn't enabled the Claude connector."}
            </p>
          )}
          {s.can_manage ? (
            <label className="checkbox xsmall">
              <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> <span>Show everyone's connections to this workspace</span>
            </label>
          ) : null}
          {list.loading && !list.data ? <LoadingState /> : null}
          {list.error ? <ErrorState error={list.error} onRetry={list.reload} compact /> : null}
          {list.data && rows.length === 0 ? <p className="muted small">{everyone ? "No one has connected an app yet." : "You haven't connected any apps."}</p> : null}
          {rows.length ? (
            <ul className="ws-list" aria-label="Connections">
              {rows.map((c) => (
                <ConnectionRow key={c.id} c={c} showUser={everyone} onRevoke={() => revoke(c)} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : status.loading ? (
        <LoadingState />
      ) : null}
    </section>
  );
}
