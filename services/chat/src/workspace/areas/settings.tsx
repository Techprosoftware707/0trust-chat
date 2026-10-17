/** Settings: app settings (chat), the workspace connection, the selected workspace. */

import { Bell, ExternalLink, KeyRound, Lock, LogOut, Settings, TriangleAlert, Workflow } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { useUi } from "../../components/UiContext";
import { useWorkspace } from "../context";
import { areaHash, defineArea } from "../define";
import { PageHeader } from "../ui";
import { AiSettingsCard, ConnectedAppsCard } from "../assistant/SettingsCards";

const FEATURE_LABEL: Record<string, string> = {
  crm: "Business workspace (contacts, pipelines, tasks)",
  real_estate: "Real-estate profile",
  lending: "Lending profile",
  save_to_record: "“Save to record” from chat (copies selected text out of end-to-end encryption)",
  assistant: "AI assistant",
  mcp: "Claude connector (MCP)",
  automation: "Automations (internal actions: owners, tasks, in-app notifications)",
  notifications: "In-app notifications",
};

/** Notification preferences and automations (verticals team): links to their pages. */
function NotificationsCard({ canManage }: { canManage: boolean }) {
  return (
    <section className="ws-card" aria-labelledby="set-notif">
      <header className="ws-card-header">
        <h2 id="set-notif">Notifications</h2>
      </header>
      <p className="muted small">Mute, group, and choose which reminders and automation messages reach you. In the app only for now.</p>
      <div className="cluster">
        <a className="btn btn-sm" href={areaHash("notifications", "preferences")}>
          <Bell aria-hidden="true" /> Notification preferences
        </a>
        {canManage ? (
          <a className="btn btn-sm btn-ghost" href={areaHash("automations")}>
            <Workflow aria-hidden="true" /> Automations
          </a>
        ) : null}
      </div>
    </section>
  );
}

function SettingsPage() {
  const ws = useWorkspace();
  const { config } = useMatrix();
  const ui = useUi();
  const w = ws.workspace;
  const mismatch = ws.me && ws.me.user.matrix_id !== ws.chatUserId;
  const portal = config.portalUrl?.replace(/\/+$/, "");
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={Settings} title="Settings" />
      <div className="ws-settings-grid">
        <section className="ws-card" aria-labelledby="set-app">
          <header className="ws-card-header">
            <h2 id="set-app">App</h2>
          </header>
          <p className="muted small">Profile, appearance, notifications, calls, security and sessions of this device.</p>
          <div className="cluster">
            <button type="button" className="btn" onClick={() => ui.openDialog({ type: "settings" })}>
              <Settings aria-hidden="true" /> Open app settings
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => ui.openDialog({ type: "settings", tab: "security" })}>
              <KeyRound aria-hidden="true" /> Encryption &amp; recovery
            </button>
          </div>
        </section>

        <section className="ws-card" aria-labelledby="set-ws">
          <header className="ws-card-header">
            <h2 id="set-ws">Workspace</h2>
          </header>
          {ws.status !== "ready" || !w ? (
            <div className="stack-sm">
              <p className="muted small">Not connected. {ws.error ?? ""}</p>
              <button type="button" className="btn btn-primary" onClick={ws.connect}>
                Connect workspace
              </button>
            </div>
          ) : (
            <div className="stack-sm">
              {ws.me && ws.me.workspaces.length > 1 ? (
                <div className="field">
                  <label htmlFor="ws-pick">Current workspace</label>
                  <select id="ws-pick" value={w.id} onChange={(e) => ws.selectWorkspace(e.target.value)}>
                    {ws.me.workspaces.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <dl className="ws-kv">
                <dt>Name</dt>
                <dd>{w.name}</dd>
                <dt>Your role</dt>
                <dd>{w.role_label}</dd>
                <dt>Plan</dt>
                <dd>{w.plan.name}</dd>
                <dt>Signed in as</dt>
                <dd>{ws.me?.user.name}</dd>
              </dl>
              <h3 className="ws-subhead">Enabled features</h3>
              <ul className="ws-feature-list">
                {Object.entries(FEATURE_LABEL).map(([k, label]) => (
                  <li key={k} className={w.features[k] ? "on" : "off"}>
                    <span className={`badge ${w.features[k] ? "badge-success" : ""}`}>{w.features[k] ? "On" : "Off"}</span> {label}
                  </li>
                ))}
              </ul>
              {portal && ws.can("org.settings") ? (
                <a className="btn btn-sm" href={`${portal}/portal/workspaces/${w.id}/settings/`} target="_blank" rel="noreferrer noopener">
                  Business settings in the portal <ExternalLink aria-hidden="true" />
                </a>
              ) : (
                <p className="xsmall subtle">Owners and admins change business settings in the portal.</p>
              )}
            </div>
          )}
          {mismatch ? (
            <div className="alert alert-warning">
              <TriangleAlert aria-hidden="true" />
              <p>
                Your workspace account ({ws.me!.user.matrix_id}) is not the account you chat with ({ws.chatUserId}). Records you create are saved under
                the workspace account.
              </p>
            </div>
          ) : null}
        </section>

        {ws.status === "ready" && w?.features.notifications ? <NotificationsCard canManage={ws.can("automation.manage")} /> : null}

        {ws.status === "ready" ? (
          <>
            <AiSettingsCard />
            <ConnectedAppsCard />
          </>
        ) : null}

        <section className="ws-card" aria-labelledby="set-sec">
          <header className="ws-card-header">
            <h2 id="set-sec">Privacy of this connection</h2>
          </header>
          <ul className="ws-facts">
            <li>
              <Lock aria-hidden="true" /> Chat messages stay end-to-end encrypted. The workspace server stores only which conversation a record is linked to
              (its room ID), never what was said.
            </li>
            <li>
              <KeyRound aria-hidden="true" /> The workspace access token lives only in this tab's memory and expires within minutes; a renewal token is kept for
              this tab only and ends when you close it or sign out.
            </li>
          </ul>
          {ws.status === "ready" ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={async () => {
                await ws.disconnect();
                ui.toast({ kind: "info", title: "Workspace disconnected", body: "Chat keeps working. Connect again from any workspace page." });
              }}
            >
              <LogOut aria-hidden="true" /> Disconnect workspace in this tab
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export const area = defineArea({
  id: "settings",
  label: "Settings",
  icon: Settings,
  order: 130,
  status: "ready",
  summary: "App settings, your workspace and its connection.",
  component: SettingsPage,
});
