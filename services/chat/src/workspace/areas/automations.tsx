/**
 * Automations (owners, admins, managers): rules with internal actions only (assign owner,
 * create task, notify someone in the app, update related tasks), turned on and off here, and
 * their execution history with failures and a manual retry.
 *
 * Routes: #/automations, #/automations/new, #/automations/<rule id>, #/automations/history.
 * External actions (email, Slack, GoHighLevel) are not available yet: they come with the
 * integrations, and will ask for confirmation.
 */

import { useEffect, useId, useState, type FormEvent } from "react";
import { ArrowLeft, CircleAlert, History, Info, Plus, RefreshCw, Trash2, Workflow } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { navigate } from "../../hooks/useRoute";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Page } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, PageHeader, formatWhen } from "../ui";
import { describeRule, executionBadgeClass } from "../verticals/logic";
import { Field, fieldErrors } from "../verticals/shared";
import type { AutomationCatalog, AutomationRule, Execution, RuleAction, RuleCondition } from "../verticals/types";
import { automationBase } from "./notifications";

function useCatalog() {
  const ws = useWorkspace();
  return useApiResource((api, signal) => api.get<AutomationCatalog>(`${automationBase(ws.workspace!.id)}/catalog`, undefined, signal), [ws.workspace?.id]);
}

function Tabs({ active }: { active: string }) {
  return (
    <nav className="ws-tabs" aria-label="Automations">
      <a href={areaHash("automations")} aria-current={active === "rules" ? "page" : undefined}>
        Rules
      </a>
      <a href={areaHash("automations", "history")} aria-current={active === "history" ? "page" : undefined}>
        <History aria-hidden="true" className="inline-icon" /> History &amp; failures
      </a>
    </nav>
  );
}

function ExternalNote({ catalog }: { catalog: AutomationCatalog | null }) {
  return (
    <p className="alert alert-info small vx-callout">
      <Info aria-hidden="true" />
      <span>
        Actions stay inside Nexus: owners, tasks and in-app notifications. {catalog?.external_actions ?? ""} A rule runs with the permissions of the person
        who last saved it.
      </span>
    </p>
  );
}

