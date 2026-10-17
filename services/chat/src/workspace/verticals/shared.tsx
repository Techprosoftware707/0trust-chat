/**
 * Building blocks shared by the verticals areas: urgency badges, the milestones/deadlines
 * section (deals and lending applications), record pickers, the event dialog, meeting-room
 * controls (Matrix room + MatrixRTC call), meeting notes and suggested next steps.
 */

import "./verticals.css";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { CalendarClock, CalendarPlus, Check, CircleCheck, DoorOpen, Flag, Info, ListPlus, Lock, NotebookPen, Phone, Plus, Sparkles, Trash2, Video, X } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { openLobby, useRoomCall } from "../../calls/store";
import { useRoom } from "../../hooks/matrix";
import { navigate } from "../../hooks/useRoute";
import { roomHash } from "../../lib/matrix-id";
import { useMatrix } from "../../matrix/context";
import { createGroup } from "../../matrix/rooms";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash } from "../define";
import type { Contact, Opportunity, Page, Task } from "../types";
import { EmptyState, ErrorState, LoadingState, UserLabel, formatWhen, fromLocalInput, toLocalInput } from "../ui";
import { EVENT_KIND_LABEL, URGENCY_LABEL, money, urgencyBadgeClass } from "./logic";
import type { ActionItem, CalendarEventFull, EventKind, MeetingNote, Milestone, Urgency } from "./types";

export function UrgencyBadge({ urgency, quiet = false }: { urgency: Urgency; quiet?: boolean }) {
  if (quiet && (urgency === "upcoming" || urgency === "no_date")) return null;
  return <span className={`badge ${urgencyBadgeClass(urgency)}`}>{URGENCY_LABEL[urgency]}</span>;
}

export function formatDay(iso: string | null): string {
  if (!iso) return "No date";
  const [y, mo, d] = iso.split("-").map(Number);
  return formatWhen(new Date(y, mo - 1, d, 12).toISOString(), { time: false });
}

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.code === "validation_error" ? Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v[0]])) : {};
}

