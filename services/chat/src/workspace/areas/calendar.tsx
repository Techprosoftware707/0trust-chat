/**
 * Calendar: agenda, day and week views of the workspace calendar (GET .../crm/events), event
 * pages with the meeting room (an end-to-end encrypted Matrix room and its MatrixRTC call),
 * meeting notes and suggested next steps. Invitations are internal only for now.
 *
 * Routes: #/calendar[/agenda|/day|/week][/YYYY-MM-DD], #/calendar/event/<id>.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, MapPin, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { navigate } from "../../hooks/useRoute";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Page } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, PageHeader, UserLabel, formatWhen } from "../ui";
import {
  EVENT_KIND_LABEL, addDays, dayBlock, eventsOnDay, layoutLanes, groupByDay, isoDay, parseIsoDay, sameDay, shiftAnchor, startOfDay, viewRange, type CalendarView,
} from "../verticals/logic";
import { ActionItemsSection, EventDialog, MeetingNotesSection, MeetingRoomControls, NoRecordingNote, draftFromEvent, newDraft } from "../verticals/shared";
import type { CalendarEventFull } from "../verticals/types";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const rangeFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function timeRange(e: { start_at: string; end_at: string; all_day?: boolean }): string {
  if (e.all_day) return "All day";
  return `${timeFmt.format(new Date(e.start_at))} – ${timeFmt.format(new Date(e.end_at))}`;
}

function EventRow({ e }: { e: CalendarEventFull }) {
  return (
    <a className={`vx-event${e.status === "canceled" ? " canceled" : ""}`} href={areaHash("calendar", "event", e.id)}>
      <span className="vx-event-time">{timeRange(e)}</span>
      <span className="ws-row-main">
        <span className="ws-row-title">{e.title}</span>
        <span className="ws-row-meta">
          {EVENT_KIND_LABEL[e.kind] ?? e.kind}
          {e.location ? ` · ${e.location}` : ""}
          {e.contact ? ` · ${e.contact.display_name}` : ""}
          {e.matrix_room_id ? " · meeting room" : ""}
        </span>
      </span>
      {e.status === "canceled" ? <span className="badge">Canceled</span> : null}
      <DemoBadge show={e.is_demo} />
    </a>
  );
}

function TimeGrid({ days, events, today }: { days: Date[]; events: CalendarEventFull[]; today: Date }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open on the working day (7:30), or earlier when something starts before that.
    const starts = days.flatMap((d) => eventsOnDay(events, d).map((e) => dayBlock(e, d).top));
    const first = Math.min(7.5 * 60, ...starts);
    if (grid.current) grid.current.scrollTop = Math.max(0, (first / 60) * 48 - 8);
  }, [days.length, events.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={grid} className={`vx-week${days.length === 1 ? " day" : ""}`} role="grid" aria-label={days.length === 1 ? "Day" : "Week"}>
      <div className="vx-week-head" aria-hidden="true" />
      {days.map((d) => (
        <div key={d.toISOString()} className={`vx-week-head${sameDay(d, today) ? " today" : ""}`} role="columnheader">
          <a href={areaHash("calendar", "day", isoDay(d))}>{shortDayFmt.format(d)}</a>
        </div>
      ))}
      <div className="vx-hours" aria-hidden="true">
        {hours.map((h) => (
          <div key={h} className="vx-hour">
            {hourFmt.format(new Date(2000, 0, 1, h))}
          </div>
        ))}
      </div>
      {days.map((d) => (
        <div key={d.toISOString()} className="vx-daycol" role="gridcell" aria-label={dayFmt.format(d)} style={{ height: 24 * 48 }}>
          {(() => {
            const list = eventsOnDay(events, d);
            const lanes = layoutLanes(list, d);
            return list.map((e) => {
            const b = dayBlock(e, d);
            const l = lanes.get(e.id) ?? { lane: 0, lanes: 1 };
            const height = Math.max(22, (b.height / 60) * 48 - 2);
            // Under ~40 minutes there is room for one line: title first, then the time.
            const short = height < 34;
            return (
              <a key={e.id} className={`vx-block ${e.kind}${short ? " short" : ""}${e.status === "canceled" ? " canceled" : ""}`} href={areaHash("calendar", "event", e.id)}
                style={{ top: (b.top / 60) * 48, height, left: `calc(${(100 * l.lane) / l.lanes}% + 2px)`, width: `calc(${100 / l.lanes}% - 4px)` }}
                aria-label={`${e.title}, ${timeRange(e)}`} title={`${e.title}, ${timeRange(e)}`}>
                <strong>{e.title}</strong>
                <span className="vx-block-time">{timeRange(e)}</span>
              </a>
            );
            });
          })()}
        </div>
      ))}
    </div>
  );
}

function CalendarPage({ view, anchor }: { view: CalendarView; anchor: Date }) {
  const ws = useWorkspace();
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const { from, to } = viewRange(view, anchor);
  const query = useMemo(() => ({ from: from.toISOString(), to: to.toISOString(), limit: 200, attending: mine ? "me" : "" }), [from.getTime(), to.getTime(), mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useApiResource((api, signal) => api.list<CalendarEventFull>(`${ws.crm}/events`, query, signal), [ws.crm, query]);
  const today = startOfDay(new Date());
  const events = res.data?.data ?? [];
  const go = (v: CalendarView, d: Date) => navigate(areaHash("calendar", v, isoDay(d)));
  const me = ws.members.find((m) => m.id === ws.me?.user.id)?.id;
  const title = view === "day" ? dayFmt.format(anchor) : `${rangeFmt.format(from)} – ${rangeFmt.format(addDays(to, -1))}`;
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={CalendarDays} title="Calendar" subtitle="Meetings, viewings, calls and closings of your workspace."
        actions={ws.can("events.create") ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> New event
          </button>
        ) : null} />
      <div className="vx-cal-toolbar">
        <div className="vx-cal-nav">
          <button type="button" className="icon-btn" aria-label="Previous" onClick={() => go(view, shiftAnchor(view, anchor, -1))}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => go(view, new Date())}>
            Today
          </button>
          <button type="button" className="icon-btn" aria-label="Next" onClick={() => go(view, shiftAnchor(view, anchor, 1))}>
            <ChevronRight aria-hidden="true" />
          </button>
          <h2 className="vx-cal-title" aria-live="polite">
            {title}
          </h2>
        </div>
        <div className="vx-cal-nav">
          <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((m) => !m)}>
            Only mine
          </button>
          <div className="ws-segmented" role="group" aria-label="View">
            {(["agenda", "day", "week"] as CalendarView[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => go(v, anchor)}>
                {v === "agenda" ? "Agenda" : v === "day" ? "Day" : "Week"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <LoadingState label="Loading the calendar…" /> : null}
      {res.data && view === "agenda" ? (
        groupByDay(events, from, to).length === 0 ? (
          <EmptyState icon={CalendarDays} title="Nothing in the next two weeks">
            {ws.can("events.create") ? "Add a meeting or a viewing with “New event”." : "Events you're invited to appear here."}
          </EmptyState>
        ) : (
          groupByDay(events, from, to).map(({ day, events: list }) => (
            <section key={day.toISOString()} className="vx-agenda-day" aria-label={dayFmt.format(day)}>
              <h2 className={sameDay(day, today) ? "today" : ""}>{sameDay(day, today) ? `Today · ${dayFmt.format(day)}` : dayFmt.format(day)}</h2>
              {list.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </section>
          ))
        )
      ) : null}
      {res.data && view !== "agenda" ? <TimeGrid days={view === "day" ? [from] : Array.from({ length: 7 }, (_, i) => addDays(from, i))} events={events} today={today} /> : null}
      {res.data && res.data.page.next_cursor ? <p className="xsmall subtle">Showing the first 200 events of this range.</p> : null}
      {creating ? (
        <EventDialog draft={newDraft(view === "agenda" ? (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })() : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 10), me)}
          onClose={() => setCreating(false)} onSaved={(e) => { setCreating(false); res.reload(); navigate(areaHash("calendar", "event", e.id)); }} />
      ) : null}
    </div>
  );
}

export function EventPage({ id, back = areaHash("calendar") }: { id: string; back?: string }) {
  const ws = useWorkspace();
  const ui = useUi();
  const res = useApiResource((api, signal) => api.get<CalendarEventFull>(`${ws.crm}/events/${id}`, undefined, signal), [ws.crm, id]);
  const [editing, setEditing] = useState(false);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const e = res.data;
  if (!e) return <LoadingState />;
  const relatedProperty = e.related?.type === "crm.property" ? e.related.id : null;
  return (
    <div className="ws-area-scroll">
      <article className="ws-detail" aria-labelledby="event-title">
        <header className="ws-detail-header">
          <a href={back} className="icon-btn" aria-label="Back">
            <ArrowLeft aria-hidden="true" />
          </a>
          <div className="ws-detail-titles">
            <h2 id="event-title">{e.title}</h2>
            <p className="muted small">
              {formatWhen(e.start_at, { time: false })} · {timeRange(e)}
              {e.location ? (
                <>
                  {" · "}
                  <MapPin aria-hidden="true" className="inline-icon" /> {e.location}
                </>
              ) : null}
            </p>
            <div className="cluster ws-badges">
              <span className="badge badge-accent">{EVENT_KIND_LABEL[e.kind] ?? e.kind}</span>
              {e.status !== "scheduled" ? <span className="badge">{e.status === "canceled" ? "Canceled" : "Completed"}</span> : null}
              {e.visibility === "private" ? <span className="badge">Private</span> : null}
              <DemoBadge show={e.is_demo} />
            </div>
          </div>
          <div className="ws-detail-actions">
            {e.permissions.change ? (
              <>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  <Pencil aria-hidden="true" /> Edit
                </button>
                {e.status === "scheduled" ? (
                  <button type="button" className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      try {
                        res.setData(await ws.api.patch<CalendarEventFull>(`${ws.crm}/events/${e.id}`, { status: "canceled" }));
                        ui.toast({ kind: "info", title: "Event canceled", body: "Attendees see it as canceled in their calendar." });
                      } catch (err) {
                        ui.toast({ kind: "error", title: "Couldn't cancel it", body: describeError(err) });
                      }
                    }}>
                    Cancel event
                  </button>
                ) : null}
              </>
            ) : null}
            {e.permissions.delete ? (
              <button type="button" className="btn btn-sm btn-outline-danger"
                onClick={async () => {
                  if (!window.confirm(`Delete “${e.title}”? Its notes go too.`)) return;
                  try {
                    await ws.api.delete(`${ws.crm}/events/${e.id}`);
                    ui.toast({ kind: "success", title: "Event deleted" });
                    navigate(back);
                  } catch (err) {
                    ui.toast({ kind: "error", title: "Couldn't delete it", body: describeError(err) });
                  }
                }}>
                <Trash2 aria-hidden="true" /> Delete
              </button>
            ) : null}
          </div>
        </header>
        <div className="ws-detail-grid">
          <div className="ws-detail-main">
            <section className="ws-section" aria-label="Meeting room">
              <h3 className="ws-section-title">Meeting room</h3>
              <MeetingRoomControls event={e} onLinked={(x) => res.setData(x)} />
              <NoRecordingNote />
            </section>
            {e.description ? (
              <section className="ws-section" aria-label="Agenda">
                <h3 className="ws-section-title">Agenda</h3>
                <p className="ws-tl-text">{e.description}</p>
              </section>
            ) : null}
            <MeetingNotesSection event={e} />
            <ActionItemsSection event={e} />
          </div>
          <aside className="ws-detail-side" aria-label="Event details">
            <dl className="ws-kv">
              <dt>Organizer</dt>
              <dd>
                <UserLabel user={e.organizer} fallback="—" />
              </dd>
              <dt>
                <Users aria-hidden="true" className="inline-icon" /> Internal attendees
              </dt>
              <dd>{e.attendee_users.length ? e.attendee_users.map((u) => u.name).join(", ") : "—"}</dd>
              <dt>Contacts</dt>
              <dd>
                {e.attendee_contacts.length || e.contact
                  ? [...(e.contact ? [e.contact] : []), ...e.attendee_contacts.filter((c) => c.id !== e.contact?.id)].map((c, i) => (
                      <span key={c.id}>
                        {i ? ", " : ""}
                        <a href={areaHash("contacts", c.id)}>{c.display_name}</a>
                      </span>
                    ))
                  : "—"}
              </dd>
              {e.opportunity ? (
                <>
                  <dt>Deal</dt>
                  <dd>
                    <a href={areaHash("crm", e.opportunity.id)}>{e.opportunity.name}</a>
                  </dd>
                </>
              ) : null}
              {relatedProperty ? (
                <>
                  <dt>Property</dt>
                  <dd>
                    <a href={areaHash("properties", relatedProperty)}>Open the property</a>
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="xsmall subtle">Contacts aren't sent invitations: email invites come with the Gmail integration.</p>
          </aside>
        </div>
      </article>
      {editing ? <EventDialog event={e} draft={draftFromEvent(e)} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); res.setData(x); }} /> : null}
    </div>
  );
}

export function parseCalendarPath(path: string[], now = new Date()): { kind: "event"; id: string } | { kind: "view"; view: CalendarView; anchor: Date } {
  if (path[0] === "event" && path[1]) return { kind: "event", id: path[1] };
  const view: CalendarView = path[0] === "day" || path[0] === "week" || path[0] === "agenda" ? path[0] : "agenda";
  const anchor = parseIsoDay(path[1]) ?? parseIsoDay(path[0]) ?? startOfDay(now);
  return { kind: "view", view, anchor };
}

function CalendarArea({ path }: AreaProps) {
  const r = parseCalendarPath(path);
  return <ConnectionGate>{r.kind === "event" ? <EventPage key={r.id} id={r.id} /> : <CalendarPage view={r.view} anchor={r.anchor} />}</ConnectionGate>;
}

export const area = defineArea({
  id: "calendar",
  label: "Calendar",
  icon: CalendarDays,
  order: 90,
  status: "ready",
  feature: "crm",
  summary: "Your appointments, showings and closings next to tasks and follow-ups.",
  component: CalendarArea,
});

export type { Page };
