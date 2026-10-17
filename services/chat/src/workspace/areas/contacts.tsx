/** Contacts: list with search and filters | detail with the timeline | create and edit. */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  Briefcase,
  Contact as ContactIcon,
  Lock,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Search,
  ShieldAlert,
  StickyNote,
  Tag as TagIcon,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { useUi } from "../../components/UiContext";
import { navigate } from "../../hooks/useRoute";
import { roomHash } from "../../lib/matrix-id";
import { Spinner } from "../../components/primitives/Spinner";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Activity, Contact, FieldDefinition, Opportunity, Page, Tag, Task } from "../types";
import {
  ConnectionGate,
  DemoBadge,
  EmptyState,
  ErrorState,
  KIND_LABEL,
  KindBadge,
  LoadingState,
  PriorityBadge,
  ROLE_LABEL,
  UserLabel,
  formatMoney,
  formatWhen,
  fromLocalInput,
  initials,
  toLocalInput,
} from "../ui";
import { TaskCheck } from "./home";

// --- timeline -----------------------------------------------------------------------------

const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  meeting: "Meeting",
  email: "Email",
  message_link: "Chat",
  stage_change: "Stage",
  task_event: "Task",
  integration_event: "Integration",
};

export function ActivityItem({ a, showRecord = false }: { a: Activity; showRecord?: boolean }) {
  return (
    <li className={`ws-tl-item ws-tl-${a.kind}`}>
      <span className="ws-tl-dot" aria-hidden="true" />
      <div className="ws-tl-body">
        <div className="ws-tl-head">
          <span className="ws-tl-kind">{ACTIVITY_LABEL[a.kind] ?? a.kind}</span>
          <span className="ws-tl-summary">{a.summary}</span>
          <DemoBadge show={a.is_demo} />
          {a.untrusted ? (
            <span className="badge badge-warning" title="This came from outside the workspace (e.g. an email). Treat it as unverified.">
              <ShieldAlert aria-hidden="true" /> External
            </span>
          ) : null}
        </div>
        {a.body ? <p className="ws-tl-text">{a.body}</p> : null}
        <p className="ws-tl-meta">
          <time dateTime={a.occurred_at}>{formatWhen(a.occurred_at)}</time>
          {a.actor ? ` · ${a.actor.name}` : a.source !== "native" && a.source !== "system" ? ` · via ${a.source}` : ""}
          {showRecord && a.contact ? (
            <>
              {" · "}
              <a href={areaHash("contacts", a.contact.id)}>{a.contact.display_name}</a>
            </>
          ) : null}
          {showRecord && a.opportunity ? ` · ${a.opportunity.name}` : ""}
          {a.kind === "message_link" && a.room_id ? (
            <>
              {" · "}
              <a href={roomHash(a.room_id)}>Open conversation</a>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function AddActivity({ contactId, onAdded }: { contactId: string; onAdded: (a: Activity) => void }) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const [kind, setKind] = useState("note");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!summary.trim()) {
      setErr("Write a short summary.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const a = await api.post<Activity>(`${crm}/activities`, { kind, summary, body, contact_id: contactId });
      onAdded(a);
      setSummary("");
      setBody("");
      ui.toast({ kind: "success", title: "Added to the timeline" });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.field("summary") ?? describeError(e2)) : describeError(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ws-add-activity" onSubmit={submit} aria-label="Add to the timeline">
      <div className="ws-inline-fields">
        <label className="visually-hidden" htmlFor={`${id}-kind`}>
          Type
        </label>
        <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
        </select>
        <label className="visually-hidden" htmlFor={`${id}-sum`}>
          Summary
        </label>
        <input
          id={`${id}-sum`}
          type="text"
          placeholder="What happened?"
          value={summary}
          maxLength={300}
          onChange={(e) => setSummary(e.target.value)}
          aria-invalid={err ? "true" : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
        />
      </div>
      <label className="visually-hidden" htmlFor={`${id}-body`}>
        Details (optional)
      </label>
      <textarea id={`${id}-body`} rows={2} placeholder="Details (optional)" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
      {err ? (
        <p id={`${id}-err`} className="form-error" role="alert">
          {err}
        </p>
      ) : null}
      <div className="cluster">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {busy ? <Spinner size="sm" /> : <StickyNote aria-hidden="true" />} Add
        </button>
      </div>
    </form>
  );
}

// --- detail ---------------------------------------------------------------------------------

function Section({ title, icon: Icon, children, action }: { title: string; icon?: typeof Users; children: ReactNode; action?: ReactNode }) {
  const id = useId();
  return (
    <section className="ws-section" aria-labelledby={id}>
      <header className="ws-section-header">
        <h3 id={id}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function QuickTask({ contactId, onAdded }: { contactId: string; onAdded: (t: Task) => void }) {
  const { api, crm, can } = useWorkspace();
  const ui = useUi();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  if (!can("tasks.create") && !can("tasks.create_own")) return null;
  return (
    <form
      className="ws-inline-fields"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        try {
          onAdded(await api.post<Task>(`${crm}/tasks`, { title, contact_id: contactId, due_at: fromLocalInput(due) }));
          setTitle("");
          setDue("");
          ui.toast({ kind: "success", title: "Task added" });
        } catch (err) {
          ui.toast({ kind: "error", title: "Couldn't add the task", body: describeError(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="visually-hidden" htmlFor={`${id}-t`}>
        New task
      </label>
      <input id={`${id}-t`} type="text" placeholder="Add a task…" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <label className="visually-hidden" htmlFor={`${id}-d`}>
        Due
      </label>
      <input id={`${id}-d`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      <button type="submit" className="btn btn-sm" disabled={busy || !title.trim()}>
        <Plus aria-hidden="true" /> Add
      </button>
    </form>
  );
}

function customValue(def: FieldDefinition | undefined, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (def?.field_type === "boolean") return value ? "Yes" : "No";
  if (def?.field_type === "currency") return formatMoney(String(value));
  if (def?.field_type === "select") return def.options.find((o) => o.value === value)?.label ?? String(value);
  if (def?.field_type === "multiselect" && Array.isArray(value)) return value.map((v) => def.options.find((o) => o.value === v)?.label ?? v).join(", ");
  return String(value);
}

function ContactDetail({ id, fields, onDeleted }: { id: string; fields: FieldDefinition[]; onDeleted: (id: string) => void }) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const contact = useApiResource((a, signal) => a.get<Contact>(`${crm}/contacts/${id}`, undefined, signal), [crm, id]);
  const timeline = useApiResource((a, signal) => a.list<Activity>(`${crm}/activities`, { contact: id, limit: 50 }, signal), [crm, id]);
  const tasks = useApiResource((a, signal) => a.list<Task>(`${crm}/tasks`, { contact: id, scope: "team", status: "open" }, signal), [crm, id]);
  const deals = useApiResource((a, signal) => a.list<Opportunity>(`${crm}/opportunities`, { contact: id }, signal), [crm, id]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (contact.data) headingRef.current?.focus();
  }, [contact.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (contact.error) return <ErrorState error={contact.error} onRetry={contact.reload} />;
  const c = contact.data;
  if (!c) return <LoadingState />;
  const defs = new Map(fields.map((f) => [f.key, f]));
  const customKeys = Object.keys(c.custom_fields ?? {});
  return (
    <article className="ws-detail" aria-labelledby="contact-title">
      <header className="ws-detail-header">
        <a href={areaHash("contacts")} className="icon-btn ws-back" aria-label="Back to contacts">
          <ArrowLeft aria-hidden="true" />
        </a>
        <span className="ws-avatar" aria-hidden="true">
          {initials(c.display_name)}
        </span>
        <div className="ws-detail-titles">
          <h2 id="contact-title" tabIndex={-1} ref={headingRef}>
            {c.display_name}
          </h2>
          <p className="muted small">{[c.job_title, c.company].filter(Boolean).join(" · ") || KIND_LABEL[c.kind]}</p>
          <div className="cluster ws-badges">
            <KindBadge kind={c.kind} />
            <PriorityBadge priority={c.priority} />
            {c.visibility === "private" ? (
              <span className="badge" title="Only the owner, assignees and managers can see this contact">
                <Lock aria-hidden="true" /> Private
              </span>
            ) : null}
            {c.roles.map((r) => (
              <span key={r} className="badge">
                {ROLE_LABEL[r] ?? r}
              </span>
            ))}
            <DemoBadge show={c.is_demo} />
          </div>
        </div>
        <div className="ws-detail-actions">
          {c.permissions.change ? (
            <a className="btn btn-sm" href={areaHash("contacts", c.id, "edit")}>
              <Pencil aria-hidden="true" /> Edit
            </a>
          ) : null}
          {c.permissions.delete ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={async () => {
                if (!window.confirm(`Delete ${c.display_name}? Their timeline is deleted too.`)) return;
                try {
                  await api.delete(`${crm}/contacts/${c.id}`);
                  ui.toast({ kind: "success", title: "Contact deleted", body: c.display_name });
                  onDeleted(c.id);
                } catch (e) {
                  ui.toast({ kind: "error", title: "Couldn't delete the contact", body: describeError(e) });
                }
              }}
            >
              <Trash2 aria-hidden="true" /> Delete
            </button>
          ) : null}
        </div>
      </header>

      <div className="ws-detail-grid">
        <div className="ws-detail-main">
          <Section title="Open tasks" icon={UserRound}>
            {tasks.data?.data.length ? (
              <ul className="ws-list">
                {tasks.data.data.map((t) => (
                  <li key={t.id} className={`ws-task-row${t.status === "done" ? " done" : ""}`}>
                    <TaskCheck
                      task={t}
                      onDone={(u) => tasks.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === u.id ? u : x)) } : p))}
                    />
                    <div className="ws-row-main">
                      <span className="ws-row-title">{t.title}</span>
                      <span className="ws-row-meta">
                        <span className={t.is_overdue ? "ws-overdue" : ""}>{t.due_at ? formatWhen(t.due_at) : "No due date"}</span> · <UserLabel user={t.assignee} />
                      </span>
                    </div>
                    <PriorityBadge priority={t.priority} />
                  </li>
                ))}
              </ul>
            ) : tasks.loading ? (
              <LoadingState />
            ) : (
              <p className="muted small">No open tasks.</p>
            )}
            <QuickTask contactId={c.id} onAdded={(t) => tasks.setData((p) => (p ? { ...p, data: [t, ...p.data] } : p))} />
          </Section>

          <Section title="Timeline" icon={MessageSquare}>
            <AddActivity contactId={c.id} onAdded={(a) => timeline.setData((p) => (p ? { ...p, data: [a, ...p.data] } : p))} />
            {timeline.error ? <ErrorState error={timeline.error} onRetry={timeline.reload} compact /> : null}
            {timeline.data ? (
              timeline.data.data.length ? (
                <ol className="ws-timeline">
                  {timeline.data.data.map((a) => (
                    <ActivityItem key={a.id} a={a} />
                  ))}
                </ol>
              ) : (
                <p className="muted small">Nothing on the timeline yet.</p>
              )
            ) : (
              <LoadingState />
            )}
          </Section>
        </div>

        <aside className="ws-detail-side" aria-label="Contact details">
          <dl className="ws-kv">
            <dt>Email</dt>
            <dd>
              {c.email ? (
                <a href={`mailto:${c.email}`}>
                  <Mail aria-hidden="true" className="inline-icon" /> {c.email}
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt>Phone</dt>
            <dd>
              {c.phone ? (
                <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>
                  <Phone aria-hidden="true" className="inline-icon" /> {c.phone}
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt>Owner</dt>
            <dd>
              <UserLabel user={c.owner} fallback="No owner" />
            </dd>
            <dt>Assigned</dt>
            <dd>{c.assignees.length ? c.assignees.map((u) => u.name).join(", ") : "—"}</dd>
            <dt>Follow up</dt>
            <dd className={c.follow_up_at && new Date(c.follow_up_at) < new Date() ? "ws-overdue" : ""}>{c.follow_up_at ? formatWhen(c.follow_up_at) : "—"}</dd>
            <dt>Source</dt>
            <dd>{[c.source, c.campaign].filter(Boolean).join(" · ") || "—"}</dd>
            {customKeys.map((k) => (
              <div key={k} className="ws-kv-row">
                <dt>{defs.get(k)?.label ?? k}</dt>
                <dd>{customValue(defs.get(k), c.custom_fields[k])}</dd>
              </div>
            ))}
          </dl>
          <div className="ws-side-block">
            <h3>
              <TagIcon aria-hidden="true" /> Tags
            </h3>
            {c.tags.length ? (
              <div className="cluster">
                {c.tags.map((t) => (
                  <span key={t.id} className={`ws-tag ws-tag-${t.color}`}>
                    {t.name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted small">No tags.</p>
            )}
          </div>
          <div className="ws-side-block">
            <h3>
              <Briefcase aria-hidden="true" /> Deals
            </h3>
            {deals.data?.data.length ? (
              <ul className="ws-list compact">
                {deals.data.data.map((o) => (
                  <li key={o.id}>
                    <a className="ws-row-link" href={areaHash("pipelines", o.pipeline_id)}>
                      <span className="ws-row-main">
                        <span className="ws-row-title">{o.name}</span>
                        <span className="ws-row-meta">
                          {o.stage.name} · {formatMoney(o.value, o.currency)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No deals.</p>
            )}
          </div>
          <p className="xsmall subtle">
            Updated {formatWhen(c.updated_at)}
            <button type="button" className="link-button xsmall" onClick={() => contact.reload()}>
              Refresh
            </button>
          </p>
        </aside>
      </div>
    </article>
  );
}

// --- form -------------------------------------------------------------------------------------

interface FormState {
  first_name: string;
  last_name: string;
  company: string;
  job_title: string;
  email: string;
  phone: string;
  kind: string;
  roles: string[];
  priority: string;
  visibility: string;
  owner_id: string;
  assignee_ids: string[];
  source: string;
  campaign: string;
  follow_up_at: string;
  tag_ids: string[];
  custom_fields: Record<string, unknown>;
}

function initialForm(c: Contact | null, meId: string): FormState {
  return {
    first_name: c?.first_name ?? "",
    last_name: c?.last_name ?? "",
    company: c?.company ?? "",
    job_title: c?.job_title ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    kind: c?.kind ?? "lead",
    roles: c?.roles ?? [],
    priority: c?.priority ?? "normal",
    visibility: c?.visibility ?? "team",
    owner_id: c ? (c.owner?.id ?? "") : meId,
    assignee_ids: c?.assignees.map((u) => u.id) ?? [],
    source: c?.source ?? "",
    campaign: c?.campaign ?? "",
    follow_up_at: toLocalInput(c?.follow_up_at ?? null),
    tag_ids: c?.tags.map((t) => t.id) ?? [],
    custom_fields: { ...(c?.custom_fields ?? {}) },
  };
}

function Field({ id, label, error, children, hint }: { id: string; label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p className="xsmall subtle" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" id={`${id}-err`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CustomInput({ def, value, onChange, id }: { def: FieldDefinition; value: unknown; onChange: (v: unknown) => void; id: string }) {
  const str = value === null || value === undefined ? "" : String(value);
  switch (def.field_type) {
    case "boolean":
      return (
        <select id={id} value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "select":
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "long_text":
      return <textarea id={id} rows={3} value={str} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <input id={id} type="date" value={str} onChange={(e) => onChange(e.target.value || null)} />;
    case "number":
      return <input id={id} type="number" step="1" value={str} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "decimal":
    case "currency":
      return <input id={id} type="text" inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />;
    default:
      return <input id={id} type={def.field_type === "email" ? "email" : def.field_type === "url" ? "url" : "text"} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ContactForm({ existing, fields, tags, onSaved, onCancel, onTagCreated }: {
  existing: Contact | null;
  fields: FieldDefinition[];
  tags: Tag[];
  onSaved: (c: Contact) => void;
  onCancel: () => void;
  onTagCreated: (t: Tag) => void;
}) {
  const ws = useWorkspace();
  const ui = useUi();
  const [form, setForm] = useState<FormState>(() => initialForm(existing, ws.me?.user.id ?? ""));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [newTag, setNewTag] = useState("");
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: "roles" | "assignee_ids" | "tag_ids", v: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));
  const id = (k: string) => `${uid}-${k}`;
  const err = (k: string) => errors[k];
  const aria = (k: string) => (errors[k] ? { "aria-invalid": "true" as const, "aria-describedby": `${id(k)}-err` } : {});
  const defs = fields.filter((f) => !f.archived);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body: Record<string, unknown> = { ...form, follow_up_at: fromLocalInput(form.follow_up_at), owner_id: form.owner_id || null };
    const custom: Record<string, unknown> = {};
    for (const d of defs) {
      const v = form.custom_fields[d.key];
      if (v !== undefined && !(v === "" && !existing?.custom_fields[d.key])) custom[d.key] = v === "" ? null : v;
    }
    body.custom_fields = custom;
    try {
      const saved = existing
        ? await ws.api.patch<Contact>(`${ws.crm}/contacts/${existing.id}`, body)
        : await ws.api.post<Contact>(`${ws.crm}/contacts`, body);
      ui.toast({ kind: "success", title: existing ? "Contact saved" : "Contact created", body: saved.display_name });
      onSaved(saved);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "validation_error") {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(e2.fields)) next[k.replace(/^custom_fields\./, "cf_")] = v[0];
        setErrors(next);
        requestAnimationFrame(() => (formRef.current?.querySelector("[aria-invalid='true']") as HTMLElement | null)?.focus());
      } else {
        ui.toast({ kind: "error", title: "Couldn't save the contact", body: describeError(e2) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="ws-form" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
      <header className="ws-detail-header">
        <button type="button" className="icon-btn ws-back" aria-label="Cancel" onClick={onCancel}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <div className="ws-detail-titles">
          <h2 id={`${uid}-title`}>{existing ? `Edit ${existing.display_name}` : "New contact"}</h2>
          <p className="muted small">A name, a company or an email address is enough to start.</p>
        </div>
      </header>
      {Object.keys(errors).length ? (
        <div className="alert alert-danger" role="alert">
          <ShieldAlert aria-hidden="true" />
          <p>Check the highlighted fields.</p>
        </div>
      ) : null}
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Who</legend>
        <Field id={id("first_name")} label="First name" error={err("first_name")}>
          <input id={id("first_name")} type="text" autoComplete="off" value={form.first_name} maxLength={80} onChange={(e) => set("first_name", e.target.value)} {...aria("first_name")} />
        </Field>
        <Field id={id("last_name")} label="Last name" error={err("last_name")}>
          <input id={id("last_name")} type="text" autoComplete="off" value={form.last_name} maxLength={80} onChange={(e) => set("last_name", e.target.value)} {...aria("last_name")} />
        </Field>
        <Field id={id("company")} label="Company" error={err("company")}>
          <input id={id("company")} type="text" value={form.company} maxLength={120} onChange={(e) => set("company", e.target.value)} {...aria("company")} />
        </Field>
        <Field id={id("job_title")} label="Job title" error={err("job_title")}>
          <input id={id("job_title")} type="text" value={form.job_title} maxLength={120} onChange={(e) => set("job_title", e.target.value)} {...aria("job_title")} />
        </Field>
        <Field id={id("email")} label="Email" error={err("email")}>
          <input id={id("email")} type="email" value={form.email} maxLength={254} onChange={(e) => set("email", e.target.value)} {...aria("email")} />
        </Field>
        <Field id={id("phone")} label="Phone" error={err("phone")}>
          <input id={id("phone")} type="tel" value={form.phone} maxLength={40} onChange={(e) => set("phone", e.target.value)} {...aria("phone")} />
        </Field>
      </fieldset>
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Relationship</legend>
        <Field id={id("kind")} label="Type" error={err("kind")}>
          <select id={id("kind")} value={form.kind} onChange={(e) => set("kind", e.target.value)}>
            {Object.entries(KIND_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id("priority")} label="Priority" error={err("priority")}>
          <select id={id("priority")} value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field id={id("owner")} label="Owner" error={err("owner_id")}>
          <select id={id("owner")} value={form.owner_id} onChange={(e) => set("owner_id", e.target.value)} {...aria("owner_id")}>
            <option value="">No owner</option>
            {ws.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id("follow")} label="Follow up" error={err("follow_up_at")}>
          <input id={id("follow")} type="datetime-local" value={form.follow_up_at} onChange={(e) => set("follow_up_at", e.target.value)} {...aria("follow_up_at")} />
        </Field>
        <Field id={id("visibility")} label="Who can see it" error={err("visibility")}>
          <select id={id("visibility")} value={form.visibility} onChange={(e) => set("visibility", e.target.value)}>
            <option value="team">The whole team</option>
            <option value="private">Owner, assignees and managers</option>
          </select>
        </Field>
        <Field id={id("source")} label="Source" error={err("source")}>
          <input id={id("source")} type="text" value={form.source} maxLength={60} onChange={(e) => set("source", e.target.value)} placeholder="Website form, referral…" />
        </Field>
        <Field id={id("campaign")} label="Campaign" error={err("campaign")}>
          <input id={id("campaign")} type="text" value={form.campaign} maxLength={120} onChange={(e) => set("campaign", e.target.value)} />
        </Field>
      </fieldset>
      <fieldset className="ws-chip-set">
        <legend className="ws-legend">Roles</legend>
        {Object.entries(ROLE_LABEL).map(([v, l]) => (
          <label key={v} className="ws-chip-check">
            <input type="checkbox" checked={form.roles.includes(v)} onChange={() => toggle("roles", v)} /> {l}
          </label>
        ))}
      </fieldset>
      <fieldset className="ws-chip-set">
        <legend className="ws-legend">Assigned to</legend>
        {ws.members.map((m) => (
          <label key={m.id} className="ws-chip-check">
            <input type="checkbox" checked={form.assignee_ids.includes(m.id)} onChange={() => toggle("assignee_ids", m.id)} /> {m.name}
          </label>
        ))}
        {err("assignee_ids") ? <p className="form-error">{err("assignee_ids")}</p> : null}
      </fieldset>
      <fieldset className="ws-chip-set">
        <legend className="ws-legend">Tags</legend>
        {tags.map((t) => (
          <label key={t.id} className={`ws-chip-check ws-tag-${t.color}`}>
            <input type="checkbox" checked={form.tag_ids.includes(t.id)} onChange={() => toggle("tag_ids", t.id)} /> {t.name}
          </label>
        ))}
        {ws.can("tags.create") ? (
          <span className="ws-inline-fields ws-new-tag">
            <label className="visually-hidden" htmlFor={id("newtag")}>
              New tag
            </label>
            <input id={id("newtag")} type="text" placeholder="New tag" value={newTag} maxLength={50} onChange={(e) => setNewTag(e.target.value)} />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!newTag.trim()}
              onClick={async () => {
                try {
                  const t = await ws.api.post<Tag>(`${ws.crm}/tags`, { name: newTag });
                  onTagCreated(t);
                  setForm((f) => ({ ...f, tag_ids: [...f.tag_ids, t.id] }));
                  setNewTag("");
                } catch (e2) {
                  ui.toast({ kind: "error", title: "Couldn't create the tag", body: describeError(e2) });
                }
              }}
            >
              <Plus aria-hidden="true" /> Add tag
            </button>
          </span>
        ) : null}
      </fieldset>
      {defs.length ? (
        <fieldset className="ws-form-grid">
          <legend className="ws-legend">More details</legend>
          {defs.map((d) => (
            <Field key={d.key} id={id(`cf_${d.key}`)} label={`${d.label}${d.required ? " (required)" : ""}`} error={err(`cf_${d.key}`)} hint={d.sensitive ? "Sensitive: reads are logged" : undefined}>
              <CustomInput id={id(`cf_${d.key}`)} def={d} value={form.custom_fields[d.key]} onChange={(v) => setForm((f) => ({ ...f, custom_fields: { ...f.custom_fields, [d.key]: v } }))} />
            </Field>
          ))}
        </fieldset>
      ) : null}
      <div className="ws-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner size="sm" /> : null} {existing ? "Save changes" : "Create contact"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- page ------------------------------------------------------------------------------------

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Arrow keys move between the links of a list (roving focus). */
export function listKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

function ContactsPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [tag, setTag] = useState("");
  const [extra, setExtra] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const dq = useDebounced(q);
  const filters = useMemo(
    () => ({ q: dq, kind, owner: mine ? "me" : "", follow_up: overdue ? "overdue" : "", tag, limit: 50 }),
    [dq, kind, mine, overdue, tag],
  );
  const list = useApiResource((api, signal) => api.list<Contact>(`${ws.crm}/contacts`, filters, signal), [ws.crm, filters]);
  const tags = useApiResource((api, signal) => api.list<Tag>(`${ws.crm}/tags`, { limit: 200 }, signal), [ws.crm]);
  const fields = useApiResource((api, signal) => api.list<FieldDefinition>(`${ws.crm}/fields`, { entity: "contact" }, signal), [ws.crm]);
  useEffect(() => {
    setExtra([]);
    setCursor(list.data?.page.next_cursor ?? null);
  }, [list.data]);

  const selected = path[0] && path[0] !== "new" ? path[0] : null;
  const editing = path[1] === "edit";
  const creating = path[0] === "new";
  const rows = [...(list.data?.data ?? []), ...extra];
  const fieldDefs = fields.data?.data ?? [];
  const tagList = tags.data?.data ?? [];
  const existing = editing ? rows.find((r) => r.id === selected) ?? null : null;
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  useEffect(() => {
    if (!editing || !selected) {
      setEditTarget(null);
      return;
    }
    if (existing) {
      setEditTarget(existing);
      return;
    }
    const ctrl = new AbortController();
    ws.api.get<Contact>(`${ws.crm}/contacts/${selected}`, undefined, ctrl.signal).then(setEditTarget).catch(() => undefined);
    return () => ctrl.abort();
  }, [editing, selected, existing, ws.api, ws.crm]);

  const upsert = (c: Contact) => {
    list.setData((p) => (p ? { ...p, data: p.data.some((x) => x.id === c.id) ? p.data.map((x) => (x.id === c.id ? c : x)) : [c, ...p.data] } : p));
    setExtra((e) => e.map((x) => (x.id === c.id ? c : x)));
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page: Page<Contact> = await ws.api.list<Contact>(`${ws.crm}/contacts`, { ...filters, cursor });
      setExtra((e) => [...e, ...page.data]);
      setCursor(page.page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  };
  const showDetail = !!selected || creating;

  return (
    <div className="ws-split" data-detail={showDetail ? "open" : "closed"}>
      <section className="ws-list-pane" aria-label="Contacts">
        <header className="ws-list-header">
          <div className="cluster-between">
            <h1 className="ws-list-title">
              <ContactIcon aria-hidden="true" /> Contacts
            </h1>
            {ws.can("records.create") ? (
              <a className="btn btn-sm btn-primary" href={areaHash("contacts", "new")}>
                <Plus aria-hidden="true" /> New
              </a>
            ) : null}
          </div>
          <div className="ws-search">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="contacts-q">
              Search contacts
            </label>
            <input id="contacts-q" type="search" placeholder="Search name, company, email, phone" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </div>
          <div className="ws-filters" role="group" aria-label="Filters">
            <label className="visually-hidden" htmlFor="contacts-kind">
              Type
            </label>
            <select id="contacts-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All types</option>
              {Object.entries(KIND_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <label className="visually-hidden" htmlFor="contacts-tag">
              Tag
            </label>
            <select id="contacts-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {tagList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
              Mine
            </button>
            <button type="button" className="chip" aria-pressed={overdue} onClick={() => setOverdue((v) => !v)}>
              Follow-up overdue
            </button>
          </div>
        </header>
        <div className="ws-list-scroll" onKeyDown={listKeys}>
          {list.error ? <ErrorState error={list.error} onRetry={list.reload} compact /> : null}
          {list.loading && !list.data ? <LoadingState /> : null}
          {list.data && rows.length === 0 ? (
            <EmptyState icon={Users} title={dq || kind || mine || overdue || tag ? "No contacts match" : "No contacts yet"}>
              {dq || kind || mine || overdue || tag ? "Try fewer filters." : ws.can("records.create") ? "Create your first contact." : "Contacts shared with the team show up here."}
            </EmptyState>
          ) : null}
          <p className="visually-hidden" aria-live="polite">
            {list.data ? `${list.data.page.total} contacts` : ""}
          </p>
          <ul className="ws-records">
            {rows.map((c) => (
              <li key={c.id}>
                <a
                  data-nav-item
                  href={areaHash("contacts", c.id)}
                  className={`ws-record${c.id === selected ? " active" : ""}`}
                  aria-current={c.id === selected ? "page" : undefined}
                >
                  <span className="ws-avatar sm" aria-hidden="true">
                    {initials(c.display_name)}
                  </span>
                  <span className="ws-record-main">
                    <span className="ws-record-top">
                      <span className="ws-row-title">{c.display_name}</span>
                      {c.visibility === "private" ? <Lock aria-label="Private" className="inline-icon subtle" /> : null}
                      <PriorityBadge priority={c.priority} />
                    </span>
                    <span className="ws-row-meta">
                      {KIND_LABEL[c.kind]}
                      {c.company ? ` · ${c.company}` : ""}
                      {c.follow_up_at ? (
                        <span className={new Date(c.follow_up_at) < new Date() ? "ws-overdue" : ""}> · Follow up {formatWhen(c.follow_up_at, { time: false })}</span>
                      ) : null}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {cursor ? (
            <div className="ws-load-more">
              <button type="button" className="btn btn-sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <Spinner size="sm" /> : null} Load more
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <section className="ws-detail-pane" aria-label="Contact">
        {creating ? (
          <ContactForm
            existing={null}
            fields={fieldDefs}
            tags={tagList}
            onTagCreated={(t) => tags.setData((p) => (p ? { ...p, data: [...p.data, t] } : p))}
            onSaved={(c) => {
              upsert(c);
              navigate(areaHash("contacts", c.id));
            }}
            onCancel={() => navigate(areaHash("contacts"))}
          />
        ) : editing && selected ? (
          editTarget ? (
            <ContactForm
              key={editTarget.id}
              existing={editTarget}
              fields={fieldDefs}
              tags={tagList}
              onTagCreated={(t) => tags.setData((p) => (p ? { ...p, data: [...p.data, t] } : p))}
              onSaved={(c) => {
                upsert(c);
                navigate(areaHash("contacts", c.id));
              }}
              onCancel={() => navigate(areaHash("contacts", selected))}
            />
          ) : (
            <LoadingState />
          )
        ) : selected ? (
          <ContactDetail
            key={selected}
            id={selected}
            fields={fieldDefs}
            onDeleted={(id) => {
              list.setData((p) => (p ? { ...p, data: p.data.filter((x) => x.id !== id) } : p));
              navigate(areaHash("contacts"));
            }}
          />
        ) : (
          <EmptyState icon={UserRound} title="Select a contact">
            Pick someone from the list to see their details, tasks and timeline.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function ContactsArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <ContactsPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "contacts",
  label: "Contacts",
  icon: ContactIcon,
  order: 50,
  status: "ready",
  mobile: true,
  feature: "crm",
  summary: "People and companies you work with, with their timeline.",
  component: ContactsArea,
});

