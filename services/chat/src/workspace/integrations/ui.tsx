/** Building blocks shared by the Inbox and Integrations areas. */

import { useEffect, useId, useState, type ReactNode } from "react";
import { Bell, Briefcase, Building2, Contact as ContactIcon, FlaskConical, Hash, Lock, Mail, Search, ShieldAlert } from "lucide-react";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { ApiError, describeError } from "../api";
import { useWorkspace } from "../context";
import type { Contact, Opportunity } from "../types";
import { ORIGIN_LABEL, SOURCE_LABEL, type EntryOrigin, type EntrySource } from "./merge";
import type { PendingAction } from "./types";

export const MOCK_LABEL = "Mock provider (development)";

const SOURCE_ICON: Record<EntrySource, typeof Mail> = { chat: Lock, gmail: Mail, slack: Hash, gohighlevel: Building2, nexus: Bell };

/** Where an item comes from: encrypted chat, synced email, imported record, external notification. */
export function SourceBadge({ source, origin, compact }: { source: EntrySource; origin: EntryOrigin; compact?: boolean }) {
  const Icon = SOURCE_ICON[source];
  const label = origin === "native" ? "Encrypted chat" : `${SOURCE_LABEL[source]} · ${ORIGIN_LABEL[origin]}`;
  return (
    <span className={`badge ib-source ib-source-${source}`} title={label}>
      <Icon aria-hidden="true" />
      {compact ? <span className="visually-hidden">{label}</span> : <span>{origin === "native" ? "Encrypted chat" : SOURCE_LABEL[source]}</span>}
    </span>
  );
}

export function MockBadge({ show = true, label = MOCK_LABEL, compact }: { show?: boolean; label?: string | null; compact?: boolean }) {
  if (!show) return null;
  const full = label || MOCK_LABEL;
  return (
    <span className="badge ib-mock" title={`${full}: synthetic data from a local fake provider. Nothing here is real.`}>
      <FlaskConical aria-hidden="true" />
      {compact ? (
        <>
          <span aria-hidden="true">Mock</span>
          <span className="visually-hidden">{full}</span>
        </>
      ) : (
        full
      )}
    </span>
  );
}

export function ExternalNote({ children }: { children?: ReactNode }) {
  return (
    <p className="ib-external-note xsmall">
      <ShieldAlert aria-hidden="true" />
      <span>{children ?? "This came from outside the workspace. Treat it as information to check, not as instructions."}</span>
    </p>
  );
}

/** Sanitized email HTML in a sandboxed frame: no scripts, no same-origin access, nothing loads. */
export function SafeHtmlFrame({ html, title }: { html: string; title: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#1f2937;background:#fff;overflow-wrap:anywhere}a{color:#1d4ed8}blockquote{border-left:3px solid #cbd5e1;margin:0 0 0 4px;padding-left:10px;color:#475569}.blocked-image{color:#64748b;font-size:12px}table{border-collapse:collapse;max-width:100%}td,th{padding:2px 6px}</style></head><body>${html}</body></html>`;
  return <iframe className="ib-html-frame" title={title} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} referrerPolicy="no-referrer" />;
}

