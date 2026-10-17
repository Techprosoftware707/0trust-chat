/** Home: the first-version dashboard, from the workspace API (GET .../crm/dashboard). */

import { useState } from "react";
import { AlarmClock, ArrowRight, Briefcase, CheckCheck, House, ListChecks, MessagesSquare, RefreshCw, Target, UserRound } from "lucide-react";
import { useClient } from "../../matrix/context";
import { useRoomSummaries } from "../../hooks/matrix";
import { useUi } from "../../components/UiContext";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea } from "../define";
import type { Activity, Dashboard, Task } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, KindBadge, LoadingState, PageHeader, PriorityBadge, formatMoney, formatWhen } from "../ui";
import { ActivityItem } from "./contacts";
import { HomeVerticalCards } from "../verticals/HomeCards";
import type { HomeExtras } from "../verticals/types";

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function TaskCheck({ task, onDone }: { task: Task; onDone: (t: Task) => void }) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  // Optimistic: the box changes at once and goes back if the server says no.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const done = optimistic ?? task.status === "done";
  return (
    <input
      type="checkbox"
      className="ws-check"
      checked={done}
      disabled={busy || !task.permissions.change}
      aria-label={`${done ? "Reopen" : "Complete"} task: ${task.title}`}
      title={task.permissions.change ? undefined : "You can't change this task"}
      onChange={async () => {
        const next = !done;
        setOptimistic(next);
        setBusy(true);
        try {
          const updated = await api.patch<Task>(`${crm}/tasks/${task.id}`, { status: next ? "done" : "open" });
          onDone(updated);
          ui.toast({ kind: "success", title: next ? "Task completed" : "Task reopened", body: task.title });
        } catch (e) {
          ui.toast({ kind: "error", title: "Couldn't update the task", body: describeError(e) });
        } finally {
          setOptimistic(null);
          setBusy(false);
        }
      }}
    />
  );
}

