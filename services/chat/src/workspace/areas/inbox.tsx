/**
 * Unified inbox: native conversations (read here from the Matrix client, decrypted on this
 * device and never sent to the server) merged with synced Gmail threads, Slack messages,
 * HighLevel conversations and missed calls, workspace notifications and meeting follow-ups.
 * Every row says where it came from; external items are never shown as native, and never as
 * "sent" unless the provider confirmed it. Records linked to an item open in a side panel
 * without leaving the inbox.
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Briefcase,
  Building2,
  CalendarClock,
  Check,
  Contact as ContactIcon,
  ExternalLink,
  FlaskConical,
  Hash,
  Inbox as InboxIcon,
  Link2,
  ListChecks,
  Lock,
  Mail,
  MessageSquare,
  Paperclip,
  PhoneMissed,
  Plug,
  RefreshCw,
  Reply,
  Search,
  Send,
  Undo2,
  Unlink,
  X,
} from "lucide-react";
import "../../styles/integrations.css";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { useRoomSummaries } from "../../hooks/matrix";
import { roomHash } from "../../lib/matrix-id";
import { useClient } from "../../matrix/context";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { ContactSummary, Opportunity, Page, Priority, RoomLink, Task } from "../types";
import { ConnectionGate, EmptyState, ErrorState, KindBadge, LoadingState, PriorityBadge, formatMoney, formatWhen, initials } from "../ui";
import { AskAiPanel } from "../assistant/components";
import { listKeys } from "./contacts";
import {
  ORIGIN_LABEL,
  filterEntries,
  fromMeetings,
  fromNativeRooms,
  fromNotifications,
  fromServerItems,
  groupEntries,
  mergeInbox,
  nativeGroupKey,
  unreadTotal,
  type InboxEntry,
  type MeetingInput,
  type SourceFilter,
} from "../integrations/merge";
import { ConfirmActionDialog, ExternalNote, MOCK_LABEL, MockBadge, RecordPicker, SafeHtmlFrame, SourceBadge, downloadWithToken } from "../integrations/ui";
import type {
  Connection,
  Draft,
  EmailMessageMeta,
  GhlMessage,
  MessageBody,
  Mute,
  PendingAction,
  ServerInboxItem,
  Suggestion,
  WorkspaceNotification,
} from "../integrations/types";

const SOURCES: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "email", label: "Email" },
  { id: "slack", label: "Slack" },
  { id: "gohighlevel", label: "HighLevel" },
  { id: "notifications", label: "Notifications" },
];

const ROW_ICON: Record<string, typeof Mail> = {
  conversation: MessageSquare,
  invite: MessageSquare,
  missed_call: PhoneMissed,
  email_thread: Mail,
  slack_message: Hash,
  ghl_conversation: Building2,
  notification: Bell,
  meeting_follow_up: CalendarClock,
};

function useBase(): string {
  const ws = useWorkspace();
  return `/workspaces/${ws.workspace!.id}/integrations`;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function entryHash(e: InboxEntry): string {
  switch (e.ref.type) {
    case "room":
      return areaHash("inbox", "room", e.ref.roomId);
    case "item":
      return areaHash("inbox", "item", e.ref.id);
    case "notification":
      return areaHash("inbox", "notification", e.ref.id);
    case "meeting":
      return areaHash("inbox", "meeting", e.ref.id);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function selectedKey(path: string[]): string | null {
  // #/inbox/<inbox_item_id> (links from the assistant's tool results) opens that synced item.
  if (path.length === 1 && UUID_RE.test(path[0])) return `item:${path[0]}`;
  if (path.length < 2) return null;
  const [kind, id] = path;
  if (kind === "room") return `native:${id}`;
  if (kind === "item") return `item:${id}`;
  if (kind === "notification") return `notification:${id}`;
  if (kind === "meeting") return `meeting:${id}`;
  return null;
}

// --- record side panel --------------------------------------------------------------------------

export interface RecordRef {
  type: string;
  id: string;
  label: string;
}

function ContactPanelBody({ id }: { id: string }) {
  const ws = useWorkspace();
  const res = useApiResource((api, signal) => api.get<ContactSummary>(`${ws.crm}/contacts/${id}/summary`, undefined, signal), [ws.crm, id]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} compact />;
  if (!res.data) return <LoadingState />;
  const s = res.data;
  return (
    <div className="stack">
      <div className="cluster">
        <KindBadge kind={s.contact.kind} />
        <PriorityBadge priority={s.contact.priority} />
      </div>
      <p className="small">{[s.contact.company, s.contact.email, s.contact.phone].filter(Boolean).join(" · ") || "No contact details"}</p>
      <section className="ib-card">
        <h3>
          <CalendarClock aria-hidden="true" /> Next
        </h3>
        {s.next_event ? (
          <p className="small">
            {s.next_event.title} · {formatWhen(s.next_event.start_at)}
          </p>
        ) : (
          <p className="muted small">Nothing scheduled.</p>
        )}
      </section>
      <section className="ib-card">
        <h3>
          <ListChecks aria-hidden="true" /> Open tasks {s.open_task_count ? `(${s.open_task_count})` : ""}
        </h3>
        {s.open_tasks.length ? (
          <ul className="ib-plain small">
            {s.open_tasks.map((t) => (
              <li key={t.id}>
                {t.title}
                {t.due_at ? <span className={t.is_overdue ? "ws-overdue" : "subtle"}> · {formatWhen(t.due_at)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No open tasks.</p>
        )}
      </section>
      {s.open_opportunities.length ? (
        <section className="ib-card">
          <h3>
            <Briefcase aria-hidden="true" /> Open deals
          </h3>
          <ul className="ib-plain small">
            {s.open_opportunities.map((o) => (
              <li key={o.id}>
                {o.name} · {o.stage.name} · {formatMoney(o.value, o.currency)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {s.last_activity ? (
        <p className="xsmall subtle">
          Last activity: {s.last_activity.summary} ({formatWhen(s.last_activity.occurred_at)})
        </p>
      ) : null}
      <a className="btn btn-sm" href={areaHash("contacts", id)}>
        Open contact
      </a>
    </div>
  );
}

function DealPanelBody({ id }: { id: string }) {
  const ws = useWorkspace();
  const res = useApiResource((api, signal) => api.get<Opportunity>(`${ws.crm}/opportunities/${id}`, undefined, signal), [ws.crm, id]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} compact />;
  if (!res.data) return <LoadingState />;
  const o = res.data;
  return (
    <div className="stack">
      <p className="small">
        {o.stage.name} · {formatMoney(o.value, o.currency)} · {o.status}
      </p>
      {o.contacts.length ? <p className="small">With {o.contacts.map((c) => c.display_name).join(", ")}</p> : null}
      {o.expected_close_date ? <p className="small muted">Expected close {formatWhen(o.expected_close_date, { time: false })}</p> : null}
      <a className="btn btn-sm" href={areaHash("crm", id)}>
        Open deal
      </a>
    </div>
  );
}

function TaskPanelBody({ id }: { id: string }) {
  const ws = useWorkspace();
  const res = useApiResource((api, signal) => api.get<Task>(`${ws.crm}/tasks/${id}`, undefined, signal), [ws.crm, id]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} compact />;
  if (!res.data) return <LoadingState />;
  const t = res.data;
  return (
    <div className="stack">
      <p className="small">
        {t.status.replace("_", " ")} {t.due_at ? `· due ${formatWhen(t.due_at)}` : ""} {t.assignee ? `· ${t.assignee.name}` : ""}
      </p>
      {t.description ? <p className="small ib-message-text">{t.description}</p> : null}
      <a className="btn btn-sm" href={areaHash("tasks")}>
        Open tasks
      </a>
    </div>
  );
}

function RecordDrawer({ record, onClose }: { record: RecordRef; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const Icon = record.type === "crm.opportunity" ? Briefcase : record.type === "crm.task" ? ListChecks : ContactIcon;
  return (
    <div className="ib-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="ib-drawer" role="dialog" aria-modal="true" aria-label={record.label}>
        <header className="ib-drawer-head">
          <h2>
            <Icon aria-hidden="true" /> {record.label}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} autoFocus>
            <X aria-hidden="true" />
          </button>
        </header>
        {record.type === "crm.contact" ? (
          <ContactPanelBody id={record.id} />
        ) : record.type === "crm.opportunity" ? (
          <DealPanelBody id={record.id} />
        ) : record.type === "crm.task" ? (
          <TaskPanelBody id={record.id} />
        ) : (
          <p className="small muted">This record ({record.type}) opens in its own area of the workspace.</p>
        )}
      </aside>
    </div>
  );
}

// --- links and suggestions -------------------------------------------------------------------------

function LinksCard({ item, onChanged, onOpen }: { item: ServerInboxItem; onChanged: (i: ServerInboxItem) => void; onOpen: (r: RecordRef) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const sugg = useApiResource((api, signal) => api.get<Suggestion[]>(`${base}/inbox/${item.id}/suggestions`, undefined, signal), [base, item.id, item.links.length]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const refresh = async () => onChanged(await ws.api.get<ServerInboxItem>(`${base}/inbox/${item.id}`));
  const link = async (target: { type: string; id: string; label: string }) => {
    setBusy(true);
    try {
      await ws.api.post(`${base}/inbox/${item.id}/links`, { target: { type: target.type, id: target.id } });
      ui.toast({ kind: "success", title: "Linked", body: target.label });
      setPicking(false);
      await refresh();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't link", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (linkId: string) => {
    try {
      await ws.api.delete(`${base}/inbox/${item.id}/links/${linkId}`);
      await refresh();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't unlink", body: describeError(e) });
    }
  };
  return (
    <section className="ib-card" aria-label="Linked records">
      <h3>
        <Link2 aria-hidden="true" /> Linked records
      </h3>
      {item.links.length ? (
        <ul className="ib-links">
          {item.links.map((l) => (
            <li key={l.id}>
              <button type="button" className="link" onClick={() => onOpen(l.target)}>
                {l.target.label}
              </button>
              <span className="cluster">
                {l.on_timeline ? <span className="xsmall subtle">on timeline</span> : null}
                {l.permissions.delete ? (
                  <button type="button" className="icon-btn icon-btn-sm" aria-label={`Unlink ${l.target.label}`} title="Unlink" onClick={() => void unlink(l.id)}>
                    <Unlink aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Not linked to a record yet.</p>
      )}
      {sugg.data?.length && item.capabilities.link ? (
        <div className="stack">
          <p className="xsmall subtle">Suggestions (nothing is linked or merged until you choose):</p>
          <ul className="ib-links">
            {sugg.data.map((s) => (
              <li key={s.id}>
                <span className="small">
                  {s.label} <span className="subtle">· {s.reason}</span>
                </span>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void link(s)}>
                  Link
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {item.capabilities.link ? (
        picking ? (
          <RecordPicker onPick={(t) => void link(t)} busy={busy} />
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(true)}>
            <Link2 aria-hidden="true" /> Link to a contact or deal
          </button>
        )
      ) : null}
      {item.capabilities.link && item.visibility === "personal" ? (
        <p className="xsmall subtle">Linking adds the subject and snippet to the record's timeline, visible to everyone who can see that record.</p>
      ) : null}
    </section>
  );
}

// --- workspace state (priority, assignment, labels, done, mute) -----------------------------------------

function StateCard({ item, onChanged, muted, onMuteToggle }: { item: ServerInboxItem; onChanged: (i: ServerInboxItem) => void; muted: boolean; onMuteToggle: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const [labels, setLabels] = useState(item.labels.join(", "));
  useEffect(() => setLabels(item.labels.join(", ")), [item.labels]);
  const patch = async (body: Record<string, unknown>) => {
    try {
      onChanged(await ws.api.patch<ServerInboxItem>(`${base}/inbox/${item.id}`, body));
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save", body: describeError(e) });
    }
  };
  const can = item.capabilities.change;
  const people = item.visibility === "personal" ? ws.members.filter((m) => m.id === ws.me?.user.id) : ws.members;
  return (
    <section className="ib-card" aria-label="Status">
      <div className="ib-state-grid">
        <div className="field">
          <label htmlFor={`${uid}-pri`}>Priority</label>
          <select id={`${uid}-pri`} value={item.priority} disabled={!can} onChange={(e) => void patch({ priority: e.target.value as Priority })}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-who`}>Assigned to</label>
          <select id={`${uid}-who`} value={item.assignee?.id ?? ""} disabled={!can} onChange={(e) => void patch({ assignee_id: e.target.value || null })}>
            <option value="">Nobody</option>
            {people.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ labels: labels.split(",").map((s) => s.trim()).filter(Boolean) });
          }}
        >
          <label htmlFor={`${uid}-lab`}>Labels (comma-separated)</label>
          <div className="ws-inline-fields">
            <input id={`${uid}-lab`} type="text" value={labels} disabled={!can} maxLength={400} onChange={(e) => setLabels(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={!can}>
              Save
            </button>
          </div>
        </form>
      </div>
      <div className="cluster">
        {can ? (
          <button type="button" className="btn btn-sm" onClick={() => void patch({ status: item.status === "done" ? "open" : "done" })}>
            {item.status === "done" ? <Undo2 aria-hidden="true" /> : <Check aria-hidden="true" />} {item.status === "done" ? "Reopen" : "Mark done"}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onMuteToggle} title={item.group.label}>
          {muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />} {muted ? "Unmute" : `Mute ${item.source === "slack" ? "channel" : item.source === "gmail" ? "sender" : "conversation"}`}
        </button>
      </div>
      {!can ? <p className="xsmall subtle">Your role can read this but not change it.</p> : null}
    </section>
  );
}

// --- Gmail ------------------------------------------------------------------------------------------------

function EmailMessageView({ item, m }: { item: ServerInboxItem; m: EmailMessageMeta }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const [body, setBody] = useState<MessageBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formatted, setFormatted] = useState(false);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setBody(await ws.api.get<MessageBody>(`${base}/inbox/${item.id}/messages/${m.id}/body`));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  const attachments = body?.attachments ?? m.attachments;
  return (
    <li className={`ib-message${m.outgoing ? " outgoing" : ""}`}>
      <div className="ib-message-head">
        <strong>{m.outgoing ? "You" : m.from.name || m.from.address}</strong>
        <span className="xsmall subtle">
          <time dateTime={m.sent_at}>{formatWhen(m.sent_at)}</time>
        </span>
      </div>
      <p className="xsmall subtle">
        To {m.to.map((t) => t.name || t.address).join(", ") || "—"}
        {m.cc.length ? ` · Cc ${m.cc.map((t) => t.name || t.address).join(", ")}` : ""}
      </p>
      {body ? (
        formatted && body.html ? (
          <SafeHtmlFrame html={body.html} title={`Message from ${m.from.address}`} />
        ) : (
          <p className="ib-message-text">{body.text || "(No text.)"}</p>
        )
      ) : (
        <p className="ib-message-text muted">{m.snippet}</p>
      )}
      {error ? <ErrorState error={error} onRetry={() => void load()} compact /> : null}
      <div className="cluster">
        {!body ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner size="sm" /> : <Mail aria-hidden="true" />} Show the full message
          </button>
        ) : body.has_html ? (
          <button type="button" className="btn btn-sm btn-ghost" aria-pressed={formatted} onClick={() => setFormatted((v) => !v)}>
            {formatted ? "Plain text" : "Formatted"}
          </button>
        ) : null}
        {body && body.images_blocked ? <span className="xsmall subtle">{body.images_blocked} image(s) not loaded (remote images are blocked)</span> : null}
      </div>
      {attachments.length ? (
        <ul className="ib-attachments" aria-label="Attachments">
          {attachments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  void downloadWithToken(() => ws.auth.accessToken(), ws.api.url(`${base}/inbox/${item.id}/messages/${m.id}/attachments/${encodeURIComponent(a.id)}`), a.filename).catch((e: unknown) =>
                    ui.toast({ kind: "error", title: "Couldn't download", body: describeError(e) }),
                  )
                }
              >
                <Paperclip aria-hidden="true" /> {a.filename} <span className="subtle">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DraftCard({ draft, onChanged, onSent }: { draft: Draft; onChanged: (d: Draft | null) => void; onSent: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const [text, setText] = useState(draft.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [sent, setSent] = useState(false);
  const dirty = text !== draft.body;
  const save = async () => {
    setBusy("save");
    try {
      onChanged(await ws.api.patch<Draft>(`${base}/drafts/${draft.id}`, { body: text }));
      ui.toast({ kind: "success", title: "Draft saved in Gmail" });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save the draft", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  const review = async () => {
    setBusy("review");
    try {
      if (dirty) onChanged(await ws.api.patch<Draft>(`${base}/drafts/${draft.id}`, { body: text }));
      setAction(await ws.api.post<PendingAction>(`${base}/drafts/${draft.id}/send-request`, {}));
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't prepare sending", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    setBusy("discard");
    try {
      await ws.api.delete(`${base}/drafts/${draft.id}`);
      onChanged(null);
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't discard", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ib-draft">
      <p className="small">
        <strong>Draft reply</strong> <span className="subtle">to {draft.to.join(", ")} · saved in your Gmail drafts, not sent</span>
      </p>
      <label className="visually-hidden" htmlFor={`${uid}-body`}>
        Draft text
      </label>
      <textarea id={`${uid}-body`} rows={6} value={text} maxLength={50000} onChange={(e) => setText(e.target.value)} />
      <div className="cluster">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void review()} disabled={!!busy || !text.trim()}>
          {busy === "review" ? <Spinner size="sm" /> : <Send aria-hidden="true" />} Review and send…
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void save()} disabled={!!busy || !dirty}>
          {busy === "save" ? <Spinner size="sm" /> : null} Save draft
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void discard()} disabled={!!busy}>
          Discard
        </button>
      </div>
      {action ? (
        <ConfirmActionDialog
          action={action}
          title="Send this email?"
          confirmLabel="Send now"
          onClose={() => {
            setAction(null);
            // Refresh only after the person closed the confirmation (the draft card goes away).
            if (sent) onSent();
          }}
          onDone={(a) => setSent(a.status === "executed")}
        />
      ) : null}
    </div>
  );
}

function EmailDetail({ item, onChanged }: { item: ServerInboxItem; onChanged: (i: ServerInboxItem) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const drafts = item.drafts ?? [];
  const refresh = async () => onChanged(await ws.api.get<ServerInboxItem>(`${base}/inbox/${item.id}`));
  return (
    <>
      <section className="ib-card" aria-label="Messages">
        <ul className="ib-messages">
          {(item.messages ?? []).map((m) => (
            <EmailMessageView key={m.id} item={item} m={m} />
          ))}
        </ul>
      </section>
      <section className="ib-card" aria-label="Reply">
        <h3>
          <Reply aria-hidden="true" /> Reply
        </h3>
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            onChanged={() => void refresh()}
            onSent={() => {
              ui.toast({ kind: "success", title: "Sent", body: "Gmail confirmed the message." });
              void refresh();
            }}
          />
        ))}
        {item.capabilities.reply ? (
          drafts.length === 0 ? (
            <form
              className="ib-composer"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await ws.api.post<Draft>(`${base}/inbox/${item.id}/drafts`, { body: reply });
                  setReply("");
                  ui.toast({ kind: "success", title: "Draft saved in Gmail", body: "Review it and send when you're ready." });
                  await refresh();
                } catch (err) {
                  ui.toast({ kind: "error", title: "Couldn't create the draft", body: err instanceof ApiError ? (err.field("to") ?? describeError(err)) : describeError(err) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="visually-hidden" htmlFor={`${uid}-reply`}>
                Reply
              </label>
              <textarea id={`${uid}-reply`} rows={5} placeholder="Write a reply. It's saved as a Gmail draft first; nothing is sent until you confirm." value={reply} maxLength={50000} onChange={(e) => setReply(e.target.value)} />
              <div className="cluster">
                <button type="submit" className="btn btn-sm" disabled={busy || !reply.trim()}>
                  {busy ? <Spinner size="sm" /> : null} Save as draft
                </button>
              </div>
            </form>
          ) : null
        ) : (
          <p className="small muted">{item.capabilities.reply_unsupported_reason}</p>
        )}
      </section>
    </>
  );
}

// --- Slack and HighLevel ------------------------------------------------------------------------------------

function SlackDetail({ item }: { item: ServerInboxItem }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<PendingAction | null>(null);
  const meta = item.meta as { channel?: string; channel_id?: string; ts?: string; thread_ts?: string; author?: string; mentions?: string[] };
  return (
    <>
      <section className="ib-card" aria-label="Message">
        <div className="ib-message-head">
          <strong>{meta.author || "Someone"}</strong>
          <span className="xsmall subtle">
            in {meta.channel ? `#${meta.channel}` : "a channel"} · <time dateTime={item.occurred_at}>{formatWhen(item.occurred_at)}</time>
          </span>
        </div>
        <p className="ib-message-text">{item.snippet}</p>
        {meta.mentions?.length ? <p className="xsmall subtle">Mentions {meta.mentions.length} {meta.mentions.length === 1 ? "person" : "people"}</p> : null}
      </section>
      <section className="ib-card" aria-label="Reply in Slack">
        <h3>
          <Reply aria-hidden="true" /> Reply in the thread
        </h3>
        {item.capabilities.reply ? (
          <form
            className="ib-composer"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                setAction(
                  await ws.api.post<PendingAction>(`${base}/slack/post-request`, {
                    connection_id: item.connection.id,
                    channel_id: meta.channel_id,
                    text,
                    thread_ts: meta.thread_ts || meta.ts || "",
                  }),
                );
              } catch (err) {
                ui.toast({ kind: "error", title: "Couldn't prepare the post", body: describeError(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="visually-hidden" htmlFor={`${uid}-slack`}>
              Reply text
            </label>
            <textarea id={`${uid}-slack`} rows={3} value={text} maxLength={4000} placeholder="Write a reply. You'll review it before it's posted." onChange={(e) => setText(e.target.value)} />
            <div className="cluster">
              <button type="submit" className="btn btn-sm" disabled={busy || !text.trim()}>
                {busy ? <Spinner size="sm" /> : <Send aria-hidden="true" />} Review and post…
              </button>
            </div>
          </form>
        ) : (
          <p className="small muted">{item.capabilities.reply_unsupported_reason}</p>
        )}
      </section>
      {action ? (
        <ConfirmActionDialog
          action={action}
          title="Post to Slack?"
          confirmLabel="Post now"
          onClose={() => setAction(null)}
          onDone={(a) => {
            if (a.status === "executed") setText("");
          }}
        />
      ) : null}
    </>
  );
}

function HighLevelDetail({ item }: { item: ServerInboxItem }) {
  const base = useBase();
  const res = useApiResource((api, signal) => api.get<{ messages: GhlMessage[] }>(`${base}/inbox/${item.id}/conversation`, undefined, signal), [base, item.id]);
  return (
    <section className="ib-card" aria-label="Conversation">
      <h3>
        <Building2 aria-hidden="true" /> Latest messages (read-only)
      </h3>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} compact /> : null}
      {!res.data && !res.error ? <LoadingState label="Fetching from HighLevel…" /> : null}
      {res.data ? (
        res.data.messages.length ? (
          <ul className="ib-messages">
            {res.data.messages.map((m) => (
              <li key={m.id} className={`ib-message${m.direction === "outbound" ? " outgoing" : ""}`}>
                <div className="ib-message-head">
                  <strong>
                    {m.direction === "outbound" ? "Outbound" : "Inbound"} · {m.type.replace("TYPE_", "").toLowerCase()}
                  </strong>
                  <span className="xsmall subtle">{m.date ? formatWhen(m.date) : ""}</span>
                </div>
                {m.body ? <p className="ib-message-text">{m.body}</p> : null}
                {m.call_status ? <p className="small muted">Call: {m.call_status.replace("-", " ")}</p> : null}
                {m.attachments ? <p className="xsmall subtle">{m.attachments} attachment(s), open in HighLevel</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No messages returned.</p>
        )
      ) : null}
      <p className="small muted">{item.capabilities.reply_unsupported_reason}</p>
    </section>
  );
}

function OpenExternal({ item }: { item: ServerInboxItem }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const [busy, setBusy] = useState(false);
  if (item.source === "slack") {
    return (
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await ws.api.get<{ permalink: string }>(`${base}/inbox/${item.id}/permalink`);
            if (r.permalink) window.open(r.permalink, "_blank", "noopener,noreferrer");
          } catch (e) {
            ui.toast({ kind: "error", title: "Couldn't get the link", body: describeError(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner size="sm" /> : <ExternalLink aria-hidden="true" />} {item.open_label}
      </button>
    );
  }
  if (!item.external_url) return null;
  return (
    <a className="btn btn-sm" href={item.external_url} target="_blank" rel="noopener noreferrer">
      <ExternalLink aria-hidden="true" /> {item.open_label}
    </a>
  );
}

function ItemDetail({ id, muted, onMuteToggle, onChanged, onOpenRecord }: {
  id: string;
  muted: (key: string) => boolean;
  onMuteToggle: (key: string, label: string) => void;
  onChanged: (i: ServerInboxItem) => void;
  onOpenRecord: (r: RecordRef) => void;
}) {
  const ws = useWorkspace();
  const base = useBase();
  const res = useApiResource((api, signal) => api.get<ServerInboxItem>(`${base}/inbox/${id}`, undefined, signal), [base, id]);
  useEffect(() => {
    if (res.data?.unread) {
      void ws.api.post(`${base}/inbox/mark`, { item_ids: [id], read: true }).then(() => onChanged({ ...res.data!, unread: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data?.id]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <LoadingState />;
  const item = res.data;
  const update = (i: ServerInboxItem) => {
    res.setData(i);
    onChanged(i);
  };
  const source = item.source === "gmail" ? "gmail" : item.source === "slack" ? "slack" : "gohighlevel";
  return (
    <article className="ib-detail" aria-label={item.title}>
      <header className="ib-detail-head">
        <a href={areaHash("inbox")} className="icon-btn ws-back" aria-label="Back to the inbox">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ib-detail-titles">
          <h2>{item.title}</h2>
          <div className="cluster">
            <SourceBadge source={source} origin={item.origin} />
            <span className="badge">{item.kind_label}</span>
            <MockBadge show={item.is_mock} label={item.mock_label} />
            {item.visibility === "personal" ? (
              <span className="badge" title="Only you see this mailbox">
                <Lock aria-hidden="true" /> Only you
              </span>
            ) : null}
            <PriorityBadge priority={item.priority} />
            {item.status === "done" ? <span className="badge ib-status-ok">Done</span> : null}
          </div>
          {item.participants.length ? (
            <p className="xsmall subtle">
              {item.participants
                .slice(0, 6)
                .map((p) => p.name || p.address)
                .join(", ")}
              {item.participants.length > 6 ? ` and ${item.participants.length - 6} more` : ""}
            </p>
          ) : null}
          <ExternalNote />
        </div>
        <div className="ib-detail-actions">
          <OpenExternal item={item} />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void ws.api.post(`${base}/inbox/mark`, { item_ids: [item.id], read: false }).then(() => update({ ...item, unread: true }))}
          >
            Mark unread
          </button>
        </div>
      </header>
      <div className="ib-detail-grid">
        <div className="ib-detail-main">
          {item.source === "gmail" ? <EmailDetail item={item} onChanged={update} /> : item.source === "slack" ? <SlackDetail item={item} /> : <HighLevelDetail item={item} />}
        </div>
        <aside className="ib-side">
          <StateCard item={item} onChanged={update} muted={muted(item.group.key)} onMuteToggle={() => onMuteToggle(item.group.key, item.group.label)} />
          <LinksCard item={item} onChanged={update} onOpen={onOpenRecord} />
          <AskAiPanel
            context={{ inbox_item_id: item.id }}
            prompts={item.source === "gmail" ? ["Summarise this thread", "Suggest a reply"] : ["Summarise this"]}
          />
        </aside>
      </div>
    </article>
  );
}

// --- native conversations, notifications, meetings ---------------------------------------------------------

function NativeDetail({ entry, muted, onMuteToggle, onOpenRecord }: { entry: InboxEntry; muted: boolean; onMuteToggle: () => void; onOpenRecord: (r: RecordRef) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const roomId = (entry.ref as { roomId: string }).roomId;
  const links = useApiResource(
    (api, signal) => (ws.hasFeature("crm") ? api.list<RoomLink>(`${ws.crm}/room-links`, { room_id: roomId }, signal) : Promise.resolve(null)),
    [ws.crm, roomId],
  );
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const link = async (t: { type: string; id: string; label: string }) => {
    setBusy(true);
    try {
      await ws.api.post(`${ws.crm}/room-links`, { room_id: roomId, ...(t.type === "crm.contact" ? { contact_id: t.id } : { opportunity_id: t.id }) });
      ui.toast({ kind: "success", title: "Conversation linked", body: t.label });
      setPicking(false);
      links.reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't link", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const rows = links.data?.data ?? [];
  return (
    <article className="ib-detail" aria-label={entry.title}>
      <header className="ib-detail-head">
        <a href={areaHash("inbox")} className="icon-btn ws-back" aria-label="Back to the inbox">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ib-detail-titles">
          <h2>{entry.title}</h2>
          <div className="cluster">
            <SourceBadge source="chat" origin="native" />
            {entry.unreadCount ? <span className="badge badge-accent">{entry.unreadCount} unread</span> : null}
          </div>
          <p className="ib-e2ee small">
            <Lock aria-hidden="true" />
            <span>End-to-end encrypted. This preview was decrypted on this device; it isn't stored or sent anywhere.</span>
          </p>
        </div>
        <div className="ib-detail-actions">
          <a className="btn btn-sm btn-primary" href={roomHash(roomId)}>
            <MessageSquare aria-hidden="true" /> Open conversation
          </a>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onMuteToggle}>
            {muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />} {muted ? "Show in inbox" : "Hide from inbox"}
          </button>
        </div>
      </header>
      {entry.preview ? (
        <section className="ib-card">
          <p className="ib-message-text">{entry.preview}</p>
        </section>
      ) : null}
      {ws.hasFeature("crm") ? (
        <section className="ib-card" aria-label="Linked records">
          <h3>
            <Link2 aria-hidden="true" /> Linked records
          </h3>
          {rows.length ? (
            <ul className="ib-links">
              {rows.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      onOpenRecord(l.contact ? { type: "crm.contact", id: l.contact.id, label: l.contact.display_name } : { type: "crm.opportunity", id: l.opportunity!.id, label: l.opportunity!.name })
                    }
                  >
                    {l.contact?.display_name ?? l.opportunity?.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Not linked to a record. Only the room ID is saved when you link it.</p>
          )}
          {ws.can("activities.create") ? (
            picking ? (
              <RecordPicker onPick={(t) => void link(t)} busy={busy} />
            ) : (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(true)}>
                <Link2 aria-hidden="true" /> Link to a contact or deal
              </button>
            )
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

function NotificationDetail({ n, onRead, muted, onMuteToggle }: { n: WorkspaceNotification; onRead: (n: WorkspaceNotification) => void; muted: boolean; onMuteToggle: () => void }) {
  const ws = useWorkspace();
  useEffect(() => {
    if (!n.read) {
      void ws.api
        .patch<WorkspaceNotification>(`/workspaces/${ws.workspace!.id}/automation/notifications/${n.id}`, { read: true })
        .then(onRead)
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.id]);
  return (
    <article className="ib-detail" aria-label={n.title}>
      <header className="ib-detail-head">
        <a href={areaHash("inbox")} className="icon-btn ws-back" aria-label="Back to the inbox">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ib-detail-titles">
          <h2>{n.title}</h2>
          <div className="cluster">
            <SourceBadge source="nexus" origin="workspace" />
            {n.count > 1 ? <span className="badge">{n.count} updates</span> : null}
          </div>
          <p className="xsmall subtle">{formatWhen(n.updated_at)}</p>
        </div>
        <div className="ib-detail-actions">
          {n.link && n.link.startsWith("#/") ? (
            <a className="btn btn-sm btn-primary" href={n.link}>
              Open
            </a>
          ) : null}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onMuteToggle}>
            {muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />} {muted ? "Unmute this kind" : "Mute this kind"}
          </button>
        </div>
      </header>
      {n.body ? (
        <section className="ib-card">
          <p className="ib-message-text">{n.body}</p>
        </section>
      ) : null}
    </article>
  );
}

function MeetingDetail({ entry, meeting }: { entry: InboxEntry; meeting: MeetingInput | undefined }) {
  const ref = entry.ref as { contactId: string | null };
  return (
    <article className="ib-detail" aria-label={entry.title}>
      <header className="ib-detail-head">
        <a href={areaHash("inbox")} className="icon-btn ws-back" aria-label="Back to the inbox">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ib-detail-titles">
          <h2>{entry.title}</h2>
          <div className="cluster">
            <SourceBadge source="nexus" origin="workspace" />
          </div>
          <p className="small">
            {meeting ? `The meeting ended ${formatWhen(meeting.end_at)} and isn't marked done yet. ` : ""}Add notes to the timeline or a follow-up task while it's fresh.
          </p>
        </div>
        <div className="ib-detail-actions">
          {ref.contactId ? (
            <a className="btn btn-sm btn-primary" href={areaHash("contacts", ref.contactId)}>
              <ContactIcon aria-hidden="true" /> Open contact
            </a>
          ) : null}
          <a className="btn btn-sm" href={areaHash("calendar")}>
            <CalendarClock aria-hidden="true" /> Calendar
          </a>
        </div>
      </header>
    </article>
  );
}

// --- the list ------------------------------------------------------------------------------------------------------

function Row({ e, active, people }: { e: InboxEntry; active: boolean; people: Map<string, string> }) {
  const Icon = ROW_ICON[e.kind] ?? InboxIcon;
  const iconCls = e.origin === "native" ? "native" : e.source === "gmail" ? "gmail" : e.source === "slack" ? "slack" : "";
  const assignee = e.assigneeId ? people.get(e.assigneeId) : null;
  return (
    <a data-nav-item href={entryHash(e)} className={`ib-row${active ? " active" : ""}${e.unread ? " unread" : ""}`} aria-current={active ? "page" : undefined}>
      <span className={`ib-row-icon ${iconCls}`} aria-hidden="true">
        <Icon />
      </span>
      <span className="ib-row-main">
        <span className="ib-row-top">
          <span className="ib-row-title">{e.title}</span>
          {e.groupCount && e.groupCount > 1 ? <span className="ib-group-count">+{e.groupCount - 1}</span> : null}
        </span>
        <span className="ib-row-preview">{e.preview}</span>
        <span className="ib-row-meta">
          <SourceBadge source={e.source} origin={e.origin} />
          {e.mock ? <MockBadge compact /> : null}
          {e.priority !== "normal" ? <PriorityBadge priority={e.priority} /> : null}
          {e.labels.slice(0, 3).map((l) => (
            <span key={l} className="badge">
              {l}
            </span>
          ))}
          {assignee ? (
            <span className="badge" title={`Assigned to ${assignee}`}>
              {initials(assignee)}
            </span>
          ) : null}
        </span>
      </span>
      <span className="ib-row-side">
        <time dateTime={new Date(e.at).toISOString()}>{e.at ? formatWhen(new Date(e.at).toISOString()) : ""}</time>
        {e.unread ? e.unreadCount > 1 ? <span className="ib-count">{e.unreadCount > 99 ? "99+" : e.unreadCount}</span> : <span className="ib-dot" aria-label="Unread" /> : null}
      </span>
    </a>
  );
}

function InboxPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const client = useClient();
  const rooms = useRoomSummaries(client);
  const [source, setSource] = useState<SourceFilter>("all");
  const [q, setQ] = useState("");
  const [unread, setUnread] = useState(false);
  const [mine, setMine] = useState(false);
  const [mentions, setMentions] = useState(false);
  const [showMuted, setShowMuted] = useState(false);
  const [group, setGroup] = useState(true);
  const [priority, setPriority] = useState("");
  const [record, setRecord] = useState<RecordRef | null>(null);
  const [searching, setSearching] = useState(false);
  const dq = useDebounced(q);
  const meId = ws.me?.user.id ?? null;

  const serverQuery = useMemo(() => {
    const query: Record<string, string | number | boolean> = { limit: 100, muted: showMuted ? "include" : "exclude" };
    if (source === "email") query.source = "gmail";
    if (source === "slack") query.source = "slack";
    if (source === "gohighlevel") query.source = "gohighlevel";
    if (source === "notifications") query.kind = "missed_call";
    if (unread) query.unread = true;
    if (dq) query.q = dq;
    if (mine) query.assignee = "me";
    if (priority) query.priority = priority;
    if (mentions) query.mentions = "me";
    return query;
  }, [source, unread, dq, mine, priority, mentions, showMuted]);
  const wantServer = source !== "chat";
  const items = useApiResource(
    (api, signal) => (wantServer ? api.list<ServerInboxItem>(`${base}/inbox`, serverQuery, signal) : Promise.resolve({ data: [], page: { limit: 0, next_cursor: null, total: 0 } } as Page<ServerInboxItem>)),
    [base, serverQuery, wantServer],
  );
  const mutes = useApiResource((api, signal) => api.list<Mute>(`${base}/inbox/mutes`, { limit: 200 }, signal), [base]);
  const connections = useApiResource((api, signal) => api.list<Connection>(`${base}/connections`, { limit: 50 }, signal), [base]);
  const notifications = useApiResource(
    (api, signal) => (ws.hasFeature("notifications") ? api.list<WorkspaceNotification>(`/workspaces/${ws.workspace!.id}/automation/notifications`, { limit: 50 }, signal) : Promise.resolve(null)),
    [ws.workspace?.id],
  );
  const [now] = useState(() => Date.now());
  const meetings = useApiResource(
    (api, signal) =>
      ws.hasFeature("crm")
        ? api.list<MeetingInput>(`${ws.crm}/events`, { from: new Date(now - 7 * 86_400_000).toISOString(), to: new Date(now).toISOString(), attending: "me", status: "scheduled", limit: 50 }, signal)
        : Promise.resolve(null),
    [ws.crm, now],
  );

  const mutedKeys = useMemo(() => new Set((mutes.data?.data ?? []).map((m) => m.group_key)), [mutes.data]);
  const all = useMemo(
    () =>
      mergeInbox(
        fromNativeRooms(
          rooms.map((r) => ({ roomId: r.roomId, name: r.name, preview: r.preview, lastTs: r.lastTs, unread: r.unread, highlight: r.highlight, membership: r.membership, missedCall: r.missedCall })),
          mutedKeys,
        ),
        fromServerItems(items.data?.data ?? []),
        fromNotifications(notifications.data?.data ?? [], mutedKeys),
        fromMeetings(meetings.data?.data ?? [], now),
      ),
    [rooms, items.data, notifications.data, meetings.data, mutedKeys, now],
  );
  const filtered = useMemo(
    () => filterEntries(all, { source, unread, q: dq, assignedTo: mine ? meId : null, priority: priority || undefined, showMuted }),
    [all, source, unread, dq, mine, meId, priority, showMuted],
  );
  const shown = useMemo(() => {
    const list = mentions ? filtered.filter((e) => e.source === "slack") : filtered;
    return groupEntries(list, group);
  }, [filtered, mentions, group]);
  const people = useMemo(() => new Map(ws.members.map((m) => [m.id, m.name])), [ws.members]);
  const selected = selectedKey(path);
  const current = selected ? all.find((e) => e.key === selected) : undefined;
  const conns = connections.data?.data ?? [];
  const hasGmail = conns.some((c) => c.provider === "gmail" && c.is_mine);
  const hasSlack = conns.some((c) => c.provider === "slack");
  const unreadCount = unreadTotal(filterEntries(all, { source: "all" }));

  const toggleMute = useCallback(
    async (key: string, label: string) => {
      const existing = (mutes.data?.data ?? []).find((m) => m.group_key === key);
      try {
        if (existing) {
          await ws.api.delete(`${base}/inbox/mutes/${existing.id}`);
          ui.toast({ kind: "info", title: "Unmuted", body: label });
        } else {
          await ws.api.post(`${base}/inbox/mutes`, { group_key: key, label: label.slice(0, 200) });
          ui.toast({ kind: "info", title: "Muted", body: `${label}. Show muted items with the “Muted” filter.` });
        }
        mutes.reload();
        items.reload();
      } catch (e) {
        ui.toast({ kind: "error", title: "Couldn't change that", body: describeError(e) });
      }
    },
    [mutes, items, ws.api, base, ui],
  );
  const onItemChanged = (i: ServerInboxItem) =>
    items.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === i.id ? { ...x, ...i, messages: undefined, drafts: undefined } : x)) } : p));

  const gmailSearch = async () => {
    setSearching(true);
    try {
      const found = await ws.api.get<ServerInboxItem[]>(`${base}/gmail/search`, { q: dq });
      ui.toast({ kind: "info", title: `Gmail found ${found.length} thread${found.length === 1 ? "" : "s"}`, body: found.length ? "They're now in your inbox." : undefined });
      items.reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Gmail search failed", body: describeError(e) });
    } finally {
      setSearching(false);
    }
  };

  let detail: ReactNode;
  if (!selected) {
    detail = (
      <EmptyState icon={InboxIcon} title="Select a conversation">
        Chats, email, Slack and HighLevel in one place. Each item shows where it came from.
      </EmptyState>
    );
  } else if (selected.startsWith("item:")) {
    detail = <ItemDetail key={selected} id={selected.slice(5)} muted={(k) => mutedKeys.has(k)} onMuteToggle={(k, l) => void toggleMute(k, l)} onChanged={onItemChanged} onOpenRecord={setRecord} />;
  } else if (!current) {
    detail = selected.startsWith("native:") && !rooms.length ? <LoadingState /> : (
      <EmptyState icon={InboxIcon} title="Not in the inbox right now">
        It may be muted, filtered out or gone. <a href={areaHash("inbox")}>Back to the inbox</a>
      </EmptyState>
    );
  } else if (current.ref.type === "room") {
    detail = <NativeDetail key={selected} entry={current} muted={mutedKeys.has(nativeGroupKey(current.ref.roomId))} onMuteToggle={() => void toggleMute(current.groupKey, current.title)} onOpenRecord={setRecord} />;
  } else if (current.ref.type === "notification") {
    const n = notifications.data?.data.find((x) => x.id === (current.ref as { id: string }).id);
    detail = n ? (
      <NotificationDetail
        key={n.id}
        n={n}
        muted={mutedKeys.has(current.groupKey)}
        onMuteToggle={() => void toggleMute(current.groupKey, current.groupLabel)}
        onRead={(u) => notifications.setData((p) => (p ? { ...p, data: p.data.map((x) => (x.id === u.id ? u : x)) } : p))}
      />
    ) : (
      <LoadingState />
    );
  } else {
    detail = <MeetingDetail entry={current} meeting={meetings.data?.data.find((m) => m.id === (current.ref as { id: string }).id)} />;
  }

  const loading = items.loading && !items.data;
  return (
    <div className="ws-split" data-detail={selected ? "open" : "closed"}>
      <section className="ws-list-pane" aria-label="Inbox">
        <header className="ws-list-header">
          <div className="cluster-between">
            <h1 className="ws-list-title">
              <InboxIcon aria-hidden="true" /> Inbox {unreadCount ? <span className="badge badge-accent">{unreadCount} unread</span> : null}
            </h1>
            <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => { items.reload(); notifications.reload(); mutes.reload(); }}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
          <div className="ws-search">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="inbox-q">
              Search the inbox
            </label>
            <input id="inbox-q" type="search" placeholder="Search subjects, senders, messages" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </div>
          <div className="ib-tabs" role="group" aria-label="Source">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" className="chip" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ws-filters" role="group" aria-label="Filters">
            <button type="button" className="chip" aria-pressed={unread} onClick={() => setUnread((v) => !v)}>
              Unread
            </button>
            <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
              Assigned to me
            </button>
            {hasSlack ? (
              <button type="button" className="chip" aria-pressed={mentions} onClick={() => setMentions((v) => !v)}>
                Mentions
              </button>
            ) : null}
            <label className="visually-hidden" htmlFor="inbox-priority">
              Priority
            </label>
            <select id="inbox-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">Any priority</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <button type="button" className="chip" aria-pressed={showMuted} onClick={() => setShowMuted((v) => !v)}>
              Muted
            </button>
            <button type="button" className="chip" aria-pressed={group} onClick={() => setGroup((v) => !v)} title="Collapse Slack channels and notifications into one row">
              Group
            </button>
          </div>
        </header>
        <div className="ws-list-scroll" onKeyDown={listKeys} aria-busy={loading ? "true" : undefined}>
          {all.some((e) => e.mock) ? (
            <p className="ib-mock-banner ib-list-note" role="note">
              <FlaskConical aria-hidden="true" /> <strong>{MOCK_LABEL}</strong> Items marked “Mock” are synthetic.
            </p>
          ) : null}
          {items.error ? <ErrorState error={items.error} onRetry={items.reload} compact /> : null}
          {loading ? <LoadingState /> : null}
          {(mine || priority) && source !== "chat" ? <p className="xsmall subtle ib-list-note">Assignment and priority apply to synced items only, so chats are hidden.</p> : null}
          {dq && hasGmail && (source === "all" || source === "email") ? (
            <div className="ib-list-note">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void gmailSearch()} disabled={searching}>
                {searching ? <Spinner size="sm" /> : <Mail aria-hidden="true" />} Search all of Gmail for “{dq}”
              </button>
            </div>
          ) : null}
          {!loading && shown.length === 0 ? (
            <EmptyState icon={InboxIcon} title={q || unread || mine || priority || source !== "all" ? "Nothing matches" : "You're all caught up"}>
              {q || unread || mine || priority || source !== "all" ? (
                "Try other filters."
              ) : conns.length === 0 ? (
                <>
                  Connect Gmail, Slack or HighLevel to bring them in here. <a href={areaHash("integrations")}>Integrations</a>
                </>
              ) : (
                "New messages and notifications show up here."
              )}
            </EmptyState>
          ) : null}
          <p className="visually-hidden" aria-live="polite">
            {shown.length} items
          </p>
          <ul className="ws-records">
            {shown.map((e) => (
              <li key={e.key}>
                <Row e={e} active={e.key === selected} people={people} />
              </li>
            ))}
          </ul>
          {conns.length === 0 && connections.data ? (
            <p className="xsmall subtle ib-list-note">
              <Plug aria-hidden="true" className="inline-icon" /> No integrations connected yet. <a href={areaHash("integrations")}>Connect one</a>
            </p>
          ) : null}
          <p className="xsmall subtle ib-list-note">
            <Lock aria-hidden="true" className="inline-icon" /> Chats are decrypted on this device and never sent to the workspace server. Badges show where every item came from:{" "}
            {Object.values(ORIGIN_LABEL).join(", ").toLowerCase()}.
          </p>
        </div>
      </section>
      <section className="ws-detail-pane" aria-label="Details">
        {detail}
      </section>
      {record ? <RecordDrawer record={record} onClose={() => setRecord(null)} /> : null}
    </div>
  );
}

function InboxArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <InboxPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "inbox",
  label: "Inbox",
  icon: InboxIcon,
  order: 20,
  status: "ready",
  feature: "integrations",
  mobile: true,
  summary: "One inbox for chats, email, Slack and HighLevel, linked to your contacts and deals.",
  component: InboxArea,
});
