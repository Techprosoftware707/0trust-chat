/**
 * Calls & Meetings: upcoming meetings (workspace calendar), recent calls read on this device
 * from the end-to-end encrypted rooms' MatrixRTC call events (never sent to the server), with
 * "Link to record", and the suggested next steps waiting for review.
 *
 * Routes: #/calls (upcoming), #/calls/recent, #/calls/next-steps.
 * Recording and transcription are NOT available: the call server (SFU) has no recording
 * component, and Nexus never records secretly.
 */

import { useId, useMemo, useState, type FormEvent } from "react";
import { EventTimeline, MatrixEventEvent, RoomEvent } from "matrix-js-sdk";
import { CalendarDays, Info, Link2, ListChecks, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import { buildCallHistory, outcomeFor } from "../../calls/history";
import { roomSession } from "../../calls/rtc";
import { useUi } from "../../components/UiContext";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { useEmitterVersion } from "../../hooks/useEmitter";
import { formatDayLabel, formatTime } from "../../lib/format";
import { roomHash } from "../../lib/matrix-id";
import { useMatrix } from "../../matrix/context";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import { ConnectionGate, EmptyState, ErrorState, LoadingState, PageHeader, formatWhen } from "../ui";
import { EVENT_KIND_LABEL, callDuration, mergeRecentCalls, type RecentCall } from "../verticals/logic";
import { ActionItemsSection, NoRecordingNote, SearchPicker, useContactSearch, useDealSearch } from "../verticals/shared";
import type { CalendarEventFull } from "../verticals/types";
import { timeRange } from "./calendar";

function Tabs({ active }: { active: string }) {
  const tabs: [string, string, string][] = [["upcoming", "Upcoming", areaHash("calls")], ["recent", "Recent calls", areaHash("calls", "recent")],
    ["next-steps", "Next steps", areaHash("calls", "next-steps")]];
  return (
    <nav className="ws-tabs" aria-label="Calls & Meetings">
      {tabs.map(([id, label, href]) => (
        <a key={id} href={href} aria-current={active === id ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

function Upcoming() {
  const ws = useWorkspace();
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const res = useApiResource((api, signal) => api.get<CalendarEventFull[]>(`${ws.crm}/meetings/upcoming`, { scope, days: 14 }, signal), [ws.crm, scope]);
  return (
    <>
      <div className="ws-toolbar">
        {ws.workspace?.view_level === "all" ? (
          <div className="ws-segmented" role="group" aria-label="Show">
            <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>
              Mine
            </button>
            <button type="button" aria-pressed={scope === "team"} onClick={() => setScope("team")}>
              Team
            </button>
          </div>
        ) : (
          <span />
        )}
        <a className="btn btn-sm" href={areaHash("calendar")}>
          <CalendarDays aria-hidden="true" /> Calendar
        </a>
      </div>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <LoadingState /> : null}
      {res.data && res.data.length === 0 ? (
        <EmptyState icon={Video} title="No meetings in the next two weeks">
          Add one in the calendar; it gets an end-to-end encrypted meeting room with one click.
        </EmptyState>
      ) : null}
      <div className="ws-card">
        <ul className="ws-list">
          {(res.data ?? []).map((e) => (
            <li key={e.id}>
              <a className="ws-row-link" href={areaHash("calendar", "event", e.id)}>
                <span className="vx-event-time">
                  {formatWhen(e.start_at, { time: false })}
                  <br />
                  {timeRange(e)}
                </span>
                <span className="ws-row-main">
                  <span className="ws-row-title">{e.title}</span>
                  <span className="ws-row-meta">
                    {EVENT_KIND_LABEL[e.kind] ?? e.kind}
                    {e.contact ? ` · ${e.contact.display_name}` : ""}
                    {e.opportunity ? ` · ${e.opportunity.name}` : ""}
                    {e.note_count ? ` · ${e.note_count} note${e.note_count === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                {e.matrix_room_id ? <span className="badge badge-success">Meeting room</span> : <span className="badge">No room yet</span>}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function LinkCallDialog({ call, onClose }: { call: RecentCall; onClose: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [contact, setContact] = useState<{ id: string; display_name: string } | null>(null);
  const [deal, setDeal] = useState<{ id: string; name: string } | null>(null);
  const [summary, setSummary] = useState(`${call.intent === "video" ? "Video call" : "Call"} in ${call.roomName}`.slice(0, 300));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const contactSearch = useContactSearch();
  const dealSearch = useDealSearch();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!contact && !deal) return;
    setBusy(true);
    try {
      await ws.api.post(`${ws.crm}/activities`, {
        kind: "call", summary, body, occurred_at: new Date(call.startTs).toISOString(), room_id: call.roomId, event_id: call.eventId,
        contact_id: contact?.id ?? null, opportunity_id: deal?.id ?? null,
      });
      ui.toast({ kind: "success", title: "Call added to the timeline", body: contact?.display_name ?? deal?.name });
      onClose();
    } catch (err) {
      ui.toast({ kind: "error", title: "Couldn't link the call", body: describeError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Link this call to a record" description={`${formatDayLabel(call.startTs)}, ${formatTime(call.startTs)} · ${call.roomName}`} onClose={onClose} dismissible={!busy}>
      <form className="form" onSubmit={submit} noValidate>
        <SearchPicker id={`${uid}-c`} label="Contact" placeholder="Search contacts" search={contactSearch} render={(c) => c.display_name}
          onPick={(c) => setContact({ id: c.id, display_name: c.display_name })} selected={contact?.display_name} onClear={() => setContact(null)} />
        <SearchPicker id={`${uid}-o`} label="Deal (optional)" placeholder="Search deals" search={dealSearch} render={(o) => o.name}
          onPick={(o) => setDeal({ id: o.id, name: o.name })} selected={deal?.name} onClear={() => setDeal(null)} />
        <div className="field">
          <label htmlFor={`${uid}-s`}>Summary</label>
          <input id={`${uid}-s`} type="text" value={summary} maxLength={300} onChange={(e) => setSummary(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-b`}>Your notes (optional)</label>
          <textarea id={`${uid}-b`} rows={3} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} placeholder="What was agreed" />
        </div>
        <p className="alert alert-info small">
          <Info aria-hidden="true" />
          <span>
            Saved on the record: the summary and notes you type, the call's room and event IDs, and when it started. The call itself stays end-to-end
            encrypted; who took part and the conversation are not sent.
          </span>
        </p>
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={busy || (!contact && !deal) || !summary.trim()}>
            {busy ? <Spinner size="sm" /> : <Link2 aria-hidden="true" />} Link to record
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const CALL_EVENTS = [RoomEvent.Timeline, RoomEvent.TimelineReset, MatrixEventEvent.Decrypted] as const;

function RecentCalls() {
  const { client, userId } = useMatrix();
  const ws = useWorkspace();
  const v = useEmitterVersion(client, CALL_EVENTS, 500);
  const [linking, setLinking] = useState<RecentCall | null>(null);
  const calls = useMemo(() => {
    void v;
    const perRoom = client.getRooms().filter((r) => r.getMyMembership() === "join").map((room) => {
      const live = roomSession(client, room).memberships.length;
      const history = buildCallHistory(room.getLiveTimeline().getEvents(), live);
      return { roomId: room.roomId, roomName: room.name || "Conversation", calls: history.map((c) => ({ ...c, outcome: outcomeFor(c, userId) })) };
    });
    return mergeRecentCalls(perRoom);
  }, [client, userId, v]);
  const morePossible = client.getRooms().some((r) => r.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS) !== null);
  const icon = (c: RecentCall) =>
    c.ongoing ? <PhoneCall aria-hidden="true" /> : c.outcome === "missed" ? <PhoneMissed aria-hidden="true" /> : c.outcome === "outgoing" ? <PhoneOutgoing aria-hidden="true" /> : <PhoneIncoming aria-hidden="true" />;
  return (
    <>
      <p className="alert alert-info small">
        <Info aria-hidden="true" />
        <span>
          Read on this device from your end-to-end encrypted conversations; nothing on this list is sent to the workspace server.
          {morePossible ? " Only the loaded part of each conversation is included: older calls show up after scrolling back in the conversation." : ""}
        </span>
      </p>
      {calls.length === 0 ? (
        <EmptyState icon={PhoneCall} title="No calls on this device yet">
          Calls you make or receive in conversations appear here.
        </EmptyState>
      ) : (
        <div className="ws-card">
          <ul className="ws-list">
            {calls.map((c) => (
              <li key={`${c.roomId}-${c.eventId}`} className="ws-task-row">
                <span className={c.outcome === "missed" ? "ws-overdue" : "subtle"}>{icon(c)}</span>
                <span className="ws-row-main">
                  <span className="ws-row-title">
                    <a href={roomHash(c.roomId)}>{c.roomName}</a>
                  </span>
                  <span className="ws-row-meta">
                    {c.ongoing ? "In progress" : c.outcome === "missed" ? "Missed" : c.outcome === "outgoing" ? "Outgoing" : c.outcome === "declined" ? "Declined" : "Incoming"}
                    {c.intent === "video" ? " video call" : " call"} · {formatDayLabel(c.startTs)}, {formatTime(c.startTs)}
                    {callDuration(c) ? ` · ${callDuration(c)}` : ""}
                    {c.participants > 1 ? ` · ${c.participants} people` : ""}
                  </span>
                </span>
                {ws.can("activities.create") ? (
                  <button type="button" className="btn btn-sm" onClick={() => setLinking(c)} aria-label={`Link the call in ${c.roomName} to a record`}>
                    <Link2 aria-hidden="true" /> Link to record
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {linking ? <LinkCallDialog call={linking} onClose={() => setLinking(null)} /> : null}
    </>
  );
}

function CallsPage({ path }: AreaProps) {
  const tab = path[0] === "recent" ? "recent" : path[0] === "next-steps" ? "next-steps" : "upcoming";
  return (
    <div className="ws-area-scroll">
      <PageHeader icon={Video} title="Calls & Meetings" subtitle="Meetings from your calendar, calls on this device, and next steps to review." />
      <Tabs active={tab} />
      <div className="vx-callout">
        <NoRecordingNote />
      </div>
      {tab === "upcoming" ? <Upcoming /> : null}
      {tab === "recent" ? <RecentCalls /> : null}
      {tab === "next-steps" ? (
        <div className="stack">
          <ActionItemsSection title="Suggested next steps" />
          <p className="xsmall subtle">
            <ListChecks aria-hidden="true" className="inline-icon" /> Create the task to accept a suggestion (you can change who does it), or dismiss it.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function CallsArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <CallsPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "calls",
  label: "Calls & Meetings",
  icon: Video,
  order: 40,
  status: "ready",
  feature: "crm",
  summary: "Scheduled meetings with end-to-end encrypted video calls, joined from the record they belong to.",
  component: CallsArea,
});