function HomeDashboard() {
  const ws = useWorkspace();
  const client = useClient();
  const summaries = useRoomSummaries(client);
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const res = useApiResource((api, signal) => api.get<Dashboard>(`${ws.crm}/dashboard`, { scope }, signal), [ws.crm, scope]);
  const unread = summaries.filter((s) => s.membership === "join" && s.unread > 0).length;
  const name = ws.me?.user.name ?? "";
  const canTeam = ws.workspace?.view_level === "all";
  const d = res.data;
  const replaceTask = (t: Task) =>
    res.setData((prev) => (prev ? { ...prev, tasks_today: prev.tasks_today.map((x) => (x.id === t.id ? t : x)) } : prev));
  const maxCount = Math.max(1, ...(d?.pipeline_summary?.stages.map((s) => s.count) ?? [1]));
  const openToday = d?.tasks_today.filter((t) => t.status !== "done").length ?? 0;
  return (
    <div className="ws-area-scroll">
      <PageHeader
        icon={House}
        title={`${greeting()}${name ? `, ${name.split(" ")[0]}` : ""}`}
        subtitle={`${new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date())} · ${ws.workspace?.name ?? ""}`}
        actions={
          <>
            {canTeam ? (
              <div className="ws-segmented" role="group" aria-label="Show">
                <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>
                  Mine
                </button>
                <button type="button" aria-pressed={scope === "team"} onClick={() => setScope("team")}>
                  Team
                </button>
              </div>
            ) : null}
            <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={res.reload}>
              <RefreshCw aria-hidden="true" />
            </button>
          </>
        }
      />
      {res.error && !d ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {!d && !res.error ? <LoadingState label="Loading your day…" /> : null}
      {d ? (
        <>
          <div className="ws-stats" aria-label="Today at a glance">
            <a className="ws-stat" href={areaHash("tasks")}>
              <span className="ws-stat-label">
                <ListChecks aria-hidden="true" /> Due by tonight
              </span>
              <span className="ws-stat-value">{openToday}</span>
            </a>
            <a className={`ws-stat${d.overdue_task_count ? " warn" : ""}`} href={areaHash("tasks", "overdue")}>
              <span className="ws-stat-label">
                <AlarmClock aria-hidden="true" /> Overdue tasks
              </span>
              <span className="ws-stat-value">{d.overdue_task_count}</span>
            </a>
            <a className={`ws-stat${d.overdue_follow_ups.length ? " warn" : ""}`} href={areaHash("contacts")}>
              <span className="ws-stat-label">
                <UserRound aria-hidden="true" /> Overdue follow-ups
              </span>
              <span className="ws-stat-value">{d.overdue_follow_ups.length}</span>
            </a>
            <a className="ws-stat" href={d.pipeline_summary ? areaHash("pipelines", d.pipeline_summary.pipeline.id) : areaHash("pipelines")}>
              <span className="ws-stat-label">
                <Target aria-hidden="true" /> Open pipeline
              </span>
              <span className="ws-stat-value">{d.pipeline_summary ? formatMoney(d.pipeline_summary.open_value, d.pipeline_summary.pipeline.currency) : "—"}</span>
            </a>
          </div>
          <div className="ws-home-grid">
            <section className="ws-card" aria-labelledby="home-tasks">
              <header className="ws-card-header">
                <h2 id="home-tasks">Today's tasks</h2>
                <a href={areaHash("tasks")} className="small">
                  All tasks <ArrowRight aria-hidden="true" className="inline-icon" />
                </a>
              </header>
              {d.tasks_today.length === 0 ? (
                <EmptyState icon={CheckCheck} title="Nothing due today">
                  New tasks you're given show up here.
                </EmptyState>
              ) : (
                <ul className="ws-list">
                  {d.tasks_today.map((t) => (
                    <li key={t.id} className={`ws-task-row${t.status === "done" ? " done" : ""}`}>
                      <TaskCheck task={t} onDone={replaceTask} />
                      <div className="ws-row-main">
                        <span className="ws-row-title">{t.title}</span>
                        <span className="ws-row-meta">
                          <span className={t.is_overdue ? "ws-overdue" : ""}>{t.is_overdue ? "Overdue · " : ""}{formatWhen(t.due_at)}</span>
                          {t.contact ? (
                            <>
                              {" · "}
                              <a href={areaHash("contacts", t.contact.id)}>{t.contact.display_name}</a>
                            </>
                          ) : null}
                          {scope === "team" && t.assignee ? ` · ${t.assignee.name}` : ""}
                        </span>
                      </div>
                      <PriorityBadge priority={t.priority} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ws-card" aria-labelledby="home-follow">
              <header className="ws-card-header">
                <h2 id="home-follow">Overdue follow-ups</h2>
              </header>
              {d.overdue_follow_ups.length === 0 ? (
                <EmptyState icon={CheckCheck} title="You're all caught up" />
              ) : (
                <ul className="ws-list">
                  {d.overdue_follow_ups.map((c) => (
                    <li key={c.id}>
                      <a className="ws-row-link" href={areaHash("contacts", c.id)}>
                        <span className="ws-row-main">
                          <span className="ws-row-title">{c.display_name}</span>
                          <span className="ws-row-meta ws-overdue">Follow up was due {formatWhen(c.follow_up_at)}</span>
                        </span>
                        <KindBadge kind={c.kind} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ws-card" aria-labelledby="home-leads">
              <header className="ws-card-header">
                <h2 id="home-leads">Assigned leads</h2>
                <a href={areaHash("contacts")} className="small">
                  Contacts <ArrowRight aria-hidden="true" className="inline-icon" />
                </a>
              </header>
              {d.assigned_leads.length === 0 ? (
                <EmptyState icon={UserRound} title="No open leads assigned to you" />
              ) : (
                <ul className="ws-list">
                  {d.assigned_leads.map((c) => (
                    <li key={c.id}>
                      <a className="ws-row-link" href={areaHash("contacts", c.id)}>
                        <span className="ws-row-main">
                          <span className="ws-row-title">
                            {c.display_name} <DemoBadge show={c.is_demo} />
                          </span>
                          <span className="ws-row-meta">{[c.source, c.follow_up_at ? `Follow up ${formatWhen(c.follow_up_at)}` : ""].filter(Boolean).join(" · ") || "No follow-up set"}</span>
                        </span>
                        <PriorityBadge priority={c.priority} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ws-card" aria-labelledby="home-pipeline">
              <header className="ws-card-header">
                <h2 id="home-pipeline">{d.pipeline_summary ? d.pipeline_summary.pipeline.name : "Pipeline"}</h2>
                {d.pipeline_summary ? (
                  <a href={areaHash("pipelines", d.pipeline_summary.pipeline.id)} className="small">
                    Board <ArrowRight aria-hidden="true" className="inline-icon" />
                  </a>
                ) : null}
              </header>
              {!d.pipeline_summary ? (
                <EmptyState icon={Briefcase} title="No pipeline yet" />
              ) : (
                <ul className="ws-bars" aria-label="Opportunities by stage">
                  {d.pipeline_summary.stages.map((s) => (
                    <li key={s.id} title={`${s.name}: ${s.count} · ${formatMoney(s.total_value, d.pipeline_summary!.pipeline.currency)}`}>
                      <span className="ws-bar-label">{s.name}</span>
                      <span className="ws-bar-track" aria-hidden="true">
                        <span className={`ws-bar-fill${s.is_lost ? " muted-fill" : ""}`} style={{ width: `${(s.count / maxCount) * 100}%` }} />
                      </span>
                      <span className="ws-bar-value">
                        {s.count} <span className="subtle">· {formatMoney(s.total_value, d.pipeline_summary!.pipeline.currency)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <HomeVerticalCards d={d as Dashboard & HomeExtras} team={scope === "team"} />

            <section className="ws-card ws-card-wide" aria-labelledby="home-activity">
              <header className="ws-card-header">
                <h2 id="home-activity">Recent activity</h2>
              </header>
              {d.recent_activity.length === 0 ? (
                <EmptyState title="No activity yet">Notes, calls and stage changes appear here.</EmptyState>
              ) : (
                <ol className="ws-timeline">
                  {d.recent_activity.map((a: Activity) => (
                    <ActivityItem key={a.id} a={a} showRecord />
                  ))}
                </ol>
              )}
            </section>

            <section className="ws-card" aria-labelledby="home-chat">
              <header className="ws-card-header">
                <h2 id="home-chat">Conversations</h2>
              </header>
              <div className="ws-chat-card">
                <MessagesSquare aria-hidden="true" />
                <p>
                  {unread > 0 ? (
                    <>
                      <strong>{unread}</strong> conversation{unread === 1 ? "" : "s"} with unread messages.
                    </>
                  ) : (
                    "No unread conversations."
                  )}
                </p>
                <a className="btn btn-sm btn-primary" href="#/">
                  Open chat
                </a>
                <p className="xsmall subtle">Messages are end-to-end encrypted: only this device can read them, never the workspace server.</p>
              </div>
            </section>
          </div>
          {res.error ? <ErrorState error={res.error} onRetry={res.reload} compact /> : null}
        </>
      ) : null}
    </div>
  );
}

function HomePage() {
  const ws = useWorkspace();
  return (
    <ConnectionGate>
      {ws.hasFeature("crm") ? (
        <HomeDashboard />
      ) : (
        <div className="ws-area-scroll">
          <PageHeader icon={House} title={`Welcome${ws.me ? `, ${ws.me.user.name.split(" ")[0]}` : ""}`} subtitle={ws.workspace?.name} />
          <EmptyState icon={Briefcase} title="Business features are off for this workspace">
            {ws.can("org.settings")
              ? "Turn them on in the portal: Workspaces → Settings → Business workspace."
              : "An owner or admin can turn them on in the portal. Chat works as usual."}
          </EmptyState>
        </div>
      )}
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "home",
  label: "Home",
  icon: House,
  order: 10,
  status: "ready",
  mobile: true,
  summary: "Today's tasks and meetings, follow-ups, deadlines, leads, recent activity and your pipeline.",
  component: HomePage,
});
