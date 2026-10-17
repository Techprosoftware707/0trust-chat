/**
 * Reports (owners, admins, managers): pipeline by stage, value and owner; this week's team
 * pipeline; activity counts; task completion; lending checklist status; approaching
 * deadlines. Everything is aggregated on the server from the records the viewer may see.
 */

import { useState } from "react";
import { CalendarClock, ChartColumn, ClipboardCheck, ListChecks, Landmark, MessageSquare, Target, Users } from "lucide-react";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea } from "../define";
import type { Page, Pipeline } from "../types";
import { ConnectionGate, ErrorState, LoadingState, PageHeader } from "../ui";
import { CHECKLIST_STATUS_LABEL, money } from "../verticals/logic";
import { UrgencyBadge, formatDay } from "../verticals/shared";
import type { ActivityReport, ChecklistStatus, DeadlinesReport, LendingReport, PipelineReport, TaskReport, TeamWeek } from "../verticals/types";

const ACTIVITY_LABEL: Record<string, string> = { note: "Notes", call: "Calls", meeting: "Meetings", email: "Emails", message_link: "Linked chats",
  stage_change: "Stage changes", task_event: "Task updates", integration_event: "Integration events" };

function Card({ title, icon: Icon, children, wide = false }: { title: string; icon: typeof Target; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`ws-card${wide ? " ws-card-wide" : ""}`} aria-label={title}>
      <header className="ws-card-header">
        <h2>
          <Icon aria-hidden="true" className="inline-icon" /> {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

function Mini({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="vx-mini">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function PipelineCard({ pipelineId }: { pipelineId: string }) {
  const { crm } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<PipelineReport>(`${crm}/reports/pipeline`, { pipeline: pipelineId }, signal), [crm, pipelineId]);
  const d = r.data;
  const max = Math.max(1, ...(d?.stages.map((s) => Number(s.value)) ?? [1]));
  return (
    <Card title="Pipeline by stage" icon={Target} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d && d.pipeline ? (
        <>
          <div className="vx-mini-stats">
            <Mini value={d.totals.open_count ?? 0} label="Open deals" />
            <Mini value={money(d.totals.open_value, d.pipeline.currency)} label="Open value" />
            <Mini value={money(d.totals.weighted_value, d.pipeline.currency)} label="Weighted by stage probability" />
            <Mini value={`${d.totals.won_count ?? 0} · ${money(d.totals.won_value, d.pipeline.currency)}`} label="Won" />
          </div>
          <ul className="ws-bars" aria-label="Value by stage">
            {d.stages.map((s) => (
              <li key={s.id} title={`${s.name}: ${s.count} deals, ${money(s.value, d.pipeline!.currency)}`}>
                <span className="ws-bar-label">{s.name}</span>
                <span className="ws-bar-track" aria-hidden="true">
                  <span className={`ws-bar-fill${s.is_lost ? " muted-fill" : ""}`} style={{ width: `${(Number(s.value) / max) * 100}%` }} />
                </span>
                <span className="ws-bar-value">
                  {s.count} <span className="subtle">· {money(s.value, d.pipeline!.currency)}</span>
                </span>
              </li>
            ))}
          </ul>
          <h3 className="ws-subhead">Open value by owner</h3>
          <table className="vx-table">
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col" className="num">
                  Deals
                </th>
                <th scope="col" className="num">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {d.owners.map((o, i) => (
                <tr key={o.owner?.id ?? `none-${i}`}>
                  <td>{o.owner?.name ?? "No owner"}</td>
                  <td className="num">{o.count}</td>
                  <td className="num">{money(o.value, d.pipeline!.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : d ? (
        <p className="muted small">No pipeline yet.</p>
      ) : null}
    </Card>
  );
}

function TeamWeekCard() {
  const { crm } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<TeamWeek>(`${crm}/reports/team-week`, undefined, signal), [crm]);
  const d = r.data;
  return (
    <Card title="This week's team pipeline" icon={Users}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d ? (
        <>
          <p className="xsmall subtle">Since Monday, {formatDay(d.week_start.slice(0, 10))}.</p>
          <div className="vx-mini-stats">
            <Mini value={d.new_count} label={`New deals · ${money(d.new_value)}`} />
            <Mini value={d.moved_count} label="Stage moves" />
            <Mini value={d.won_count} label={`Won · ${money(d.won_value)}`} />
            <Mini value={d.lost_count} label="Lost" />
          </div>
          {d.people.length ? (
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col" className="num">
                    New
                  </th>
                  <th scope="col" className="num">
                    Won
                  </th>
                  <th scope="col" className="num">
                    Lost
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.people.map((p, i) => (
                  <tr key={p.owner?.id ?? `n${i}`}>
                    <td>{p.owner?.name ?? "No owner"}</td>
                    <td className="num">{p.new}</td>
                    <td className="num">{p.won}</td>
                    <td className="num">{p.lost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">Nothing new this week yet.</p>
          )}
        </>
      ) : null}
    </Card>
  );
}

function ActivityCard({ days }: { days: number }) {
  const { crm } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<ActivityReport>(`${crm}/reports/activity`, { days }, signal), [crm, days]);
  const d = r.data;
  const max = Math.max(1, ...(d?.per_day.map((x) => x.count) ?? [1]));
  return (
    <Card title="Activity" icon={MessageSquare}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d ? (
        <>
          <div className="vx-mini-stats">
            <Mini value={d.total} label={`Timeline entries, last ${d.days} days`} />
            {Object.entries(d.by_kind).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => (
              <Mini key={k} value={n} label={ACTIVITY_LABEL[k] ?? k} />
            ))}
          </div>
          <div className="vx-spark" role="img" aria-label={`Entries per day, last ${d.days} days; the busiest day had ${max}`}>
            {d.per_day.map((x) => (
              <span key={x.date} style={{ height: `${Math.max(2, (x.count / max) * 100)}%` }} title={`${x.date}: ${x.count}`} />
            ))}
          </div>
          {d.by_person.length ? (
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col" className="num">
                    Entries
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.by_person.map((p, i) => (
                  <tr key={p.person?.id ?? i}>
                    <td>{p.person?.name ?? "Someone"}</td>
                    <td className="num">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function TasksCard({ days }: { days: number }) {
  const { crm } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<TaskReport>(`${crm}/reports/tasks`, { days }, signal), [crm, days]);
  const d = r.data;
  return (
    <Card title="Task completion" icon={ListChecks}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d ? (
        <>
          <div className="vx-mini-stats">
            <Mini value={d.completed} label={`Completed · ${d.created} created`} />
            <Mini value={d.on_time_rate === null ? "—" : `${d.on_time_rate}%`} label="Done by the due time" />
            <Mini value={d.open} label="Open now" />
            <Mini value={<span className={d.overdue ? "ws-overdue" : ""}>{d.overdue}</span>} label="Overdue" />
          </div>
          {d.people.length ? (
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Assignee</th>
                  <th scope="col" className="num">
                    Open
                  </th>
                  <th scope="col" className="num">
                    Overdue
                  </th>
                  <th scope="col" className="num">
                    Done
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.people.map((p, i) => (
                  <tr key={p.person?.id ?? i}>
                    <td>{p.person?.name ?? "Unassigned"}</td>
                    <td className="num">{p.open}</td>
                    <td className={`num${p.overdue ? " ws-overdue" : ""}`}>{p.overdue}</td>
                    <td className="num">{p.done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {d.by_source.automation ? <p className="xsmall subtle">{d.by_source.automation} of the new tasks came from automations.</p> : null}
        </>
      ) : null}
    </Card>
  );
}

function LendingCard() {
  const { crm, hasFeature } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<LendingReport>(`${crm}/reports/lending`, undefined, signal), [crm]);
  const d = r.data;
  if (!hasFeature("lending")) return null;
  return (
    <Card title="Lending checklist status" icon={Landmark}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d && d.available ? (
        <>
          <div className="vx-mini-stats">
            <Mini value={d.applications ?? 0} label={`Active applications · ${money(d.amount_requested)}`} />
            <Mini value={<span className={d.applications_missing_documents ? "ws-overdue" : ""}>{d.applications_missing_documents ?? 0}</span>} label="Missing documents" />
            <Mini value={d.awaiting_review ?? 0} label="Documents to review" />
            <Mini value={d.overdue_items ?? 0} label="Overdue requests" />
          </div>
          <ul className="ws-bars" aria-label="Checklist items by status">
            {Object.entries(d.checklist ?? {}).map(([k, n]) => {
              const max = Math.max(1, ...Object.values(d.checklist ?? {}));
              return (
                <li key={k}>
                  <span className="ws-bar-label">{CHECKLIST_STATUS_LABEL[k as ChecklistStatus]}</span>
                  <span className="ws-bar-track" aria-hidden="true">
                    <span className="ws-bar-fill" style={{ width: `${(n / max) * 100}%` }} />
                  </span>
                  <span className="ws-bar-value">{n}</span>
                </li>
              );
            })}
          </ul>
          <p className="xsmall subtle">Counts only. Decisions recorded by staff: {d.decisions?.approved ?? 0} approved, {d.decisions?.conditional ?? 0} conditional, {d.decisions?.declined ?? 0} declined.</p>
          <a className="small" href={areaHash("lending")}>
            Open the application pipeline
          </a>
        </>
      ) : null}
    </Card>
  );
}

function DeadlinesCard() {
  const { crm } = useWorkspace();
  const r = useApiResource((api, signal) => api.get<DeadlinesReport>(`${crm}/reports/deadlines`, { days: 14 }, signal), [crm]);
  const d = r.data;
  return (
    <Card title="Approaching deadlines" icon={CalendarClock}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} compact /> : null}
      {!d && !r.error ? <LoadingState /> : null}
      {d ? (
        d.items.length ? (
          <ul className="ws-list">
            {d.items.map((x) => (
              <li key={x.id}>
                <a className="ws-row-link" href={x.opportunity ? areaHash("crm", x.opportunity.id) : x.application ? areaHash("lending", x.application.id) : "#"}>
                  <span className="ws-row-main">
                    <span className="ws-row-title">{x.title}</span>
                    <span className="ws-row-meta">
                      {formatDay(x.due_date)} · {x.opportunity?.name ?? x.application?.reference ?? ""}
                      {x.responsible ? ` · ${x.responsible.name}` : ""}
                    </span>
                  </span>
                  <UrgencyBadge urgency={x.urgency} />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing due in the next two weeks.</p>
        )
      ) : null}
    </Card>
  );
}

function ReportsPage() {
  const ws = useWorkspace();
  const [days, setDays] = useState(30);
  const pipelines = useApiResource((api, signal) => api.list<Pipeline>(`${ws.crm}/pipelines`, { limit: 100 }, signal), [ws.crm]);
  const list = ((pipelines.data as Page<Pipeline> | null)?.data ?? []).filter((p) => p.kind !== "lending");
  const [pid, setPid] = useState("");
  const selected = pid || list.find((p) => p.is_default)?.id || list[0]?.id || "";
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={ChartColumn} title="Reports" subtitle="Aggregated from the records you can see. Counts and totals only."
        actions={
          <>
            {list.length > 1 ? (
              <>
                <label className="visually-hidden" htmlFor="rep-pipe">
                  Pipeline
                </label>
                <select id="rep-pipe" value={selected} onChange={(e) => setPid(e.target.value)}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <div className="ws-segmented" role="group" aria-label="Period">
              {[7, 30, 90].map((n) => (
                <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}>
                  {n} days
                </button>
              ))}
            </div>
          </>
        } />
      {pipelines.error ? <ErrorState error={pipelines.error} onRetry={pipelines.reload} /> : null}
      <div className="vx-report-grid">
        {selected ? <PipelineCard pipelineId={selected} /> : null}
        <TeamWeekCard />
        <DeadlinesCard />
        <ActivityCard days={days} />
        <TasksCard days={days} />
        <LendingCard />
      </div>
      <p className="xsmall subtle">
        <ClipboardCheck aria-hidden="true" className="inline-icon" /> Reports never include lending documents or message contents.
      </p>
    </div>
  );
}

function ReportsArea() {
  return (
    <ConnectionGate>
      <ReportsPage />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "reports",
  label: "Reports",
  icon: ChartColumn,
  order: 110,
  status: "ready",
  feature: "crm",
  capability: "reports.view",
  summary: "Pipeline, activity and team reports for managers.",
  component: ReportsArea,
});