/** A field with label, hint and inline error (accessible: label for, aria-describedby). */
export function Field({ id, label, error, hint, children, className }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`field${className ? ` ${className}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p className="xsmall subtle" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- pickers --------------------------------------------------------------------------------------

/** Search-as-you-type picker over an API list (contacts, deals, properties). */
export function SearchPicker<T extends { id: string }>({
  id, label, placeholder, search, render, onPick, selected, onClear, hideLabel = false,
}: {
  id: string;
  label: string;
  /** Inline use: the label is for screen readers only (the placeholder says it). */
  hideLabel?: boolean;
  placeholder?: string;
  search: (q: string, signal: AbortSignal) => Promise<T[]>;
  render: (row: T) => ReactNode;
  onPick: (row: T) => void;
  selected?: ReactNode;
  onClear?: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setRows([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      search(q, ctrl.signal).then(setRows).catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`field${hideLabel ? " vx-inline-picker" : ""}`}>
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : undefined}>
        {label}
      </label>
      {selected ? (
        <div className="cluster">
          <span className="badge badge-accent">{selected}</span>
          {onClear ? (
            <button type="button" className="link-button small" onClick={onClear}>
              Change
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <input id={id} type="search" placeholder={placeholder ?? "Search"} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          {rows.length ? (
            <ul className="ws-picker" aria-label={`Matches for ${label}`}>
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(r);
                      setQ("");
                      setRows([]);
                    }}
                  >
                    {render(r)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function useContactSearch() {
  const { api, crm } = useWorkspace();
  return async (q: string, signal: AbortSignal) => (await api.list<Contact>(`${crm}/contacts`, { q, limit: 6 }, signal)).data;
}

export function useDealSearch() {
  const { api, crm } = useWorkspace();
  return async (q: string, signal: AbortSignal) => (await api.list<Opportunity>(`${crm}/opportunities`, { q, limit: 6, status: "" }, signal)).data;
}

/** Workspace members as toggle chips (internal attendees). */
export function MemberChips({ value, onChange, legend }: { value: string[]; onChange: (ids: string[]) => void; legend: string }) {
  const { members } = useWorkspace();
  return (
    <fieldset className="ws-chip-set vx-chips">
      <legend className="ws-legend">{legend}</legend>
      {members.map((m) => (
        <label key={m.id} className="ws-chip-check">
          <input
            type="checkbox"
            checked={value.includes(m.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, m.id] : value.filter((x) => x !== m.id))}
          />
          {m.name}
        </label>
      ))}
    </fieldset>
  );
}

// --- milestones and deadlines ------------------------------------------------------------------------

const MILESTONE_TYPES: [string, string][] = [
  ["offer_submitted", "Offer submitted"], ["counter_offer", "Counter-offer"], ["offer_accepted", "Offer accepted"], ["negotiation", "Negotiation"],
  ["earnest_money", "Earnest money"], ["inspection", "Inspection"], ["appraisal", "Appraisal"], ["financing", "Financing contingency"],
  ["title", "Title"], ["final_walkthrough", "Final walk-through"], ["closing", "Closing"], ["application", "Application"],
  ["disclosures", "Disclosures"], ["conditions", "Conditions"], ["rate_lock", "Rate lock"], ["documents", "Documents"], ["custom", "Other"],
];
const TEMPLATE_LABEL: Record<string, string> = { purchase: "Purchase deadlines", listing: "Listing deadlines", lending: "Lending deadlines" };

export function MilestonesSection({
  milestones, parent, canChange, templates, onChanged, currency = "USD", dueSoonDays = 3,
}: {
  milestones: Milestone[];
  parent: { opportunity_id: string } | { application_id: string };
  canChange: boolean;
  templates: string[];
  onChanged: () => void;
  currency?: string;
  dueSoonDays?: number;
}) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("deadline");
  const [mtype, setMtype] = useState("custom");
  const [due, setDue] = useState("");
  const [amount, setAmount] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState(templates[0] ?? "");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const templatePath = "opportunity_id" in parent ? `${crm}/opportunities/${parent.opportunity_id}/deadline-template`
    : `${crm}/lending/applications/${parent.application_id}/deadline-template`;
  const open = milestones.filter((x) => x.status === "pending");
  const done = milestones.filter((x) => x.status !== "pending");
  const attention = open.filter((x) => x.urgency === "overdue" || x.urgency === "due_soon").length;

  // Optimistic: the box changes at once and goes back if the server says no.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const toggle = async (ms: Milestone) => {
    const next = ms.status === "pending";
    setOptimistic((o) => ({ ...o, [ms.id]: next }));
    try {
      await api.patch(`${crm}/milestones/${ms.id}`, { status: next ? "done" : "pending" });
      ui.toast({ kind: "success", title: next ? "Marked done" : "Reopened", body: ms.title });
      onChanged();
    } catch (e) {
      setOptimistic((o) => {
        const { [ms.id]: _drop, ...rest } = o;
        void _drop;
        return rest;
      });
      ui.toast({ kind: "error", title: "Couldn't update the milestone", body: describeError(e) });
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.post(`${crm}/milestones`, { ...parent, title, category, milestone_type: mtype, due_date: due || null, amount: amount.trim() || null, currency });
      ui.toast({ kind: "success", title: category === "deadline" ? "Deadline added" : "Milestone added", body: title });
      setTitle("");
      setDue("");
      setAmount("");
      setAdding(false);
      onChanged();
    } catch (e2) {
      setErrors(fieldErrors(e2));
      if (!Object.keys(fieldErrors(e2)).length) ui.toast({ kind: "error", title: "Couldn't add it", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  const applyTemplate = async () => {
    setBusy(true);
    try {
      const rows = await api.post<Milestone[]>(templatePath, { template, base_date: base || null, currency });
      ui.toast({ kind: "success", title: rows.length ? `${rows.length} deadlines added` : "Nothing to add", body: rows.length ? "Adjust the dates to the contract." : "Those deadlines are there already." });
      onChanged();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't add the deadlines", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const row = (ms: Milestone) => (
    <li key={ms.id} className={`vx-milestone vx-u-${ms.urgency}`}>
      <input
        type="checkbox"
        className="ws-check"
        checked={optimistic[ms.id] ?? ms.status !== "pending"}
        disabled={!ms.permissions.change}
        aria-label={`${ms.status === "pending" ? "Mark done" : "Reopen"}: ${ms.title}`}
        onChange={() => void toggle(ms)}
      />
      <div className="ws-row-main">
        <span className="ws-row-title">
          {ms.category === "milestone" ? <Flag aria-hidden="true" className="inline-icon" /> : <CalendarClock aria-hidden="true" className="inline-icon" />} {ms.title}
        </span>
        <span className="ws-row-meta">
          {formatDay(ms.due_date)}
          {ms.amount ? ` · ${money(ms.amount, ms.currency)}` : ""}
          {ms.responsible ? ` · ${ms.responsible.name}` : ""}
          {ms.status !== "pending" && ms.completed_by ? ` · done by ${ms.completed_by.name}` : ""}
        </span>
      </div>
      <UrgencyBadge urgency={ms.urgency} quiet />
    </li>
  );
  return (
    <section className="ws-section" aria-labelledby={`${uid}-h`}>
      <header className="ws-section-header">
        <h3 id={`${uid}-h`}>
          <CalendarClock aria-hidden="true" /> Milestones &amp; deadlines
          {attention ? <span className="badge badge-warning">{attention} need attention</span> : null}
        </h3>
        {canChange ? (
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            <Plus aria-hidden="true" /> Add
          </button>
        ) : null}
      </header>
      <p className="xsmall subtle">Highlighted: overdue, or due within {dueSoonDays} days. Dates are what your team enters; check them against the contract.</p>
      {milestones.length === 0 ? <p className="muted small">No milestones or deadlines yet.</p> : null}
      {open.length ? <ul className="ws-list vx-milestones">{open.map(row)}</ul> : null}
      {done.length ? (
        <details className="vx-done">
          <summary className="small">
            {done.length} done or waived
          </summary>
          <ul className="ws-list vx-milestones">{done.map(row)}</ul>
        </details>
      ) : null}
      {adding && canChange ? (
        <form className="vx-inline-form" onSubmit={add} aria-label="Add a milestone or deadline">
          <Field id={`${uid}-t`} label="Title" error={errors.title}>
            <input id={`${uid}-t`} type="text" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} aria-invalid={errors.title ? "true" : undefined} />
          </Field>
          <Field id={`${uid}-c`} label="Kind">
            <select id={`${uid}-c`} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="deadline">Deadline</option>
              <option value="milestone">Milestone (offer, negotiation…)</option>
            </select>
          </Field>
          <Field id={`${uid}-y`} label="Type">
            <select id={`${uid}-y`} value={mtype} onChange={(e) => setMtype(e.target.value)}>
              {MILESTONE_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${uid}-d`} label="Due" error={errors.due_date}>
            <input id={`${uid}-d`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field id={`${uid}-a`} label={`Amount (${currency}, optional)`} error={errors.amount}>
            <input id={`${uid}-a`} type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="cluster vx-form-end">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
              {busy ? <Spinner size="sm" /> : <Plus aria-hidden="true" />} Add
            </button>
          </div>
        </form>
      ) : null}
      {canChange && templates.length ? (
        <div className="vx-template">
          <label className="visually-hidden" htmlFor={`${uid}-tpl`}>
            Standard deadlines
          </label>
          <select id={`${uid}-tpl`} value={template} onChange={(e) => setTemplate(e.target.value)}>
            {templates.map((t) => (
              <option key={t} value={t}>
                {TEMPLATE_LABEL[t] ?? t}
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor={`${uid}-base`}>
            Counted from
          </label>
          <input id={`${uid}-base`} type="date" value={base} onChange={(e) => setBase(e.target.value)} title="Counted from (default: today)" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void applyTemplate()}>
            <ListPlus aria-hidden="true" /> Add standard deadlines
          </button>
        </div>
      ) : null}
    </section>
  );
}

// --- events ---------------------------------------------------------------------------------------------

export interface EventDraft {
  title: string;
  kind: EventKind;
  start: string;
  end: string;
  location: string;
  description: string;
  attendeeIds: string[];
  contact: { id: string; display_name: string } | null;
  opportunity: { id: string; name: string } | null;
  related: { type: string; id: string } | null;
  visibility: "team" | "private";
}

export function draftFromEvent(e: CalendarEventFull): EventDraft {
  return {
    title: e.title, kind: e.kind, start: toLocalInput(e.start_at), end: toLocalInput(e.end_at), location: e.location, description: e.description,
    attendeeIds: e.attendee_users.map((u) => u.id), contact: e.contact, opportunity: e.opportunity, related: e.related, visibility: e.visibility,
  };
}

export function newDraft(start: Date, me: string | undefined, kind: EventKind = "meeting"): EventDraft {
  const s = new Date(start);
  const e = new Date(s.getTime() + 60 * 60_000);
  return { title: "", kind, start: toLocalInput(s.toISOString()), end: toLocalInput(e.toISOString()), location: "", description: "", attendeeIds: me ? [me] : [],
    contact: null, opportunity: null, related: null, visibility: "team" };
}

/** Create or edit a calendar event. Invitations are internal: nobody outside the workspace is
 * emailed (that needs the Gmail integration). */
export function EventDialog({ event, draft, onClose, onSaved }: { event?: CalendarEventFull; draft: EventDraft; onClose: () => void; onSaved: (e: CalendarEventFull) => void }) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [d, setD] = useState<EventDraft>(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const contactSearch = useContactSearch();
  const dealSearch = useDealSearch();
  const set = (patch: Partial<EventDraft>) => setD((x) => ({ ...x, ...patch }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = {
      title: d.title, kind: d.kind, start_at: fromLocalInput(d.start), end_at: fromLocalInput(d.end), location: d.location, description: d.description,
      attendee_user_ids: d.attendeeIds, contact_id: d.contact?.id ?? null, opportunity_id: d.opportunity?.id ?? null, visibility: d.visibility,
      ...(event ? {} : { related: d.related, attendee_contact_ids: d.contact ? [d.contact.id] : [] }),
    };
    try {
      const saved = event ? await api.patch<CalendarEventFull>(`${crm}/events/${event.id}`, body) : await api.post<CalendarEventFull>(`${crm}/events`, body);
      ui.toast({ kind: "success", title: event ? "Event updated" : "Event added", body: saved.title });
      onSaved(saved);
    } catch (e2) {
      const f = fieldErrors(e2);
      setErrors(f);
      if (!Object.keys(f).length) ui.toast({ kind: "error", title: "Couldn't save the event", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={event ? "Edit event" : "New event"} onClose={onClose} dismissible={!busy} size="lg">
      <form className="form vx-event-form" onSubmit={submit} noValidate>
        <Field id={`${uid}-t`} label="Title" error={errors.title}>
          <input id={`${uid}-t`} type="text" value={d.title} maxLength={200} autoFocus onChange={(e) => set({ title: e.target.value })} aria-invalid={errors.title ? "true" : undefined} />
        </Field>
        <div className="vx-grid-2">
          <Field id={`${uid}-k`} label="Kind">
            <select id={`${uid}-k`} value={d.kind} onChange={(e) => set({ kind: e.target.value as EventKind })}>
              {Object.entries(EVENT_KIND_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${uid}-v`} label="Who can see it">
            <select id={`${uid}-v`} value={d.visibility} onChange={(e) => set({ visibility: e.target.value as "team" | "private" })}>
              <option value="team">Shared with the team</option>
              <option value="private">Private (attendees and managers)</option>
            </select>
          </Field>
          <Field id={`${uid}-s`} label="Starts" error={errors.start_at}>
            <input id={`${uid}-s`} type="datetime-local" value={d.start} onChange={(e) => set({ start: e.target.value })} />
          </Field>
          <Field id={`${uid}-e`} label="Ends" error={errors.end_at}>
            <input id={`${uid}-e`} type="datetime-local" value={d.end} onChange={(e) => set({ end: e.target.value })} />
          </Field>
        </div>
        <Field id={`${uid}-l`} label="Location (optional)">
          <input id={`${uid}-l`} type="text" value={d.location} maxLength={200} onChange={(e) => set({ location: e.target.value })} placeholder="Office, address, or “Video call”" />
        </Field>
        <MemberChips legend="Internal attendees" value={d.attendeeIds} onChange={(ids) => set({ attendeeIds: ids })} />
        {errors.attendee_user_ids ? <p className="form-error">{errors.attendee_user_ids}</p> : null}
        <div className="vx-grid-2">
          <SearchPicker
            id={`${uid}-c`}
            label="Contact (optional)"
            placeholder="Search contacts"
            search={contactSearch}
            render={(c) => c.display_name}
            onPick={(c) => set({ contact: { id: c.id, display_name: c.display_name } })}
            selected={d.contact?.display_name}
            onClear={() => set({ contact: null })}
          />
          <SearchPicker
            id={`${uid}-o`}
            label="Deal (optional)"
            placeholder="Search deals"
            search={dealSearch}
            render={(o) => o.name}
            onPick={(o) => set({ opportunity: { id: o.id, name: o.name } })}
            selected={d.opportunity?.name}
            onClear={() => set({ opportunity: null })}
          />
        </div>
        <Field id={`${uid}-d`} label="Agenda (optional)">
          <textarea id={`${uid}-d`} rows={3} value={d.description} maxLength={5000} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <p className="alert alert-info small">
          <Info aria-hidden="true" />
          <span>
            Invitations are internal: attendees see it in their Nexus calendar. Nobody outside the workspace is invited or emailed yet; email invitations
            come with the Gmail integration.
          </span>
        </p>
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size="sm" /> : <CalendarPlus aria-hidden="true" />} {event ? "Save" : "Add to calendar"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// --- the meeting room: a Matrix room with its end-to-end encrypted MatrixRTC call ------------------

export function NoRecordingNote() {
  return (
    <p className="xsmall subtle vx-note">
      <Lock aria-hidden="true" className="inline-icon" /> Calls are end-to-end encrypted. Recording and transcription aren't available: the call server has no
      recording component, and nothing is ever recorded. Write notes below instead.
    </p>
  );
}

export function MeetingRoomControls({ event, onLinked }: { event: CalendarEventFull; onLinked: (e: CalendarEventFull) => void }) {
  const { client, config, userId } = useMatrix();
  const { api, crm, members } = useWorkspace();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const room = useRoom(client, event.matrix_room_id || null);
  const call = useRoomCall(client, room);
  const callsOn = config.calls.enabled;
  const canChange = event.permissions.change;
  const create = async () => {
    setBusy(true);
    try {
      const invite = event.attendee_users
        .map((u) => members.find((m) => m.id === u.id)?.matrix_id ?? u.matrix_id)
        .filter((mx): mx is string => !!mx && mx !== userId);
      const roomId = await createGroup(client, { name: event.title.slice(0, 80), topic: "Meeting room (Nexus calendar)", invite, encrypted: true });
      const saved = await api.patch<CalendarEventFull>(`${crm}/events/${event.id}`, { matrix_room_id: roomId });
      ui.toast({ kind: "success", title: "Meeting room created", body: invite.length ? `${invite.length} attendee${invite.length === 1 ? "" : "s"} invited.` : "Invite people from the room." });
      onLinked(saved);
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't create the meeting room", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  if (!event.matrix_room_id) {
    return (
      <div className="vx-room">
        {canChange ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? <Spinner size="sm" /> : <Video aria-hidden="true" />} Create meeting room
          </button>
        ) : (
          <p className="muted small">No meeting room yet. The organizer can create one.</p>
        )}
        <p className="xsmall subtle">An end-to-end encrypted room; the internal attendees are invited. Only its room ID is saved with the event.</p>
      </div>
    );
  }
  const joined = room?.getMyMembership() === "join";
  return (
    <div className="vx-room">
      <div className="cluster">
        <a className="btn btn-sm" href={roomHash(event.matrix_room_id)}>
          <DoorOpen aria-hidden="true" /> {joined ? "Open meeting room" : "Go to the room invite"}
        </a>
        {callsOn ? (
          <button
            type="button"
            className="btn btn-sm btn-success"
            disabled={!joined}
            title={joined ? undefined : "Join the room first"}
            onClick={() => {
              navigate(roomHash(event.matrix_room_id));
              openLobby({ roomId: event.matrix_room_id, intent: call.intent ?? "video", joining: call.devices > 0 });
            }}
          >
            {call.devices > 0 ? <Phone aria-hidden="true" /> : <Video aria-hidden="true" />} {call.devices > 0 ? `Join call (${call.userIds.length} in it)` : "Start the call"}
          </button>
        ) : (
          <span className="xsmall subtle">Calls aren't enabled on this server.</span>
        )}
      </div>
    </div>
  );
}

// --- meeting notes and suggested next steps ---------------------------------------------------------------

export function MeetingNotesSection({ event, contactId, opportunityId }: { event?: CalendarEventFull; contactId?: string; opportunityId?: string }) {
  const { api, crm, can } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const query = event ? { event: event.id } : contactId ? { contact: contactId } : { opportunity: opportunityId };
  const notes = useApiResource((a, signal) => a.list<MeetingNote>(`${crm}/meetings/notes`, { ...query, limit: 50 }, signal), [crm, JSON.stringify(query)]);
  const [title, setTitle] = useState(event ? `Notes: ${event.title}` : "");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState("team");
  const [busy, setBusy] = useState(false);
  const canWrite = can("events.create");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const n = await api.post<MeetingNote>(`${crm}/meetings/notes`, {
        title, body, visibility, event_id: event?.id ?? null, contact_id: event ? null : contactId ?? null, opportunity_id: event ? null : opportunityId ?? null,
      });
      notes.setData((p) => (p ? { ...p, data: [n, ...p.data] } : p));
      setBody("");
      ui.toast({ kind: "success", title: "Notes saved" });
    } catch (e2) {
      ui.toast({ kind: "error", title: "Couldn't save the notes", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={`${uid}-h`}>
      <header className="ws-section-header">
        <h3 id={`${uid}-h`}>
          <NotebookPen aria-hidden="true" /> Meeting notes
        </h3>
      </header>
      {canWrite ? (
        <form className="ws-add-activity" onSubmit={save} aria-label="Add meeting notes">
          <div className="ws-inline-fields">
            <label className="visually-hidden" htmlFor={`${uid}-t`}>
              Title
            </label>
            <input id={`${uid}-t`} type="text" placeholder="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            <label className="visually-hidden" htmlFor={`${uid}-v`}>
              Who can read them
            </label>
            <select id={`${uid}-v`} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="team">Team</option>
              <option value="attendees">Attendees</option>
              <option value="private">Only me</option>
            </select>
          </div>
          <label className="visually-hidden" htmlFor={`${uid}-b`}>
            Notes
          </label>
          <textarea id={`${uid}-b`} rows={3} placeholder="What was discussed and agreed" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
          <div className="cluster">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !title.trim()}>
              {busy ? <Spinner size="sm" /> : <NotebookPen aria-hidden="true" />} Save notes
            </button>
            <span className="xsmall subtle">Typed by you. Nothing is taken from the call or the chat.</span>
          </div>
        </form>
      ) : null}
      {notes.error ? <ErrorState error={notes.error} onRetry={notes.reload} compact /> : null}
      {notes.loading && !notes.data ? <LoadingState /> : null}
      {notes.data && notes.data.data.length === 0 ? <p className="muted small">No notes yet.</p> : null}
      <ol className="ws-timeline">
        {(notes.data?.data ?? []).map((n) => (
          <li key={n.id} className="ws-tl-item ws-tl-meeting">
            <span className="ws-tl-dot" aria-hidden="true" />
            <div className="ws-tl-body">
              <div className="ws-tl-head">
                <span className="ws-tl-summary">{n.title}</span>
                {n.visibility !== "team" ? <span className="badge">{n.visibility === "attendees" ? "Attendees" : "Only me"}</span> : null}
              </div>
              {n.body ? <p className="ws-tl-text">{n.body}</p> : null}
              <p className="ws-tl-meta">
                {formatWhen(n.created_at)}
                {n.author ? ` · ${n.author.name}` : ""}
                {!event && n.event ? (
                  <>
                    {" · "}
                    <a href={areaHash("calendar", "event", n.event.id)}>{n.event.title}</a>
                  </>
                ) : null}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ActionItemRow({ item, onChanged }: { item: ActionItem; onChanged: (i: ActionItem | null, task?: Task) => void }) {
  const { api, crm, can, members } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [assignee, setAssignee] = useState(item.suggested_assignee?.id ?? "");
  const canConfirm = can("tasks.create") || can("tasks.create_own");
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ item: ActionItem; task: Task }>(`${crm}/action-items/${item.id}/confirm`, assignee ? { assignee_id: assignee } : {});
      ui.toast({ kind: "success", title: "Task created", body: r.task.title });
      onChanged(r.item, r.task);
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't create the task", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      onChanged(await api.post<ActionItem>(`${crm}/action-items/${item.id}/dismiss`, {}));
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't dismiss it", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`vx-action vx-action-${item.status}`}>
      <div className="ws-row-main">
        <span className="ws-row-title">
          {item.source === "ai_suggestion" ? <Sparkles aria-hidden="true" className="inline-icon" /> : null} {item.title}
        </span>
        <span className="ws-row-meta">
          {item.source === "ai_suggestion" ? "Suggested by the AI assistant" : `Suggested by ${item.proposed_by?.name ?? "a teammate"}`}
          {item.suggested_due_at ? ` · due ${formatWhen(item.suggested_due_at)}` : ""}
          {item.contact ? ` · ${item.contact.display_name}` : ""}
          {item.event ? ` · ${item.event.title}` : ""}
          {item.status === "confirmed" ? ` · confirmed by ${item.decided_by?.name ?? "someone"}` : ""}
          {item.status === "dismissed" ? " · dismissed" : ""}
        </span>
      </div>
      {item.status === "proposed" ? (
        <div className="vx-action-buttons">
          {canConfirm && can("tasks.create") ? (
            <>
              <label className="visually-hidden" htmlFor={`${uid}-a`}>
                Assign to
              </label>
              <select id={`${uid}-a`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Me</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {canConfirm ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void confirm()} aria-label={`Create a task: ${item.title}`}>
              <Check aria-hidden="true" /> Create task
            </button>
          ) : null}
          {item.permissions.change ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void dismiss()} aria-label={`Dismiss: ${item.title}`}>
              <X aria-hidden="true" /> Dismiss
            </button>
          ) : null}
        </div>
      ) : item.status === "confirmed" ? (
        <a className="badge badge-success" href={areaHash("tasks")}>
          <CircleCheck aria-hidden="true" /> Task
        </a>
      ) : null}
    </li>
  );
}

export function ActionItemsSection({ event, title = "Suggested next steps" }: { event?: CalendarEventFull; title?: string }) {
  const { api, crm, can } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const items = useApiResource((a, signal) => a.list<ActionItem>(`${crm}/action-items`, event ? { event: event.id, status: "all" } : { status: "proposed" }, signal), [crm, event?.id]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const replace = (i: ActionItem | null) => i && items.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === i.id ? i : x)) } : p));
  const propose = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const i = await api.post<ActionItem>(`${crm}/action-items`, { title: text, event_id: event?.id ?? null, contact_id: event?.contact?.id ?? null, opportunity_id: event?.opportunity?.id ?? null });
      items.setData((p) => (p ? { ...p, data: [i, ...p.data] } : p));
      setText("");
    } catch (e2) {
      ui.toast({ kind: "error", title: "Couldn't add the next step", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  const rows = items.data?.data ?? [];
  return (
    <section className="ws-section" aria-labelledby={`${uid}-h`}>
      <header className="ws-section-header">
        <h3 id={`${uid}-h`}>
          <ListPlus aria-hidden="true" /> {title}
        </h3>
      </header>
      <p className="xsmall subtle">A suggestion becomes a task only when someone reviews it and creates the task.</p>
      {event && (can("tasks.create") || can("tasks.create_own")) ? (
        <form className="ws-inline-fields" onSubmit={propose}>
          <label className="visually-hidden" htmlFor={`${uid}-i`}>
            Suggest a next step
          </label>
          <input id={`${uid}-i`} type="text" placeholder="Suggest a next step…" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={busy || !text.trim()}>
            <Plus aria-hidden="true" /> Suggest
          </button>
        </form>
      ) : null}
      {items.error ? <ErrorState error={items.error} onRetry={items.reload} compact /> : null}
      {items.loading && !items.data ? <LoadingState /> : null}
      {items.data && rows.length === 0 ? (
        <EmptyState icon={CircleCheck} title={event ? "No next steps yet" : "Nothing to review"}>
          {event ? "Add what was agreed; a teammate can turn it into a task." : "Suggested next steps from meetings appear here for review."}
        </EmptyState>
      ) : null}
      <ul className="ws-list vx-actions">
        {rows.map((i) => (
          <ActionItemRow key={i.id} item={i} onChanged={(x) => replace(x)} />
        ))}
      </ul>
    </section>
  );
}

export function DeleteButton({ label, onConfirm }: { label: string; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`${label}?`)) return;
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Trash2 aria-hidden="true" />
    </button>
  );
}

export function PersonLine({ label, user }: { label: string; user: Parameters<typeof UserLabel>[0]["user"] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <UserLabel user={user} />
      </dd>
    </>
  );
}

export type { Page };
