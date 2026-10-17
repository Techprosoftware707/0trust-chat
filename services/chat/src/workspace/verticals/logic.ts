/**
 * Pure helpers of the verticals areas (no React, no network): calendar maths, labels,
 * upload pre-checks, rule descriptions, recent calls from Matrix call events. Unit-tested in
 * test/unit/verticals.test.ts.
 */

import type { AutomationCatalog, AutomationRule, ChecklistStatus, EventKind, Property, RuleCondition, Urgency } from "./types";

// --- labels ---------------------------------------------------------------------------------------

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  meeting: "Meeting",
  viewing: "Viewing",
  call: "Call",
  closing: "Closing",
  appointment: "Appointment",
  other: "Other",
};

export const URGENCY_LABEL: Record<Urgency, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  upcoming: "Upcoming",
  no_date: "No date",
  done: "Done",
};

export function urgencyBadgeClass(u: Urgency): string {
  return u === "overdue" ? "badge-danger" : u === "due_soon" ? "badge-warning" : u === "done" ? "badge-success" : "";
}

export const CHECKLIST_STATUS_LABEL: Record<ChecklistStatus, string> = {
  pending: "Not requested yet",
  requested: "Requested",
  received: "Received, to review",
  accepted: "Accepted",
  rejected: "Rejected",
  waived: "Waived",
};

export function checklistBadgeClass(s: ChecklistStatus): string {
  return s === "accepted" ? "badge-success" : s === "rejected" ? "badge-danger" : s === "received" ? "badge-info" : s === "requested" ? "badge-warning" : s === "waived" ? "" : "";
}

export const PROPERTY_STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  coming_soon: "Coming soon",
  active: "Active",
  under_contract: "Under contract",
  sold: "Sold",
  leased: "Leased",
  withdrawn: "Withdrawn",
  off_market: "Off market",
};

export const PROPERTY_TYPE_LABEL: Record<string, string> = {
  house: "House",
  condo: "Condo / apartment",
  townhouse: "Townhouse",
  multi_family: "Multi-family",
  land: "Land",
  commercial: "Commercial",
  other: "Other",
};

export function propertyStatusClass(s: string): string {
  return s === "active" ? "badge-success" : s === "under_contract" ? "badge-warning" : s === "coming_soon" ? "badge-info" : "";
}

/** "3 bd · 2 ba · 1,650 sq ft" (only what is known). */
export function propertyFacts(p: Pick<Property, "bedrooms" | "bathrooms" | "area" | "area_unit" | "property_type">): string {
  const parts: string[] = [];
  if (p.bedrooms !== null && p.bedrooms !== undefined) parts.push(`${p.bedrooms} bd`);
  if (p.bathrooms !== null && p.bathrooms !== undefined) parts.push(`${Number(p.bathrooms)} ba`);
  if (p.area) parts.push(`${p.area.toLocaleString("en-US")} ${p.area_unit === "sqm" ? "m²" : "sq ft"}`);
  if (!parts.length && p.property_type) parts.push(PROPERTY_TYPE_LABEL[p.property_type] ?? p.property_type);
  return parts.join(" · ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.8576)) / 10} MB`;
}

const TYPE_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/tiff": "TIFF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
};

export function fileTypeLabel(ctype: string): string {
  return TYPE_LABEL[ctype] ?? ctype;
}

/** Client-side pre-check of an upload (the server checks again, including the contents). */
export function checkUpload(file: { name: string; size: number; type: string }, allowed: string[], maxBytes: number): string | null {
  if (!file.size) return "The file is empty.";
  if (file.size > maxBytes) return `Documents can be at most ${Math.floor(maxBytes / (1024 * 1024))} MB.`;
  if (!allowed.includes(file.type)) return "Upload a PDF, JPEG, PNG, TIFF, Word (.docx) or Excel (.xlsx) file.";
  return null;
}

// --- calendar ----------------------------------------------------------------------------------------

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday of the week containing ``d`` (local time). */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local ``YYYY-MM-DD`` (for routes and date inputs). */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseIsoDay(s: string | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type CalendarView = "agenda" | "day" | "week";

/** The [from, to) window a view shows around ``anchor``. */
export function viewRange(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === "day") return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 14) };
}

