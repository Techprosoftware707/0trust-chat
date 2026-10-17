/**
 * Notifications: what automations told you (in the app only), and your notification
 * preferences (mute, mute until, grouping, which events) plus, for owners and admins, the
 * workspace defaults. Routes: #/notifications, #/notifications/preferences.
 */

import { useEffect, useId, useState } from "react";
import { Bell, BellOff, CheckCheck, Settings2 } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Page } from "../types";
import { ConnectionGate, EmptyState, ErrorState, LoadingState, PageHeader, formatWhen, fromLocalInput } from "../ui";
import type { NotificationPrefs, NotificationRow, PreferencesResponse } from "../verticals/types";

export function automationBase(workspaceId: string): string {
  return `/workspaces/${workspaceId}/automation`;
}

function List() {
  const ws = useWorkspace();
  const ui = useUi();
  const base = automationBase(ws.workspace!.id);
  const [unread, setUnread] = useState(false);
  const res = useApiResource((api, signal) => api.list<NotificationRow>(`${base}/notifications`, { unread: unread ? "true" : "", limit: 100 }, signal), [base, unread]);
  const rows = (res.data as Page<NotificationRow> | null)?.data ?? [];
  const mark = async (n: NotificationRow, read: boolean) => {
    try {
      const u = await ws.api.patch<NotificationRow>(`${base}/notifications/${n.id}`, { read });
      res.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === u.id ? u : x)) } : p));
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't update it", body: describeError(e) });
    }
  };
  return (
    <>
      <div className="ws-toolbar">
        <div className="ws-segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={!unread} onClick={() => setUnread(false)}>
            All
          </button>
          <button type="button" aria-pressed={unread} onClick={() => setUnread(true)}>
            Unread
          </button>
        </div>
        <button type="button" className="btn btn-sm" disabled={!rows.some((r) => !r.read)}
          onClick={async () => {
            try {
              const r = await ws.api.post<{ marked: number }>(`${base}/notifications/read-all`, {});
              ui.toast({ kind: "success", title: r.marked ? `${r.marked} marked as read` : "Nothing unread" });
              res.reload();
            } catch (e) {
              ui.toast({ kind: "error", title: "Couldn't mark them read", body: describeError(e) });
            }
          }}>
          <CheckCheck aria-hidden="true" /> Mark all read
        </button>
      </div>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <LoadingState /> : null}
      {res.data && rows.length === 0 ? (
        <EmptyState icon={Bell} title={unread ? "You're all caught up" : "No notifications yet"}>
          Automations (reminders, overdue tasks, assignments) notify you here, in the app only.
        </EmptyState>
      ) : null}
      {rows.length ? (
        <div className="ws-card">
          <ul className="ws-list">
            {rows.map((n) => (
              <li key={n.id} className={`vx-notif${n.read ? "" : " unread"}`}>
                <div className="ws-row-main">
                  <span className="ws-row-title">
                    {n.link ? (
                      <a href={n.link} onClick={() => !n.read && void mark(n, true)}>
                        {n.title}
                      </a>
                    ) : (
                      n.title
                    )}
                    {n.count > 1 ? <span className="badge">+{n.count - 1} more</span> : null}
                  </span>
                  {n.body ? <span className="ws-row-meta">{n.body}</span> : null}
                  <span className="ws-row-meta">{formatWhen(n.updated_at)}</span>
                </div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void mark(n, !n.read)} aria-label={`${n.read ? "Mark unread" : "Mark read"}: ${n.title}`}>
                  {n.read ? "Mark unread" : "Mark read"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function PrefsForm({ prefs, scope, onSaved }: { prefs: NotificationPrefs; scope: "user" | "workspace"; onSaved: (p: PreferencesResponse | NotificationPrefs) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const base = automationBase(ws.workspace!.id);
  const [p, setP] = useState(prefs);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(prefs), [prefs]);
  const save = async (patch: Partial<NotificationPrefs> & { muted_until?: string | null }) => {
    setBusy(true);
    try {
      const path = scope === "user" ? `${base}/preferences` : `${base}/preferences/workspace`;
      const r = await ws.api.patch<PreferencesResponse | NotificationPrefs>(path, patch);
      onSaved(r);
      ui.toast({ kind: "success", title: "Preferences saved" });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save the preferences", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <label className="vx-switch">
        <input type="checkbox" checked={p.muted} disabled={busy} onChange={(e) => void save({ muted: e.target.checked })} />
        {scope === "user" ? "Mute all my notifications" : "Mute notifications for everyone (unless they choose otherwise)"}
      </label>
      {scope === "user" ? (
        <div className="ws-inline-fields">
          <label htmlFor={`${uid}-u`} className="small">
            Or mute until
          </label>
          <input id={`${uid}-u`} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={busy || !until} onClick={() => void save({ muted_until: fromLocalInput(until) })}>
            <BellOff aria-hidden="true" /> Mute until then
          </button>
          {p.muted_until ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void save({ muted_until: null })}>
              Unmute (muted until {formatWhen(p.muted_until)})
            </button>
          ) : null}
        </div>
      ) : null}
      <label className="vx-switch">
        <input type="checkbox" checked={p.grouping} disabled={busy} onChange={(e) => void save({ grouping: e.target.checked })} />
        Group repeats (e.g. several overdue tasks become one notification)
      </label>
      <fieldset className="ws-chip-set">
        <legend className="ws-legend">Notify me about</legend>
        <ul className="vx-pref-list">
          {Object.entries(p.event_labels).map(([k, label]) => (
            <li key={k}>
              <label className="vx-switch">
                <input type="checkbox" checked={p.events[k] !== false} disabled={busy} onChange={(e) => void save({ events: { [k]: e.target.checked } })} />
                {label}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

export function NotificationPreferences() {
  const ws = useWorkspace();
  const base = automationBase(ws.workspace!.id);
  const res = useApiResource((api, signal) => api.get<PreferencesResponse>(`${base}/preferences`, undefined, signal), [base]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const d = res.data;
  if (!d) return <LoadingState />;
  return (
    <div className="ws-settings-grid">
      <section className="ws-card" aria-labelledby="np-mine">
        <header className="ws-card-header">
          <h2 id="np-mine">My notifications</h2>
        </header>
        {d.effective.muted && !d.mine.muted && !d.mine.muted_until ? <p className="alert alert-warning small">The workspace default mutes notifications right now.</p> : null}
        <PrefsForm prefs={d.mine} scope="user" onSaved={(r) => res.setData(r as PreferencesResponse)} />
        <p className="xsmall subtle">In the app only: nothing is emailed or pushed in this test build.</p>
      </section>
      <section className="ws-card" aria-labelledby="np-ws">
        <header className="ws-card-header">
          <h2 id="np-ws">Workspace defaults</h2>
        </header>
        <p className="muted small">Apply to everyone who hasn't changed a setting themselves.</p>
        {d.can_edit_workspace ? (
          <PrefsForm prefs={d.workspace} scope="workspace" onSaved={() => res.reload()} />
        ) : (
          <ul className="vx-pref-list small">
            {Object.entries(d.workspace.event_labels).map(([k, label]) => (
              <li key={k}>
                {d.workspace.events[k] !== false ? "On" : "Off"} · {label}
              </li>
            ))}
            <li className="xsmall subtle">Owners and admins change these.</li>
          </ul>
        )}
      </section>
    </div>
  );
}

function NotificationsPage({ path }: AreaProps) {
  const tab = path[0] === "preferences" ? "preferences" : "list";
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={Bell} title="Notifications" subtitle="From reminders and automations. Only you see yours." />
      <nav className="ws-tabs" aria-label="Notifications">
        <a href={areaHash("notifications")} aria-current={tab === "list" ? "page" : undefined}>
          Notifications
        </a>
        <a href={areaHash("notifications", "preferences")} aria-current={tab === "preferences" ? "page" : undefined}>
          <Settings2 aria-hidden="true" className="inline-icon" /> Preferences
        </a>
      </nav>
      {tab === "list" ? <List /> : <NotificationPreferences />}
    </div>
  );
}

function NotificationsArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <NotificationsPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "notifications",
  label: "Notifications",
  icon: Bell,
  order: 15,
  status: "ready",
  feature: "notifications",
  summary: "Reminders, overdue tasks and assignments from your automations, with your preferences.",
  component: NotificationsArea,
});
