/**
 * Home dashboard cards of the verticals team: today's meetings, approaching deadlines,
 * lending applications missing documents, suggested next steps, and the connected-service
 * health slot (filled by the integrations team's apps/integrations/health.py; nothing is
 * shown when no app provides it — never invented data).
 */

import { ArrowRight, CalendarClock, CalendarDays, CircleCheck, FlaskConical, Landmark, ListPlus, PlugZap, Video } from "lucide-react";
import { areaHash } from "../define";
import { EmptyState, formatWhen } from "../ui";
import { EVENT_KIND_LABEL } from "./logic";
import { UrgencyBadge, formatDay } from "./shared";
import type { HomeExtras, ServiceHealth } from "./types";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const HEALTH_CLASS: Record<string, string> = { connected: "badge-success", needs_reauth: "badge-warning", error: "badge-danger" };

export function serviceStatusLabel(s: ServiceHealth): string {
  if (s.status_label) return s.status_label;
  return { connected: "Connected", needs_reauth: "Needs sign-in again", error: "Error", not_connected: "Not connected", not_configured: "Not set up on this server" }[s.status] ?? s.status;
}

export function HomeVerticalCards({ d, team }: { d: HomeExtras; team: boolean }) {
  const meetings = d.meetings_today ?? [];
  const deadlines = d.approaching_deadlines ?? [];
  return (
    <>
      <section className="ws-card" aria-labelledby="home-meetings">
        <header className="ws-card-header">
          <h2 id="home-meetings">Today's meetings</h2>
          <a href={areaHash("calendar")} className="small">
            Calendar <ArrowRight aria-hidden="true" className="inline-icon" />
          </a>
        </header>
        {meetings.length === 0 ? (
          <EmptyState icon={CalendarDays} title={team ? "Nothing on the team calendar today" : "No meetings today"} />
        ) : (
          <ul className="ws-list">
            {meetings.map((e) => (
              <li key={e.id}>
                <a className="ws-row-link" href={areaHash("calendar", "event", e.id)}>
                  <span className="vx-event-time">{e.all_day ? "All day" : timeFmt.format(new Date(e.start_at))}</span>
                  <span className="ws-row-main">
                    <span className="ws-row-title">{e.title}</span>
                    <span className="ws-row-meta">
                      {EVENT_KIND_LABEL[e.kind] ?? e.kind}
                      {e.location ? ` · ${e.location}` : ""}
                    </span>
                  </span>
                  {e.matrix_room_id ? <Video aria-label="Has a meeting room" className="inline-icon" /> : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ws-card" aria-labelledby="home-deadlines">
        <header className="ws-card-header">
          <h2 id="home-deadlines">Approaching deadlines</h2>
        </header>
        {deadlines.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No deadlines in the next 7 days" />
        ) : (
          <ul className="ws-list">
            {deadlines.map((ms) => (
              <li key={ms.id}>
                <a className="ws-row-link" href={ms.opportunity ? areaHash("crm", ms.opportunity.id) : ms.application ? areaHash("lending", ms.application.id) : "#"}>
                  <span className="ws-row-main">
                    <span className="ws-row-title">{ms.title}</span>
                    <span className="ws-row-meta">
                      {formatDay(ms.due_date)} · {ms.opportunity?.name ?? ms.application?.reference ?? ""}
                    </span>
                  </span>
                  <UrgencyBadge urgency={ms.urgency} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.applications_missing_documents ? (
        <section className="ws-card" aria-labelledby="home-missing">
          <header className="ws-card-header">
            <h2 id="home-missing">Applications missing documents</h2>
            <a href={areaHash("lending")} className="small">
              Lending <ArrowRight aria-hidden="true" className="inline-icon" />
            </a>
          </header>
          {d.applications_missing_documents.length === 0 ? (
            <EmptyState icon={CircleCheck} title="Every application has its documents" />
          ) : (
            <ul className="ws-list">
              {d.applications_missing_documents.map((a) => (
                <li key={a.id}>
                  <a className="ws-row-link" href={areaHash("lending", a.id)}>
                    <Landmark aria-hidden="true" className="inline-icon" />
                    <span className="ws-row-main">
                      <span className="ws-row-title">
                        {a.reference} · {a.title}
                      </span>
                      <span className="ws-row-meta">
                        {a.stage}
                        {a.target_close_date ? ` · target ${formatDay(a.target_close_date)}` : ""}
                      </span>
                    </span>
                    <span className="badge badge-warning">{a.missing} missing</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {d.suggested_next_steps ? (
        <section className="ws-card" aria-labelledby="home-next">
          <header className="ws-card-header">
            <h2 id="home-next">Next steps to review</h2>
          </header>
          <div className="ws-chat-card">
            <ListPlus aria-hidden="true" />
            <p>
              <strong>{d.suggested_next_steps}</strong> suggested next step{d.suggested_next_steps === 1 ? "" : "s"} from meetings wait{d.suggested_next_steps === 1 ? "s" : ""} for
              someone to create the task.
            </p>
            <a className="btn btn-sm" href={areaHash("calls", "next-steps")}>
              Review
            </a>
          </div>
        </section>
      ) : null}

      {d.connected_services && d.connected_services.length ? (
        <section className="ws-card" aria-labelledby="home-services">
          <header className="ws-card-header">
            <h2 id="home-services">Connected services</h2>
            <a href={areaHash("integrations")} className="small">
              Integrations <ArrowRight aria-hidden="true" className="inline-icon" />
            </a>
          </header>
          <ul className="ws-list">
            {d.connected_services.map((s) => (
              <li key={s.service}>
                <a className="ws-row-link" href={s.link || areaHash("integrations")}>
                  <PlugZap aria-hidden="true" className="inline-icon" />
                  <span className="ws-row-main">
                    <span className="ws-row-title">
                      {s.label}{" "}
                      {s.mock ? (
                        <span className="badge badge-info" title="Not a real connection">
                          <FlaskConical aria-hidden="true" /> {s.mock_label || "Mock provider"}
                        </span>
                      ) : null}
                    </span>
                    <span className="ws-row-meta">
                      {s.detail || ""}
                      {s.checked_at ? `${s.detail ? " · " : ""}checked ${formatWhen(s.checked_at)}` : ""}
                    </span>
                  </span>
                  <span className={`badge ${HEALTH_CLASS[s.status] ?? ""}`}>{serviceStatusLabel(s)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
