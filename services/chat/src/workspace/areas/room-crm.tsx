/**
 * CRM side panel next to a conversation: link the room to a contact or deal (only the room
 * ID is stored), then see the contact's summary, open tasks and next event without leaving
 * the conversation. Message content never leaves the end-to-end encrypted room.
 */

import { useEffect, useId, useState } from "react";
import { Briefcase, CalendarClock, Contact as ContactIcon, Link2, Lock, Plus, Search, Unlink, X } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineRoomPanel, type RoomPanelProps } from "../define";
import type { Contact, ContactSummary, Opportunity, RoomLink, Task } from "../types";
import { ConnectionGate, EmptyState, ErrorState, KindBadge, LoadingState, PriorityBadge, UserLabel, formatMoney, formatWhen } from "../ui";
import { TaskCheck } from "./home";

function LinkPicker({ roomId, onLinked }: { roomId: string; onLinked: (l: RoomLink) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ contacts: Contact[]; opportunities: Opportunity[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      ws.api
        .get<{ contacts: Contact[]; opportunities: Opportunity[] }>(`${ws.crm}/search`, { q }, ctrl.signal)
        .then(setResults)
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, ws.api, ws.crm]);
  const link = async (body: Record<string, string>, key: string) => {
    setBusy(key);
    try {
      const l = await ws.api.post<RoomLink>(`${ws.crm}/room-links`, { room_id: roomId, ...body });
      ui.toast({ kind: "success", title: "Conversation linked", body: l.contact?.display_name ?? l.opportunity?.name });
      onLinked(l);
      setQ("");
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't link the conversation", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  if (!ws.can("activities.create")) return <p className="muted small">Your role can see linked records but not link conversations.</p>;
  return (
    <div className="ws-link-picker">
      <div className="ws-search sm">
        <Search aria-hidden="true" />
        <label className="visually-hidden" htmlFor={`${uid}-q`}>
          Find a contact or deal to link
        </label>
        <input id={`${uid}-q`} type="search" placeholder="Find a contact or deal" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {results ? (
        results.contacts.length + results.opportunities.length === 0 ? (
          <p className="muted small">No matches.</p>
        ) : (
          <ul className="ws-picker" aria-label="Matches">
            {results.contacts.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={!!busy} onClick={() => void link({ contact_id: c.id }, c.id)}>
                  {busy === c.id ? <Spinner size="sm" /> : <ContactIcon aria-hidden="true" />} {c.display_name}
                  {c.company ? <span className="subtle"> · {c.company}</span> : null}
                </button>
              </li>
            ))}
            {results.opportunities.map((o) => (
              <li key={o.id}>
                <button type="button" disabled={!!busy} onClick={() => void link({ opportunity_id: o.id }, o.id)}>
                  {busy === o.id ? <Spinner size="sm" /> : <Briefcase aria-hidden="true" />} {o.name}
                  <span className="subtle"> · {o.stage.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function ContactCard({ link, onUnlink }: { link: RoomLink; onUnlink: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const id = link.contact!.id;
  const res = useApiResource((api, signal) => api.get<ContactSummary>(`${ws.crm}/contacts/${id}/summary`, undefined, signal), [ws.crm, id]);
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const uid = useId();
  const s = res.data;
  return (
    <article className="ws-room-card" aria-label={`Linked contact ${link.contact!.display_name}`}>
      <header className="ws-room-card-header">
        <div>
          <a href={areaHash("contacts", id)} className="ws-row-title">
            {link.contact!.display_name}
          </a>
          {s ? (
            <p className="xsmall muted">
              {[s.contact.company, s.contact.email, s.contact.phone].filter(Boolean).join(" · ") || "No contact details"}
            </p>
          ) : null}
        </div>
        {link.permissions.delete ? (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Unlink this contact" title="Unlink" onClick={onUnlink}>
            <Unlink aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} compact /> : null}
      {!s && !res.error ? <LoadingState /> : null}
      {s ? (
        <>
          <div className="cluster ws-badges">
            <KindBadge kind={s.contact.kind} />
            <PriorityBadge priority={s.contact.priority} />
            <span className="xsmall muted">
              Owner <UserLabel user={s.contact.owner} fallback="none" />
            </span>
          </div>
          <div className="ws-room-block">
            <h3>
              <CalendarClock aria-hidden="true" /> Next
            </h3>
            {s.next_event ? (
              <p className="small">
                {s.next_event.title} · {formatWhen(s.next_event.start_at)}
                {s.next_event.location ? ` · ${s.next_event.location}` : ""}
              </p>
            ) : s.open_tasks[0]?.due_at ? (
              <p className="small">
                {s.open_tasks[0].title} · {formatWhen(s.open_tasks[0].due_at)}
              </p>
            ) : (
              <p className="muted small">Nothing scheduled.</p>
            )}
            {s.last_activity ? (
              <p className="xsmall subtle">
                Last activity: {s.last_activity.summary} ({formatWhen(s.last_activity.occurred_at)})
              </p>
            ) : null}
          </div>
          <div className="ws-room-block">
            <h3>Open tasks {s.open_task_count ? <span className="count">{s.open_task_count}</span> : null}</h3>
            {s.open_tasks.length ? (
              <ul className="ws-list compact">
                {s.open_tasks.map((t) => (
                  <li key={t.id} className={`ws-task-row${t.status === "done" ? " done" : ""}`}>
                    <TaskCheck
                      task={t}
                      onDone={(u: Task) => res.setData((p) => (p ? { ...p, open_tasks: p.open_tasks.map((x) => (x.id === u.id ? u : x)) } : p))}
                    />
                    <div className="ws-row-main">
                      <span className="ws-row-title">{t.title}</span>
                      <span className={`ws-row-meta${t.is_overdue ? " ws-overdue" : ""}`}>{t.due_at ? formatWhen(t.due_at) : "No due date"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No open tasks.</p>
            )}
            {ws.can("tasks.create") || ws.can("tasks.create_own") ? (
              <form
                className="ws-inline-fields"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!title.trim()) return;
                  setAdding(true);
                  try {
                    const t = await ws.api.post<Task>(`${ws.crm}/tasks`, { title, contact_id: id });
                    res.setData((p) => (p ? { ...p, open_tasks: [t, ...p.open_tasks], open_task_count: p.open_task_count + 1 } : p));
                    setTitle("");
                    ui.toast({ kind: "success", title: "Task added" });
                  } catch (err) {
                    ui.toast({ kind: "error", title: "Couldn't add the task", body: describeError(err) });
                  } finally {
                    setAdding(false);
                  }
                }}
              >
                <label className="visually-hidden" htmlFor={`${uid}-t`}>
                  New task for {link.contact!.display_name}
                </label>
                <input id={`${uid}-t`} type="text" placeholder="Add a task…" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                <button type="submit" className="btn btn-sm" disabled={adding || !title.trim()}>
                  <Plus aria-hidden="true" /> Add task
                </button>
              </form>
            ) : null}
          </div>
          {s.open_opportunities.length ? (
            <div className="ws-room-block">
              <h3>Open deals</h3>
              <ul className="ws-list compact">
                {s.open_opportunities.map((o) => (
                  <li key={o.id}>
                    <a className="ws-row-link" href={areaHash("crm", o.id)}>
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
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function DealCardLink({ link, onUnlink }: { link: RoomLink; onUnlink: () => void }) {
  return (
    <article className="ws-room-card" aria-label={`Linked deal ${link.opportunity!.name}`}>
      <header className="ws-room-card-header">
        <div>
          <a href={areaHash("crm", link.opportunity!.id)} className="ws-row-title">
            <Briefcase aria-hidden="true" className="inline-icon" /> {link.opportunity!.name}
          </a>
          <p className="xsmall muted">Deal · {link.opportunity!.status}</p>
        </div>
        {link.permissions.delete ? (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Unlink this deal" title="Unlink" onClick={onUnlink}>
            <Unlink aria-hidden="true" />
          </button>
        ) : null}
      </header>
    </article>
  );
}

function RoomCrmPanel({ roomId, onClose }: RoomPanelProps) {
  const ws = useWorkspace();
  const ui = useUi();
  const links = useApiResource((api, signal) => api.list<RoomLink>(`${ws.crm}/room-links`, { room_id: roomId }, signal), [ws.crm, roomId]);
  const [picking, setPicking] = useState(false);
  const rows = links.data?.data ?? [];
  const unlink = async (l: RoomLink) => {
    try {
      await ws.api.delete(`${ws.crm}/room-links/${l.id}`);
      links.setData((p) => (p ? { ...p, data: p.data.filter((x) => x.id !== l.id) } : p));
      ui.toast({ kind: "info", title: "Unlinked", body: l.contact?.display_name ?? l.opportunity?.name });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't unlink", body: describeError(e) });
    }
  };
  return (
    <div className="panel ws-room-panel">
      <header className="panel-header">
        <h2>
          <ContactIcon aria-hidden="true" /> CRM
        </h2>
        <button type="button" className="icon-btn" aria-label="Close CRM panel" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="panel-body">
        {links.error ? <ErrorState error={links.error} onRetry={links.reload} compact /> : null}
        {links.loading && !links.data ? <LoadingState /> : null}
        {links.data && rows.length === 0 ? (
          <EmptyState icon={Link2} title="Not linked to a record">
            Link this conversation to a contact or deal to see their tasks and next steps here.
          </EmptyState>
        ) : null}
        {rows.map((l) =>
          l.contact ? (
            <ContactCard key={l.id} link={l} onUnlink={() => void unlink(l)} />
          ) : l.opportunity ? (
            <DealCardLink key={l.id} link={l} onUnlink={() => void unlink(l)} />
          ) : null,
        )}
        {links.data ? (
          rows.length === 0 || picking ? (
            <LinkPicker
              roomId={roomId}
              onLinked={(l) => {
                links.setData((p) => (p ? { ...p, data: [l, ...p.data.filter((x) => x.id !== l.id)] } : p));
                setPicking(false);
              }}
            />
          ) : ws.can("activities.create") ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(true)}>
              <Link2 aria-hidden="true" /> Link another record
            </button>
          ) : null
        ) : null}
        <p className="ws-e2ee-note xsmall subtle">
          <Lock aria-hidden="true" className="inline-icon" /> Only this conversation's room ID is saved with the record. Messages stay end-to-end
          encrypted and are never sent to the workspace server.
        </p>
      </div>
    </div>
  );
}

function Gated(props: RoomPanelProps) {
  return (
    <ConnectionGate>
      <RoomCrmPanel {...props} />
    </ConnectionGate>
  );
}

export const roomPanel = defineRoomPanel({
  id: "crm",
  label: "CRM",
  icon: ContactIcon,
  order: 10,
  feature: "crm",
  component: Gated,
});