function RulesList() {
  const ws = useWorkspace();
  const ui = useUi();
  const base = automationBase(ws.workspace!.id);
  const catalog = useCatalog();
  const rules = useApiResource((api, signal) => api.list<AutomationRule>(`${base}/rules`, undefined, signal), [base]);
  const summary = useApiResource((api, signal) => api.get<{ failed: number; retrying: number; blocked: number; succeeded_24h: number }>(`${base}/executions/summary`, undefined, signal), [base]);
  const rows = (rules.data as Page<AutomationRule> | null)?.data ?? [];
  const toggle = async (r: AutomationRule) => {
    try {
      const u = await ws.api.patch<AutomationRule>(`${base}/rules/${r.id}`, { enabled: !r.enabled });
      rules.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === u.id ? u : x)) } : p));
      ui.toast({ kind: "success", title: u.enabled ? "Rule turned on" : "Rule turned off", body: u.name });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't change the rule", body: describeError(e) });
    }
  };
  const s = summary.data;
  return (
    <>
      <ExternalNote catalog={catalog.data} />
      {s && (s.failed || s.retrying) ? (
        <a className="alert alert-warning small vx-callout" href={areaHash("automations", "history")}>
          <CircleAlert aria-hidden="true" />
          <span>
            {s.failed} failed and {s.retrying} waiting to retry. Open the history to see why and retry.
          </span>
        </a>
      ) : null}
      {rules.error ? <ErrorState error={rules.error} onRetry={rules.reload} /> : null}
      {rules.loading && !rules.data ? <LoadingState /> : null}
      {rules.data && rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No automation rules yet" action={<a className="btn btn-sm btn-primary" href={areaHash("automations", "new")}>New rule</a>}>
          For example: give new leads an owner and a follow-up task, or remind attendees before appointments.
        </EmptyState>
      ) : null}
      {rows.length ? (
        <div className="ws-card">
          <ul className="ws-list">
            {rows.map((r) => (
              <li key={r.id} className="vx-rule">
                <div className="vx-rule-top">
                  <a className="ws-row-title" href={areaHash("automations", r.id)}>
                    {r.name}
                  </a>
                  <DemoBadge show={r.is_demo} />
                  {r.last_status ? <span className={`badge ${executionBadgeClass(r.last_status)}`}>Last run: {r.last_status.replace("_", " ")}</span> : null}
                  <label className="vx-switch">
                    <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} aria-label={`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`} />
                    {r.enabled ? "On" : "Off"}
                  </label>
                </div>
                <span className="ws-row-meta">{describeRule(r, catalog.data)}</span>
                <span className="xsmall subtle">
                  Owner: {r.owner?.name ?? "—"} · ran {r.run_count} time{r.run_count === 1 ? "" : "s"}
                  {r.last_run_at ? `, last ${formatWhen(r.last_run_at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ConditionEditor({ value, fields, operators, onChange, onRemove, index }: { value: RuleCondition; fields: string[]; operators: string[]; onChange: (c: RuleCondition) => void; onRemove: () => void; index: number }) {
  const uid = useId();
  const raw = Array.isArray(value.value) ? value.value.join(", ") : String(value.value);
  const parse = (s: string, op: string): RuleCondition["value"] => {
    if (op === "in") return s.split(",").map((x) => x.trim()).filter(Boolean);
    if (s === "true") return true;
    if (s === "false") return false;
    return s;
  };
  return (
    <div className="ws-inline-fields">
      <label className="visually-hidden" htmlFor={`${uid}-f`}>
        Condition {index + 1} field
      </label>
      <select id={`${uid}-f`} value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <label className="visually-hidden" htmlFor={`${uid}-o`}>
        Operator
      </label>
      <select id={`${uid}-o`} value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as RuleCondition["op"], value: parse(raw, e.target.value) })}>
        {operators.map((o) => (
          <option key={o} value={o}>
            {o.replace("_", " ")}
          </option>
        ))}
      </select>
      <label className="visually-hidden" htmlFor={`${uid}-v`}>
        Value
      </label>
      <input id={`${uid}-v`} type="text" value={raw} placeholder={value.op === "in" ? "a, b, c" : "value (true/false for yes/no)"} onChange={(e) => onChange({ ...value, value: parse(e.target.value, value.op) })} />
      <button type="button" className="icon-btn" aria-label={`Remove condition ${index + 1}`} onClick={onRemove}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

function ActionEditor({ value, catalog, allowed, placeholders, onChange, onRemove, index, trigger }: {
  value: RuleAction; catalog: AutomationCatalog; allowed: string[]; placeholders: string[]; onChange: (a: RuleAction) => void; onRemove: () => void; index: number; trigger: string;
}) {
  const { members } = useWorkspace();
  const uid = useId();
  const p = value.params;
  const setP = (patch: Record<string, unknown>) => onChange({ ...value, params: { ...p, ...patch } });
  const people = (k: string, opts: { value: string; label: string }[]) => (
    <select id={`${uid}-${k}`} value={String(p[k] ?? opts[0]?.value ?? "")} onChange={(e) => setP({ [k]: e.target.value })}>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
  return (
    <div className="vx-action-editor">
      <div className="ws-inline-fields">
        <label className="small" htmlFor={`${uid}-t`}>
          Action {index + 1}
        </label>
        <select id={`${uid}-t`} value={value.type} onChange={(e) => onChange({ type: e.target.value as RuleAction["type"], params: {} })}>
          {catalog.actions.filter((a) => allowed.includes(a.value)).map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" aria-label={`Remove action ${index + 1}`} onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>
      {value.type === "assign_owner" ? (
        <>
          <Field id={`${uid}-user_id`} label="New owner">
            <select id={`${uid}-user_id`} value={String(p.user_id ?? "")} onChange={(e) => setP({ user_id: e.target.value })}>
              <option value="">Choose…</option>
              {members.filter((m) => ["owner", "admin", "manager", "agent"].includes(m.role)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="vx-switch">
            <input type="checkbox" checked={p.only_if_unassigned !== false} onChange={(e) => setP({ only_if_unassigned: e.target.checked })} /> Only when it has no owner yet
          </label>
        </>
      ) : null}
      {value.type === "create_task" ? (
        <div className="vx-grid-2">
          <Field id={`${uid}-title`} label="Task title" hint={placeholders.length ? `You can use ${placeholders.join(", ")}` : undefined}>
            <input id={`${uid}-title`} type="text" value={String(p.title ?? "")} maxLength={200} onChange={(e) => setP({ title: e.target.value })} />
          </Field>
          <Field id={`${uid}-assignee`} label="For">
            {people("assignee", catalog.assignees)}
          </Field>
          <Field id={`${uid}-due`} label="Due after (hours, 0 = no due time)">
            <input id={`${uid}-due`} type="number" min={0} max={8760} value={Number(p.due_in_hours ?? 24)} onChange={(e) => setP({ due_in_hours: Math.max(0, Math.min(8760, Number(e.target.value) || 0)) })} />
          </Field>
          <Field id={`${uid}-prio`} label="Priority">
            <select id={`${uid}-prio`} value={String(p.priority ?? "normal")} onChange={(e) => setP({ priority: e.target.value })}>
              {["low", "normal", "high", "urgent"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {value.type === "notify_user" ? (
        <div className="vx-grid-2">
          <Field id={`${uid}-recipient`} label="Notify">
            {people("recipient", catalog.recipients.filter((r) => r.value !== "attendees" || trigger === "appointment.upcoming"))}
          </Field>
          <Field id={`${uid}-ntitle`} label="Message" hint={placeholders.length ? `You can use ${placeholders.join(", ")}` : undefined}>
            <input id={`${uid}-ntitle`} type="text" value={String(p.title ?? "")} maxLength={200} onChange={(e) => setP({ title: e.target.value })} />
          </Field>
        </div>
      ) : null}
      {value.type === "update_related_tasks" ? (
        <div className="ws-inline-fields">
          <label className="visually-hidden" htmlFor={`${uid}-set`}>
            What to do with the tasks
          </label>
          <select id={`${uid}-set`} value={String(p.set_status ?? "done")} onChange={(e) => setP({ set_status: e.target.value })}>
            <option value="done">Complete</option>
            <option value="canceled">Cancel</option>
          </select>
          <label className="vx-switch">
            <input type="checkbox" checked={p.only_automation !== false} onChange={(e) => setP({ only_automation: e.target.checked })} /> only tasks created by automations
          </label>
        </div>
      ) : null}
    </div>
  );
}

function defaultAction(type: string): RuleAction {
  if (type === "create_task") return { type: "create_task", params: { title: "Follow up", assignee: "subject_owner", due_in_hours: 24, priority: "normal" } };
  if (type === "notify_user") return { type: "notify_user", params: { recipient: "subject_owner", title: "" } };
  if (type === "update_related_tasks") return { type: "update_related_tasks", params: { set_status: "done", only_automation: true } };
  return { type: "assign_owner", params: { user_id: "", only_if_unassigned: true } };
}

function RuleEditor({ id }: { id: string | null }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const base = automationBase(ws.workspace!.id);
  const catalog = useCatalog();
  const existing = useApiResource((api, signal) => (id ? api.get<AutomationRule>(`${base}/rules/${id}`, undefined, signal) : Promise.resolve(null)), [base, id]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("lead.created");
  const [conditions, setConditions] = useState<RuleCondition[]>([]);
  const [actions, setActions] = useState<RuleAction[]>([defaultAction("create_task")]);
  const [enabled, setEnabled] = useState(false);
  const [maxRuns, setMaxRuns] = useState(60);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setName(r.name);
    setDescription(r.description);
    setTrigger(r.trigger);
    setConditions(r.conditions);
    setActions(r.actions);
    setEnabled(r.enabled);
    setMaxRuns(r.max_runs_per_hour);
  }, [existing.data]);
  const cat = catalog.data;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={catalog.reload} />;
  if (!cat || (id && !existing.data && !existing.error)) return <LoadingState />;
  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  const t = cat.triggers.find((x) => x.value === trigger) ?? cat.triggers[0];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = { name, description, trigger, conditions, actions, enabled, max_runs_per_hour: maxRuns };
    try {
      const r = id ? await ws.api.patch<AutomationRule>(`${base}/rules/${id}`, body) : await ws.api.post<AutomationRule>(`${base}/rules`, body);
      ui.toast({ kind: "success", title: id ? "Rule saved" : "Rule created", body: r.enabled ? "It's on." : "It's off until you turn it on." });
      navigate(areaHash("automations"));
    } catch (e2) {
      const f = fieldErrors(e2);
      setErrors(f);
      ui.toast({ kind: "error", title: "Couldn't save the rule", body: Object.values(f)[0] ?? describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ws-form" onSubmit={submit} noValidate>
      <header className="ws-detail-header">
        <a href={areaHash("automations")} className="icon-btn" aria-label="Back to rules">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ws-detail-titles">
          <h2>{id ? "Edit rule" : "New rule"}</h2>
          <p className="muted small">{describeRule({ trigger, trigger_label: t.label, conditions, actions }, cat)}</p>
        </div>
        {id ? (
          <div className="ws-detail-actions">
            <button type="button" className="btn btn-sm btn-outline-danger"
              onClick={async () => {
                if (!window.confirm("Delete this rule? Its history goes too.")) return;
                try {
                  await ws.api.delete(`${base}/rules/${id}`);
                  ui.toast({ kind: "success", title: "Rule deleted" });
                  navigate(areaHash("automations"));
                } catch (err) {
                  ui.toast({ kind: "error", title: "Couldn't delete it", body: describeError(err) });
                }
              }}>
              <Trash2 aria-hidden="true" /> Delete
            </button>
          </div>
        ) : null}
      </header>
      <ExternalNote catalog={cat} />
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Rule</legend>
        <Field id={`${uid}-n`} label="Name" error={errors.name}>
          <input id={`${uid}-n`} type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? "true" : undefined} />
        </Field>
        <Field id={`${uid}-t`} label="When" error={errors.trigger}>
          <select id={`${uid}-t`} value={trigger}
            onChange={(e) => {
              const next = cat.triggers.find((x) => x.value === e.target.value)!;
              setTrigger(next.value);
              setConditions([]);
              setActions((a) => a.filter((x) => next.actions.includes(x.type)).length ? a.filter((x) => next.actions.includes(x.type)) : [defaultAction(next.actions[0])]);
            }}>
            {cat.triggers.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${uid}-d`} label="Description (optional)">
          <input id={`${uid}-d`} type="text" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field id={`${uid}-m`} label="At most this many runs per hour" error={errors.max_runs_per_hour}>
          <input id={`${uid}-m`} type="number" min={1} max={1000} value={maxRuns} onChange={(e) => setMaxRuns(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
        </Field>
      </fieldset>
      <section className="ws-section" aria-label="Conditions">
        <header className="ws-section-header">
          <h3>Only if (all must match)</h3>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConditions((c) => [...c, { field: t.condition_fields[0], op: "equals", value: "" }])}>
            <Plus aria-hidden="true" /> Condition
          </button>
        </header>
        {conditions.length === 0 ? <p className="muted small">No conditions: it runs every time.</p> : null}
        {conditions.map((c, i) => (
          <ConditionEditor key={i} index={i} value={c} fields={t.condition_fields} operators={cat.operators} onChange={(x) => setConditions((cs) => cs.map((y, j) => (j === i ? x : y)))}
            onRemove={() => setConditions((cs) => cs.filter((_, j) => j !== i))} />
        ))}
        {Object.entries(errors).filter(([k]) => k.startsWith("conditions")).map(([k, v]) => (
          <p key={k} className="form-error">
            {v}
          </p>
        ))}
      </section>
      <section className="ws-section" aria-label="Actions">
        <header className="ws-section-header">
          <h3>Then</h3>
          {actions.length < 5 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setActions((a) => [...a, defaultAction(t.actions[0])])}>
              <Plus aria-hidden="true" /> Action
            </button>
          ) : null}
        </header>
        {actions.map((a, i) => (
          <ActionEditor key={i} index={i} value={a} catalog={cat} allowed={t.actions} placeholders={t.placeholders} trigger={trigger}
            onChange={(x) => setActions((as) => as.map((y, j) => (j === i ? x : y)))} onRemove={() => setActions((as) => as.filter((_, j) => j !== i))} />
        ))}
        {Object.entries(errors).filter(([k]) => k.startsWith("actions")).map(([k, v]) => (
          <p key={k} className="form-error">
            {v}
          </p>
        ))}
      </section>
      <label className="vx-switch">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Turn the rule on
      </label>
      <div className="ws-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? <Spinner size="sm" /> : null} {id ? "Save rule" : "Create rule"}
        </button>
        <a className="btn btn-ghost" href={areaHash("automations")}>
          Cancel
        </a>
      </div>
    </form>
  );
}

function HistoryView() {
  const ws = useWorkspace();
  const ui = useUi();
  const base = automationBase(ws.workspace!.id);
  const [status, setStatus] = useState("problems");
  const res = useApiResource((api, signal) => api.list<Execution>(`${base}/executions`, { status: status === "all" ? "" : status, limit: 100 }, signal), [base, status]);
  const rows = (res.data as Page<Execution> | null)?.data ?? [];
  return (
    <>
      <div className="ws-toolbar">
        <div className="ws-segmented" role="group" aria-label="Show">
          {[["problems", "Failures & blocked"], ["all", "All runs"], ["succeeded", "Succeeded"], ["skipped", "Skipped"]].map(([v, l]) => (
            <button key={v} type="button" aria-pressed={status === v} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={res.reload}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <p className="xsmall subtle">
        Failed runs retry by themselves after 1, 5 and 30 minutes. Loop protection stops rules that would trigger themselves or each other endlessly, and each
        rule has an hourly limit.
      </p>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <LoadingState /> : null}
      {res.data && rows.length === 0 ? <EmptyState icon={History} title={status === "problems" ? "No failures" : "No runs yet"} /> : null}
      {rows.length ? (
        <div className="ws-card">
          <table className="vx-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Rule</th>
                <th scope="col">Result</th>
                <th scope="col">Details</th>
                <th scope="col">
                  <span className="visually-hidden">Retry</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td>{formatWhen(x.created_at)}</td>
                  <td>
                    <a href={areaHash("automations", x.rule.id)}>{x.rule.name}</a>
                  </td>
                  <td>
                    <span className={`badge ${executionBadgeClass(x.status)}`}>{x.status_label}</span>
                    <div className="xsmall subtle">
                      attempt {x.attempts}
                      {x.next_attempt_at ? ` · next ${formatWhen(x.next_attempt_at)}` : ""}
                    </div>
                  </td>
                  <td className="small">
                    {x.last_error || (x.result.actions ? `${x.result.actions.length} action${x.result.actions.length === 1 ? "" : "s"} done` : "")}
                  </td>
                  <td>
                    {x.can_retry ? (
                      <button type="button" className="btn btn-sm"
                        onClick={async () => {
                          try {
                            const u = await ws.api.post<Execution>(`${base}/executions/${x.id}/retry`, {});
                            ui.toast({ kind: u.status === "succeeded" ? "success" : "error", title: `Retry: ${u.status_label}`, body: u.last_error || undefined });
                            res.reload();
                          } catch (e) {
                            ui.toast({ kind: "error", title: "Couldn't retry", body: describeError(e) });
                          }
                        }}>
                        <RefreshCw aria-hidden="true" /> Retry
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function AutomationsPage({ path }: AreaProps) {
  const tab = path[0] === "history" ? "history" : path[0] ? "editor" : "rules";
  if (tab === "editor") {
    return (
      <div className="ws-area-scroll">
        <RuleEditor key={path[0]} id={path[0] === "new" ? null : path[0]} />
      </div>
    );
  }
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={Workflow} title="Automations" subtitle="Rules that assign, create tasks and notify, inside Nexus."
        actions={<a className="btn btn-sm btn-primary" href={areaHash("automations", "new")}><Plus aria-hidden="true" /> New rule</a>} />
      <Tabs active={tab} />
      {tab === "rules" ? <RulesList /> : <HistoryView />}
    </div>
  );
}

function AutomationsArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <AutomationsPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "automations",
  label: "Automations",
  icon: Workflow,
  order: 125,
  status: "ready",
  feature: "automation",
  capability: "automation.manage",
  summary: "Rules that assign owners, create tasks and send in-app reminders, with their history.",
  component: AutomationsArea,
});