export function shiftAnchor(view: CalendarView, anchor: Date, dir: -1 | 1): Date {
  return addDays(anchor, dir * (view === "day" ? 1 : view === "week" ? 7 : 14));
}

/** Events that touch the local day ``day`` (an event spanning midnight shows on both days). */
export function eventsOnDay<T extends { start_at: string; end_at: string }>(events: T[], day: Date): T[] {
  const from = startOfDay(day).getTime();
  const to = addDays(startOfDay(day), 1).getTime();
  return events
    .filter((e) => new Date(e.start_at).getTime() < to && new Date(e.end_at).getTime() >= from)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export function groupByDay<T extends { start_at: string; end_at: string }>(events: T[], from: Date, to: Date): { day: Date; events: T[] }[] {
  const out: { day: Date; events: T[] }[] = [];
  for (let d = startOfDay(from); d < to; d = addDays(d, 1)) {
    const list = eventsOnDay(events, d);
    if (list.length) out.push({ day: d, events: list });
  }
  return out;
}

/** Position of an event in a day column, in minutes from 00:00 (clamped to the day). */
export function dayBlock(e: { start_at: string; end_at: string }, day: Date): { top: number; height: number } {
  const dayStart = startOfDay(day).getTime();
  const start = Math.max(new Date(e.start_at).getTime(), dayStart);
  const end = Math.min(new Date(e.end_at).getTime(), dayStart + 24 * 3600_000);
  const top = Math.round((start - dayStart) / 60_000);
  return { top, height: Math.max(20, Math.round((end - start) / 60_000)) };
}

/** Side-by-side lanes for overlapping events of one day: each event gets its lane and the
 * number of lanes of its overlapping group (so blocks never cover each other). */
export function layoutLanes<T extends { id: string; start_at: string; end_at: string }>(events: T[], day: Date): Map<string, { lane: number; lanes: number }> {
  const rows = events
    .map((e) => ({ id: e.id, ...dayBlock(e, day) }))
    .map((r) => ({ id: r.id, start: r.top, end: r.top + r.height }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, { lane: number; lanes: number }>();
  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const g of group) out.set(g.id, { lane: g.lane, lanes: Math.max(1, laneEnds.length) });
    group = [];
    laneEnds = [];
  };
  for (const r of rows) {
    if (r.start >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= r.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(r.end);
    } else laneEnds[lane] = r.end;
    group.push({ id: r.id, lane });
    groupEnd = Math.max(groupEnd, r.end);
  }
  flush();
  return out;
}

// --- automation rules -------------------------------------------------------------------------------------

const ACTION_TEXT: Record<string, (p: Record<string, unknown>) => string> = {
  assign_owner: (p) => (p.only_if_unassigned === false ? "assign an owner" : "assign an owner if it has none"),
  create_task: (p) => `create the task “${String(p.title ?? "")}”${p.due_in_hours ? ` due in ${p.due_in_hours} h` : ""}`,
  notify_user: (p) => `notify ${p.recipient === "attendees" ? "the attendees" : p.recipient === "rule_owner" ? "the rule's owner" : p.recipient === "subject_owner" ? "the owner" : "a teammate"}`,
  update_related_tasks: (p) => `${p.set_status === "canceled" ? "cancel" : "complete"} ${p.only_automation === false ? "its open tasks" : "its open automation tasks"}`,
};

/** "When a lead is created: assign an owner if it has none, then create the task …". */
/** Plain-language names of the automation condition fields (apps/automation/engine.py). */
export const CONDITION_FIELD_LABEL: Record<string, string> = {
  "contact.kind": "the contact's type",
  "contact.source": "the source",
  "contact.priority": "the priority",
  "contact.roles": "a role",
  "contact.has_owner": "it has an owner",
  "task.priority": "the task's priority",
  "task.source": "the task's source",
  "task.has_contact": "it's linked to a contact",
  "task.has_opportunity": "it's linked to a deal",
  "event.kind": "the event type",
  "event.has_room": "it has a meeting room",
  "opportunity.pipeline_id": "the pipeline (ID)",
  "opportunity.pipeline_kind": "the pipeline type",
  "opportunity.priority": "the deal's priority",
  "stage.name": "the new stage",
  "stage.is_won": "the new stage is a won stage",
  "stage.is_lost": "the new stage is a lost stage",
  "from_stage.name": "the previous stage",
  "item.source": "the suggestion's source",
  "item.has_assignee": "it has a suggested assignee",
};

/** Yes/no fields read as a statement and its negation. */
const CONDITION_NEGATION: Record<string, string> = {
  "contact.has_owner": "it has no owner",
  "task.has_contact": "it isn't linked to a contact",
  "task.has_opportunity": "it isn't linked to a deal",
  "event.has_room": "it has no meeting room",
  "stage.is_won": "the new stage isn't a won stage",
  "stage.is_lost": "the new stage isn't a lost stage",
  "item.has_assignee": "it has no suggested assignee",
};

const OPERATOR_TEXT: Record<string, string> = { equals: "is", not_equals: "isn't", in: "is one of", contains: "includes" };

export function conditionFieldLabel(field: string): string {
  return CONDITION_FIELD_LABEL[field] ?? field;
}

export function describeCondition(c: RuleCondition): string {
  const negation = CONDITION_NEGATION[c.field];
  if (negation && (c.op === "equals" || c.op === "not_equals") && (c.value === true || c.value === false || c.value === "true" || c.value === "false")) {
    const yes = (c.value === true || c.value === "true") === (c.op === "equals");
    return yes ? conditionFieldLabel(c.field) : negation;
  }
  const value = Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
  return `${conditionFieldLabel(c.field)} ${OPERATOR_TEXT[c.op] ?? c.op} ${value}`;
}

export function describeRule(rule: Pick<AutomationRule, "trigger" | "trigger_label" | "conditions" | "actions">, catalog?: AutomationCatalog | null): string {
  const label = catalog?.triggers.find((t) => t.value === rule.trigger)?.label ?? rule.trigger_label ?? rule.trigger;
  const when = `When ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const cond = rule.conditions.length ? ` and ${rule.conditions.map(describeCondition).join(" and ")}` : "";
  const acts = rule.actions.map((a) => (ACTION_TEXT[a.type] ?? ((): string => a.type))(a.params)).join(", then ");
  return `${when}${cond}: ${acts || "do nothing"}.`;
}

export function executionBadgeClass(status: string): string {
  if (status === "succeeded") return "badge-success";
  if (status === "failed") return "badge-danger";
  if (status === "retrying" || status === "rate_limited" || status === "loop_blocked") return "badge-warning";
  return "";
}

// --- recent calls (client-side only, from Matrix call events this device has loaded) ------------------

export interface RecentCall {
  roomId: string;
  roomName: string;
  eventId: string;
  startTs: number;
  endTs: number | null;
  intent: "audio" | "video" | null;
  participants: number;
  ongoing: boolean;
  outcome: string;
}

/** Merges per-room call histories into one list, newest first. Nothing here is ever sent to
 * the server; only "link to record" sends the room and event IDs and the start time. */
export function mergeRecentCalls(perRoom: { roomId: string; roomName: string; calls: { startEventId: string; startTs: number; endTs: number | null; intent: "audio" | "video" | null; participants: string[]; ongoing: boolean; outcome: string }[] }[], limit = 30): RecentCall[] {
  const all: RecentCall[] = [];
  for (const r of perRoom) {
    for (const c of r.calls) {
      all.push({ roomId: r.roomId, roomName: r.roomName, eventId: c.startEventId, startTs: c.startTs, endTs: c.endTs, intent: c.intent,
        participants: c.participants.length, ongoing: c.ongoing, outcome: c.outcome });
    }
  }
  return all.sort((a, b) => b.startTs - a.startTs).slice(0, limit);
}

export function callDuration(c: { startTs: number; endTs: number | null }): string {
  if (!c.endTs) return "";
  const s = Math.max(0, Math.round((c.endTs - c.startTs) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function money(value: string | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n)} ${currency}`;
  }
}

export function budgetRange(min: string | null, max: string | null, currency: string): string {
  if (min && max) return `${money(min, currency)} – ${money(max, currency)}`;
  if (max) return `up to ${money(max, currency)}`;
  if (min) return `from ${money(min, currency)}`;
  return "—";
}

export function parseList(s: string): string[] {
  return Array.from(new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))).slice(0, 30);
}