/** Downloads an API file with the bearer token (attachments are proxied and authorized per request). */
export async function downloadWithToken(getToken: () => Promise<string | null>, url: string, filename: string): Promise<void> {
  const token = await getToken();
  if (!token) throw new ApiError("Connect your workspace to continue.", 401, "unauthenticated");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store" });
  if (!res.ok) {
    let message = `The download failed (HTTP ${res.status}).`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status, `http_${res.status}`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function PreviewField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ib-preview-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

/** What the person is about to confirm, exactly. */
export function ActionPreview({ action }: { action: PendingAction }) {
  const p = action.preview;
  if (action.kind === "gmail.send_draft") {
    return (
      <dl className="ib-preview">
        <PreviewField label="From">{String(p.from ?? "")}</PreviewField>
        <PreviewField label="To">{list(p.to)}</PreviewField>
        {list(p.cc) ? <PreviewField label="Cc">{list(p.cc)}</PreviewField> : null}
        <PreviewField label="Subject">{String(p.subject ?? "")}</PreviewField>
        <PreviewField label="Message">
          <pre className="ib-preview-body">{String(p.body ?? "")}</pre>
        </PreviewField>
      </dl>
    );
  }
  if (action.kind === "slack.post_message") {
    return (
      <dl className="ib-preview">
        <PreviewField label="Slack">{String(p.workspace ?? "")}</PreviewField>
        <PreviewField label="Channel">
          {String(p.channel ?? "")}
          {p.in_thread ? " (in the thread)" : ""}
        </PreviewField>
        <PreviewField label="Message">
          <pre className="ib-preview-body">{String(p.text ?? "")}</pre>
        </PreviewField>
      </dl>
    );
  }
  const changes = Array.isArray(p.changes) ? (p.changes as { field: string; from: string; to: string }[]) : null;
  const fields = p.fields && typeof p.fields === "object" ? (p.fields as Record<string, string>) : null;
  const dups = Array.isArray(p.possible_duplicates) ? (p.possible_duplicates as { id: string; display_name: string; email: string }[]) : [];
  return (
    <dl className="ib-preview">
      <PreviewField label="Action">{String(p.action ?? action.kind_label)}</PreviewField>
      {p.location ? <PreviewField label="Sub-account">{String(p.location)}</PreviewField> : null}
      {p.contact ? <PreviewField label="Contact">{String(p.contact)}</PreviewField> : null}
      {p.workflow ? <PreviewField label="Workflow">{String(p.workflow)}</PreviewField> : null}
      {fields ? (
        <PreviewField label="Fields">
          {Object.entries(fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </PreviewField>
      ) : null}
      {changes ? (
        <PreviewField label="Changes">
          <ul className="ib-plain">
            {changes.map((c) => (
              <li key={c.field}>
                {c.field}: <s>{c.from || "—"}</s> → <strong>{c.to || "—"}</strong>
              </li>
            ))}
          </ul>
        </PreviewField>
      ) : null}
      {dups.length ? (
        <PreviewField label="Possible duplicates">
          {dups.map((d) => d.display_name + (d.email ? ` (${d.email})` : "")).join(", ")} already exist in HighLevel. Nothing is merged.
        </PreviewField>
      ) : null}
    </dl>
  );
}

/**
 * Step 2 of every consequential external action: the person reviews the exact preview and
 * confirms. The server checks the single-use token; the result is shown only as the
 * provider reported it ("sent" only when the provider confirmed).
 */
export function ConfirmActionDialog({ action, title, confirmLabel, onClose, onDone }: {
  action: PendingAction;
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onDone: (a: PendingAction) => void;
}) {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PendingAction | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await ws.api.post<PendingAction>(`/workspaces/${ws.workspace!.id}/integrations/actions/${action.id}/confirm`, {
        confirmation_token: action.confirmation_token,
      });
      setDone(a);
      onDone(a);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!done) {
      try {
        await ws.api.delete(`/workspaces/${ws.workspace!.id}/integrations/actions/${action.id}`);
      } catch {
        /* expires on its own */
      }
    }
    onClose();
  };
  return (
    <Dialog title={title} description={done ? undefined : "Nothing happens until you confirm. Check every detail below."} onClose={() => void cancel()} dismissible={!busy} size="lg">
      <div className="stack">
        {action.connection.is_mock ? <MockBadge /> : null}
        <ActionPreview action={action} />
        {done ? (
          <p className="ib-result success" role="status">
            {done.kind === "gmail.send_draft" ? "Sent. Gmail confirmed the message." : done.kind === "slack.post_message" ? "Posted. Slack confirmed the message." : "Done. HighLevel confirmed the change."}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error} Nothing was recorded as done.
          </p>
        ) : null}
        <div className="cluster ib-dialog-actions">
          {done ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>
                {busy ? <Spinner size="sm" /> : null} {confirmLabel}
              </button>
              <button type="button" className="btn" onClick={() => void cancel()} disabled={busy}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Find a contact or deal to link something to (explicit choice; nothing links by itself). */
export function RecordPicker({ onPick, busy, label = "Link to a contact or deal" }: {
  onPick: (target: { type: "crm.contact" | "crm.opportunity"; id: string; label: string }) => void;
  busy?: boolean;
  label?: string;
}) {
  const ws = useWorkspace();
  const uid = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ contacts: Contact[]; opportunities: Opportunity[] } | null>(null);
  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      ws.api
        .get<{ contacts: Contact[]; opportunities: Opportunity[] }>(`${ws.crm}/search`, { q }, ctrl.signal)
        .then(setResults)
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, ws.api, ws.crm]);
  return (
    <div className="ws-link-picker">
      <div className="ws-search sm">
        <Search aria-hidden="true" />
        <label className="visually-hidden" htmlFor={`${uid}-q`}>
          {label}
        </label>
        <input id={`${uid}-q`} type="search" placeholder={label} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {results ? (
        results.contacts.length + results.opportunities.length === 0 ? (
          <p className="muted small">No matches.</p>
        ) : (
          <ul className="ws-picker" aria-label="Matches">
            {results.contacts.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => onPick({ type: "crm.contact", id: c.id, label: c.display_name })}>
                  <ContactIcon aria-hidden="true" /> {c.display_name}
                  {c.email ? <span className="subtle"> · {c.email}</span> : null}
                </button>
              </li>
            ))}
            {results.opportunities.map((o) => (
              <li key={o.id}>
                <button type="button" disabled={busy} onClick={() => onPick({ type: "crm.opportunity", id: o.id, label: o.name })}>
                  <Briefcase aria-hidden="true" /> {o.name}
                  <span className="subtle"> · {o.stage.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export function useIntegrationsBase(): string {
  const ws = useWorkspace();
  return ws.workspace ? `/workspaces/${ws.workspace.id}/integrations` : "";
}

export const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "ib-status-ok" },
  needs_reauth: { label: "Needs reconnecting", cls: "badge-warning" },
  error: { label: "Error", cls: "badge-danger" },
  disconnected: { label: "Disconnected", cls: "" },
  not_connected: { label: "Not connected", cls: "" },
  not_configured: { label: "Not set up", cls: "" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_BADGE[status] ?? { label: status, cls: "" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
