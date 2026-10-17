/** Tasks: mine / team / created by me, grouped by due date; complete, add and edit. */

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { CheckCheck, ListChecks, Plus, Search, Trash2 } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Task } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge, UserLabel, formatWhen, fromLocalInput } from "../ui";
import { TaskCheck } from "./home";

type Scope = "mine" | "team" | "created";
type Due = "" | "overdue" | "today" | "week";

function groupOf(t: Task, now: Date): string {
  if (t.status === "done" || t.status === "canceled") return "Done";
  if (!t.due_at) return "No due date";
  const d = new Date(t.due_at);
  if (t.is_overdue) return "Overdue";
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  if (d <= end) return "Today";
  const week = new Date(end);
  week.setDate(week.getDate() + 6);
  return d <= week ? "This week" : "Later";
}
const GROUP_ORDER = ["Overdue", "Today", "This week", "Later", "No due date", "Done"];

function NewTask({ onCreated }: { onCreated: (t: Task) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assignee, setAssignee] = useState(ws.me?.user.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAssign = ws.can("tasks.create");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give the task a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await ws.api.post<Task>(`${ws.crm}/tasks`, {
        title,
        priority,
        due_at: fromLocalInput(due),
        ...(canAssign && assignee ? { assignee_id: assignee } : {}),
      });
      onCreated(t);
      setTitle("");
      setDue("");
      setPriority("normal");
      ui.toast({ kind: "success", title: "Task added", body: t.title });
    } catch (e2) {
      setError(e2 instanceof ApiError ? (Object.values(e2.fields)[0]?.[0] ?? describeError(e2)) : describeError(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ws-new-task" onSubmit={submit} aria-label="New task">
      <div className="field grow">
        <label htmlFor={`${uid}-t`}>New task</label>
        <input id={`${uid}-t`} type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-invalid={error ? "true" : undefined} aria-describedby={error ? `${uid}-e` : undefined} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-d`}>Due</label>
        <input id={`${uid}-d`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-p`}>Priority</label>
        <select id={`${uid}-p`} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      {canAssign ? (
        <div className="field">
          <label htmlFor={`${uid}-a`}>Assignee</label>
          <select id={`${uid}-a`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            {ws.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? <Spinner size="sm" /> : <Plus aria-hidden="true" />} Add task
      </button>
      {error ? (
        <p className="form-error ws-new-task-error" id={`${uid}-e`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TasksPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const ui = useUi();
  const scope: Scope = path[0] === "team" || path[0] === "created" ? path[0] : "mine";
  const due: Due = path[0] === "overdue" ? "overdue" : "";
  const [status, setStatus] = useState<"open" | "done">("open");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const query = useMemo(() => ({ scope: due ? "mine" : scope, status, due, q: dq, limit: 200 }), [scope, status, due, dq]);
  const res = useApiResource((api, signal) => api.list<Task>(`${ws.crm}/tasks`, query, signal), [ws.crm, query]);
  const now = new Date();
  const tasks = res.data?.data ?? [];
  const groups = GROUP_ORDER.map((g) => ({ g, items: tasks.filter((t) => groupOf(t, now) === g) })).filter((x) => x.items.length);
  const replace = (t: Task) => res.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === t.id ? t : x)) } : p));
  const tabs: [string, string][] = [
    ["mine", "My tasks"],
    ["team", "Team tasks"],
    ["created", "Created by me"],
    ["overdue", "Overdue"],
  ];
  const active = due ? "overdue" : scope;
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={ListChecks} title="Tasks" subtitle={res.data ? `${res.data.page.total} ${status === "open" ? "open" : "done"}` : undefined} />
      <nav className="ws-tabs" aria-label="Task lists">
        {tabs.map(([id, label]) => (
          <a key={id} href={areaHash("tasks", ...(id === "mine" ? [] : [id]))} aria-current={active === id ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {ws.can("tasks.create") || ws.can("tasks.create_own") ? <NewTask onCreated={(t) => res.setData((p) => (p ? { ...p, data: [t, ...p.data] } : p))} /> : null}
      <div className="ws-toolbar">
        <div className="ws-search sm">
          <Search aria-hidden="true" />
          <label className="visually-hidden" htmlFor="tasks-q">
            Search tasks
          </label>
          <input id="tasks-q" type="search" placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="ws-segmented" role="group" aria-label="Status">
          <button type="button" aria-pressed={status === "open"} onClick={() => setStatus("open")}>
            Open
          </button>
          <button type="button" aria-pressed={status === "done"} onClick={() => setStatus("done")}>
            Done
          </button>
        </div>
      </div>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <LoadingState /> : null}
      {res.data && tasks.length === 0 ? (
        <EmptyState icon={CheckCheck} title={status === "open" ? "No open tasks here" : "Nothing done yet"}>
          {status === "open" ? "Tasks assigned to you, or shared with the team, appear in these lists." : undefined}
        </EmptyState>
      ) : null}
      {groups.map(({ g, items }) => (
        <section key={g} className="ws-task-group" aria-label={g}>
          <h2 className={`ws-group-title${g === "Overdue" ? " ws-overdue" : ""}`}>
            {g} <span className="count">{items.length}</span>
          </h2>
          <ul className="ws-list ws-card">
            {items.map((t) => (
              <li key={t.id} className={`ws-task-row${t.status === "done" ? " done" : ""}`}>
                <TaskCheck task={t} onDone={replace} />
                <div className="ws-row-main">
                  <span className="ws-row-title">
                    {t.title} <DemoBadge show={t.is_demo} />
                  </span>
                  <span className="ws-row-meta">
                    <span className={t.is_overdue ? "ws-overdue" : ""}>{t.due_at ? formatWhen(t.due_at) : "No due date"}</span>
                    {" · "}
                    <UserLabel user={t.assignee} />
                    {t.contact ? (
                      <>
                        {" · "}
                        <a href={areaHash("contacts", t.contact.id)}>{t.contact.display_name}</a>
                      </>
                    ) : null}
                    {t.opportunity ? ` · ${t.opportunity.name}` : ""}
                    {t.source === "ai_suggestion_confirmed" ? " · suggested by AI, confirmed" : ""}
                  </span>
                </div>
                <PriorityBadge priority={t.priority} />
                {t.permissions.delete ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm danger"
                    aria-label={`Delete task ${t.title}`}
                    title="Delete"
                    onClick={async () => {
                      try {
                        await ws.api.delete(`${ws.crm}/tasks/${t.id}`);
                        res.setData((p) => (p ? { ...p, data: p.data.filter((x) => x.id !== t.id) } : p));
                        ui.toast({ kind: "success", title: "Task deleted", body: t.title });
                      } catch (e) {
                        ui.toast({ kind: "error", title: "Couldn't delete the task", body: describeError(e) });
                      }
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TasksArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <TasksPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "tasks",
  label: "Tasks",
  icon: ListChecks,
  order: 80,
  status: "ready",
  mobile: true,
  feature: "crm",
  summary: "Your tasks and the team's, by due date.",
  component: TasksArea,
});
