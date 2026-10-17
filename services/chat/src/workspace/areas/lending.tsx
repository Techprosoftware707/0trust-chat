/**
 * Lending: the application pipeline (Lead → … → Completed) and an application's page with
 * checklist progress, outstanding work, encrypted documents, internal notes, deadlines, and
 * the decision panel for authorised staff.
 *
 * Honesty rules shown in the UI: authorised staff make every decision (nothing approves or
 * rejects automatically, a stage is never a decision); "Request document" creates an
 * internal task — sending the request to the borrower isn't possible yet; uploaded files are
 * encrypted at rest but not virus-scanned in this build.
 */

import { useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowLeft, CircleAlert, ClipboardCheck, Download, FileLock2, History, Info, Landmark, Lock, MailX, Plus, Scale, Search, ShieldCheck, Trash2, Upload, UserRound,
} from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { navigate } from "../../hooks/useRoute";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Page } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, UserLabel, formatWhen } from "../ui";
import { CHECKLIST_STATUS_LABEL, checkUpload, checklistBadgeClass, fileTypeLabel, formatBytes, money } from "../verticals/logic";
import { downloadDocument, uploadDocument } from "../verticals/files";
import { Field, MilestonesSection, SearchPicker, fieldErrors, formatDay, useContactSearch } from "../verticals/shared";
import type {
  AccessLogRow, ApplicationNote, ChecklistItem, LendingApplication, LendingApplicationDetail, LendingBoard, SecureDocumentMeta,
} from "../verticals/types";

const PRODUCTS: [string, string][] = [
  ["purchase", "Purchase mortgage"], ["refinance", "Refinance"], ["cash_out_refinance", "Cash-out refinance"], ["home_equity", "Home equity"],
  ["construction", "Construction"], ["bridge", "Bridge loan"], ["commercial", "Commercial"], ["personal", "Personal loan"], ["other", "Other"],
];

export function StaffDecisionNote() {
  return (
    <p className="xsmall subtle">
      <Scale aria-hidden="true" className="inline-icon" /> Authorised staff make every lending decision. Nexus never approves or rejects anything, and
      moving an application between stages is not a decision.
    </p>
  );
}

export function ChecklistProgressBar({ app }: { app: Pick<LendingApplication, "checklist"> }) {
  const c = app.checklist;
  return (
    <span className="vx-progress" title={`${c.complete} of ${c.required} required documents accepted or waived`}>
      <span className="progress" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${c.percent}%` }} />
      </span>
      <span className="vx-progress-label">
        {c.complete}/{c.required} documents{c.awaiting_review ? ` · ${c.awaiting_review} to review` : ""}
      </span>
    </span>
  );
}

export function MissingBadge({ app }: { app: Pick<LendingApplication, "checklist"> }) {
  if (!app.checklist.outstanding) return <span className="badge badge-success">Documents complete</span>;
  return (
    <span className={`badge ${app.checklist.overdue ? "badge-danger" : "badge-warning"}`}>
      <CircleAlert aria-hidden="true" /> {app.checklist.outstanding} missing{app.checklist.overdue ? `, ${app.checklist.overdue} overdue` : ""}
    </span>
  );
}

function NewApplicationDialog({ onClose, onCreated, pipelineId }: { onClose: () => void; onCreated: (a: LendingApplicationDetail) => void; pipelineId?: string }) {
  const { api, crm, members, can } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [title, setTitle] = useState("");
  const [product, setProduct] = useState("purchase");
  const [amount, setAmount] = useState("");
  const [borrower, setBorrower] = useState<{ id: string; display_name: string } | null>(null);
  const [officer, setOfficer] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const search = useContactSearch();
  const managers = can("lending.sensitive");
  const brokers = members.filter((m) => ["owner", "admin", "manager", "agent"].includes(m.role));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const a = await api.post<LendingApplicationDetail>(`${crm}/lending/applications`, {
        title, product_type: product, amount_requested: amount.trim() || null, borrowers: borrower ? [{ contact_id: borrower.id, role: "borrower" }] : [],
        ...(pipelineId ? { pipeline_id: pipelineId } : {}), ...(managers && officer ? { loan_officer_id: officer } : {}),
      });
      ui.toast({ kind: "success", title: "Application created", body: `${a.reference} · checklist from the ${a.product_label.toLowerCase()} template` });
      onCreated(a);
    } catch (e2) {
      setErrors(fieldErrors(e2));
      if (!Object.keys(fieldErrors(e2)).length) ui.toast({ kind: "error", title: "Couldn't create the application", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="New lending application" onClose={onClose} dismissible={!busy}>
      <form className="form" onSubmit={submit} noValidate>
        <Field id={`${uid}-t`} label="Title" error={errors.title} hint="E.g. “Sample – first mortgage”.">
          <input id={`${uid}-t`} type="text" value={title} maxLength={160} autoFocus onChange={(e) => setTitle(e.target.value)} aria-invalid={errors.title ? "true" : undefined} />
        </Field>
        <SearchPicker id={`${uid}-b`} label="Borrower" placeholder="Search contacts" search={search} render={(c) => c.display_name}
          onPick={(c) => setBorrower({ id: c.id, display_name: c.display_name })} selected={borrower?.display_name} onClear={() => setBorrower(null)} />
        {errors.borrowers ? <p className="form-error">{errors.borrowers}</p> : null}
        <div className="vx-grid-2">
          <Field id={`${uid}-p`} label="Product">
            <select id={`${uid}-p`} value={product} onChange={(e) => setProduct(e.target.value)}>
              {PRODUCTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${uid}-a`} label="Amount requested (USD)" error={errors.amount_requested}>
            <input id={`${uid}-a`} type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        {managers ? (
          <Field id={`${uid}-o`} label="Broker / loan officer" error={errors.loan_officer_id} hint="Only they and owners, admins and managers will see the application.">
            <select id={`${uid}-o`} value={officer} onChange={(e) => setOfficer(e.target.value)}>
              <option value="">Me</option>
              {brokers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role_label})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="xsmall subtle">You'll be the broker. Only you and owners, admins and managers will see it.</p>
        )}
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? <Spinner size="sm" /> : <Plus aria-hidden="true" />} Create application
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// --- the application pipeline view -------------------------------------------------------------------

function AppCard({ a, onKeyMove, dragging, setDragging }: { a: LendingApplication; onKeyMove: (a: LendingApplication, dir: -1 | 1) => void; dragging: string | null; setDragging: (id: string | null) => void }) {
  const borrower = a.borrowers[0]?.display_name ?? (a.hidden_borrowers ? "A borrower you can't see" : "No borrower yet");
  return (
    <li className={`ws-deal vx-app-card${dragging === a.id ? " dragging" : ""}`} data-app-id={a.id} draggable={a.permissions.change}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-nexus-application", a.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(a.id);
      }}
      onDragEnd={() => setDragging(null)}>
      <a className="ws-deal-body" href={areaHash("lending", a.id)} data-app-focus={a.id}
        aria-label={`${a.reference} ${a.title}, ${a.checklist.outstanding} documents missing${a.permissions.change ? ". Alt plus arrow keys move it" : ""}`}
        onKeyDown={(e: KeyboardEvent) => {
          if (!a.permissions.change || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
          e.preventDefault();
          onKeyMove(a, e.key === "ArrowLeft" ? -1 : 1);
        }}>
        <span className="ws-deal-top">
          <span className="ws-deal-name">{a.title}</span>
          <span className="ws-deal-value">{money(a.amount_requested, a.currency)}</span>
        </span>
        <span className="ws-deal-meta">
          {a.reference} · {borrower}
        </span>
        <ChecklistProgressBar app={a} />
        <span className="ws-deal-foot">
          <MissingBadge app={a} />
          {a.decision ? <span className="badge badge-info">{a.decision === "approved" ? "Approved" : a.decision === "conditional" ? "Conditional" : "Declined"}</span> : null}
          <DemoBadge show={a.is_demo} />
        </span>
        <span className="ws-deal-meta">
          <UserRound aria-hidden="true" className="inline-icon" /> {a.loan_officer?.name ?? "No broker"}
        </span>
      </a>
    </li>
  );
}

function LendingBoardView() {
  const ws = useWorkspace();
  const ui = useUi();
  const [pipelineId, setPipelineId] = useState("");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const board = useApiResource((api, signal) => api.get<LendingBoard>(`${ws.crm}/lending/board`, { pipeline: pipelineId, officer: mine ? "me" : "" }, signal), [ws.crm, pipelineId, mine]);
  const [dialog, setDialog] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const boardRef = useRef<HTMLDivElement>(null);
  const columns = board.data?.columns ?? [];
  const filter = (a: LendingApplication) => !q.trim() || `${a.reference} ${a.title} ${a.borrowers.map((b) => b.display_name).join(" ")}`.toLowerCase().includes(q.toLowerCase());

  const move = async (a: LendingApplication, stageId: string) => {
    const before = board.data;
    if (!before || a.stage.id === stageId) return;
    const target = before.columns.find((c) => c.stage.id === stageId);
    board.setData({
      ...before,
      columns: before.columns.map((c) => ({
        ...c,
        applications: c.stage.id === stageId ? [...c.applications.filter((x) => x.id !== a.id), { ...a, stage: { ...a.stage, id: stageId, name: target?.stage.name ?? "" } }] : c.applications.filter((x) => x.id !== a.id),
        count: c.stage.id === stageId ? c.count + 1 : c.stage.id === a.stage.id ? c.count - 1 : c.count,
      })),
    });
    setAnnounce(`Moved ${a.reference} to ${target?.stage.name}.`);
    requestAnimationFrame(() => boardRef.current?.querySelector<HTMLElement>(`[data-app-focus="${a.id}"]`)?.focus());
    try {
      await ws.api.post(`${ws.crm}/lending/applications/${a.id}/move`, { stage_id: stageId });
    } catch (e) {
      board.setData(before);
      ui.toast({ kind: "error", title: "Couldn't move the application", body: describeError(e) });
    }
  };
  const keyMove = (a: LendingApplication, dir: -1 | 1) => {
    const i = columns.findIndex((c) => c.stage.id === a.stage.id);
    const next = columns[i + dir];
    if (next) void move(a, next.stage.id);
  };
  const onDrop = (e: DragEvent<HTMLElement>, stageId: string) => {
    e.preventDefault();
    setDrop(null);
    const id = e.dataTransfer.getData("text/x-nexus-application");
    const a = columns.flatMap((c) => c.applications).find((x) => x.id === id);
    if (a) void move(a, stageId);
  };
  const total = columns.reduce((n, c) => n + c.count, 0);
  const missing = columns.flatMap((c) => c.applications).filter((a) => a.checklist.outstanding > 0).length;
  return (
    <div className="ws-board-wrap">
      <header className="ws-page-header ws-board-header">
        <div className="ws-page-titles">
          <h1>
            <Landmark aria-hidden="true" className="ws-title-icon" /> Lending
            {board.data && board.data.pipelines.length > 1 ? (
              <>
                <label className="visually-hidden" htmlFor="lend-pipe">
                  Pipeline
                </label>
                <select id="lend-pipe" className="ws-title-select" value={board.data.pipeline?.id ?? ""} onChange={(e) => setPipelineId(e.target.value)}>
                  {board.data.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </h1>
          <p className="muted small">
            {board.data ? `${total} application${total === 1 ? "" : "s"}${missing ? ` · ${missing} missing documents` : ""}` : "Loading…"} · drag cards, or focus one and use Alt + arrow keys
          </p>
        </div>
        <div className="ws-page-actions">
          <div className="ws-search sm">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="lend-q">
              Filter applications
            </label>
            <input id="lend-q" type="search" placeholder="Filter applications" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
            Assigned to me
          </button>
          {board.data?.pipeline && board.data.can_configure ? (
            <a className="btn btn-sm" href={areaHash("pipelines", board.data.pipeline.id)}>
              Stages
            </a>
          ) : null}
          {board.data?.can_create ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog(true)}>
              <Plus aria-hidden="true" /> New application
            </button>
          ) : null}
        </div>
      </header>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <div className="vx-callout">
        <StaffDecisionNote />
      </div>
      {board.error && !board.data ? <ErrorState error={board.error} onRetry={board.reload} /> : null}
      {!board.data && !board.error ? <LoadingState label="Loading applications…" /> : null}
      {board.data && !board.data.pipeline ? <EmptyState icon={Landmark} title="No lending pipeline yet">Turning on the lending profile creates one.</EmptyState> : null}
      {board.data?.pipeline ? (
        <div className="ws-board" ref={boardRef} role="list" aria-label="Application stages">
          {columns.map((col) => {
            const apps = col.applications.filter(filter);
            return (
              <section key={col.stage.id} role="listitem" className={`ws-column${drop === col.stage.id ? " drop" : ""}${col.stage.is_won ? " won" : ""}`} aria-label={`${col.stage.name}: ${apps.length} applications`}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  if (drop !== col.stage.id) setDrop(col.stage.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
                }}
                onDrop={(e) => onDrop(e, col.stage.id)}>
                <header className="ws-column-header">
                  <h2>{col.stage.name}</h2>
                  <span className="ws-column-count">{apps.length}</span>
                </header>
                <ul className="ws-column-list">
                  {apps.map((a) => (
                    <AppCard key={a.id} a={a} onKeyMove={keyMove} dragging={dragging} setDragging={setDragging} />
                  ))}
                  {apps.length === 0 ? <li className="ws-column-empty">No applications</li> : null}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
      {dialog ? (
        <NewApplicationDialog pipelineId={board.data?.pipeline?.id} onClose={() => setDialog(false)} onCreated={(a) => { setDialog(false); navigate(areaHash("lending", a.id)); }} />
      ) : null}
    </div>
  );
}

// --- one application ---------------------------------------------------------------------------------

function DocumentRow({ doc, canDelete, onDeleted }: { doc: SecureDocumentMeta; canDelete: boolean; onDeleted: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  return (
    <li>
      <FileLock2 aria-hidden="true" className="inline-icon" />
      <strong>{doc.name}</strong>
      <span>
        {fileTypeLabel(doc.content_type)} · {formatBytes(doc.size)} · {doc.uploaded_by?.name ?? "someone"} · {formatWhen(doc.uploaded_at)}
      </span>
      <button type="button" className="btn btn-sm btn-ghost" disabled={busy} aria-label={`Download ${doc.name}`}
        onClick={async () => {
          setBusy(true);
          try {
            await downloadDocument(ws, ws.crm, doc);
          } catch (e) {
            ui.toast({ kind: "error", title: "Couldn't download the document", body: describeError(e) });
          } finally {
            setBusy(false);
          }
        }}>
        {busy ? <Spinner size="sm" /> : <Download aria-hidden="true" />} Download
      </button>
      {canDelete ? (
        <button type="button" className="icon-btn" aria-label={`Delete ${doc.name}`} title="Delete" disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Delete ${doc.name}? The encrypted file is removed.`)) return;
            try {
              await ws.api.delete(`${ws.crm}/lending/documents/${doc.id}`);
              ui.toast({ kind: "success", title: "Document deleted" });
              onDeleted();
            } catch (e) {
              ui.toast({ kind: "error", title: "Couldn't delete it", body: describeError(e) });
            }
          }}>
          <Trash2 aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

function UploadButton({ app, item, onUploaded, label = "Upload" }: { app: LendingApplicationDetail; item?: ChecklistItem; onUploaded: () => void; label?: string }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!app.storage_ready) return <span className="xsmall subtle">Uploads aren't set up on this server.</span>;
  return (
    <span className="vx-upload">
      <input ref={input} id={`${uid}-f`} type="file" accept={app.allowed_types.join(",")} tabIndex={-1} aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const problem = checkUpload(file, app.allowed_types, app.max_upload_bytes);
          if (problem) {
            ui.toast({ kind: "error", title: "That file can't be uploaded", body: problem });
            return;
          }
          setBusy(true);
          try {
            await uploadDocument(ws, ws.crm, app.id, file, item?.id);
            ui.toast({ kind: "success", title: "Document uploaded and encrypted", body: item ? `${item.name}: ready to review` : file.name });
            onUploaded();
          } catch (err) {
            ui.toast({ kind: "error", title: "Couldn't upload the document", body: describeError(err) });
          } finally {
            setBusy(false);
          }
        }} />
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()} aria-label={item ? `Upload a file for ${item.name}` : "Upload a document"}>
        {busy ? <Spinner size="sm" /> : <Upload aria-hidden="true" />} {label}
      </button>
    </span>
  );
}

function ChecklistRow({ app, item, onChanged }: { app: LendingApplicationDetail; item: ChecklistItem; onChanged: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const canChange = item.permissions.change;
  const setStatus = async (status: string) => {
    setBusy(true);
    try {
      await ws.api.patch(`${ws.crm}/lending/checklist/${item.id}`, { status });
      ui.toast({ kind: "success", title: `${item.name}: ${CHECKLIST_STATUS_LABEL[status as keyof typeof CHECKLIST_STATUS_LABEL].toLowerCase()}` });
      onChanged();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't update the item", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const request = async () => {
    setBusy(true);
    try {
      const r = await ws.api.post<{ notice: string }>(`${ws.crm}/lending/checklist/${item.id}/request`, {});
      ui.toast({ kind: "info", title: "Marked requested; task created", body: r.notice });
      onChanged();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't request it", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={item.outstanding ? "vx-outstanding" : ""}>
      <div className="ws-row-main">
        <span className="ws-row-title">
          {item.name} {!item.required ? <span className="subtle small">(optional)</span> : null}
        </span>
        <span className="ws-row-meta">
          <span className={`badge ${checklistBadgeClass(item.status)}`}>{CHECKLIST_STATUS_LABEL[item.status]}</span>{" "}
          <span className={item.overdue ? "ws-overdue" : ""}>{item.due_date ? `${item.overdue ? "Overdue · was due" : "Due"} ${formatDay(item.due_date)}` : ""}</span>
          {item.requested_by && item.status === "requested" ? ` · requested by ${item.requested_by.name}` : ""}
          {item.reviewed_by && ["accepted", "rejected", "waived"].includes(item.status) ? ` · ${item.status} by ${item.reviewed_by.name}` : ""}
        </span>
        {item.internal_note ? <span className="xsmall subtle">Internal: {item.internal_note}</span> : null}
      </div>
      {canChange ? (
        <div className="vx-item-actions">
          {["pending", "requested", "rejected"].includes(item.status) ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void request()} aria-label={`Request ${item.name}`}>
              <MailX aria-hidden="true" /> Request document
            </button>
          ) : null}
          <UploadButton app={app} item={item} onUploaded={onChanged} />
          <label className="visually-hidden" htmlFor={`${uid}-s`}>
            Review {item.name}
          </label>
          <select id={`${uid}-s`} value="" disabled={busy} onChange={(e) => e.target.value && void setStatus(e.target.value)}>
            <option value="">Review…</option>
            <option value="accepted">Accept</option>
            <option value="rejected">Reject (ask again)</option>
            <option value="waived">Waive</option>
            <option value="received">Mark received</option>
            <option value="pending">Reset</option>
          </select>
        </div>
      ) : null}
      {item.documents.length ? (
        <ul className="vx-docs" aria-label={`Documents for ${item.name}`}>
          {item.documents.map((d) => (
            <DocumentRow key={d.id} doc={d} canDelete={canChange} onDeleted={onChanged} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NotesSection({ app }: { app: LendingApplicationDetail }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const notes = useApiResource((a, signal) => a.list<ApplicationNote>(`${ws.crm}/lending/applications/${app.id}/notes`, undefined, signal), [ws.crm, app.id]);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState("staff");
  const [busy, setBusy] = useState(false);
  const managers = ws.can("lending.sensitive");
  return (
    <section className="ws-section" aria-labelledby={`${uid}-h`}>
      <header className="ws-section-header">
        <h3 id={`${uid}-h`}>
          <Lock aria-hidden="true" /> Internal notes
        </h3>
      </header>
      <p className="xsmall subtle">Never shown to the borrower. Only people with access to this application see staff notes.</p>
      {app.permissions.change ? (
        <form className="ws-add-activity"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const n = await ws.api.post<ApplicationNote>(`${ws.crm}/lending/applications/${app.id}/notes`, { body, visibility });
              notes.setData((p: Page<ApplicationNote> | null) => (p ? { ...p, data: [n, ...p.data] } : p));
              setBody("");
            } catch (e2) {
              ui.toast({ kind: "error", title: "Couldn't save the note", body: describeError(e2) });
            } finally {
              setBusy(false);
            }
          }}>
          <label className="visually-hidden" htmlFor={`${uid}-b`}>
            Note
          </label>
          <textarea id={`${uid}-b`} rows={2} placeholder="Add an internal note" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
          <div className="cluster">
            <label className="visually-hidden" htmlFor={`${uid}-v`}>
              Who can read it
            </label>
            <select id={`${uid}-v`} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="staff">Everyone on this application</option>
              {managers ? <option value="managers">Owners, admins, managers</option> : null}
              <option value="private">Only me (and managers)</option>
            </select>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !body.trim()}>
              Add note
            </button>
          </div>
        </form>
      ) : null}
      {notes.loading && !notes.data ? <LoadingState /> : null}
      {notes.data?.data.length === 0 ? <p className="muted small">No notes yet.</p> : null}
      <ul className="ws-list">
        {(notes.data?.data ?? []).map((n) => (
          <li key={n.id} className="vx-staff-note">
            <div className="ws-row-main">
              <span className="ws-tl-text">{n.body}</span>
              <span className="ws-row-meta">
                {n.author?.name ?? "Someone"} · {formatWhen(n.created_at)}
                {n.visibility !== "staff" ? <span className="badge">{n.visibility === "managers" ? "Managers only" : "Private"}</span> : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionPanel({ app, onChanged }: { app: LendingApplicationDetail; onChanged: (a: LendingApplicationDetail) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [decision, setDecision] = useState<string>(app.decision);
  const [note, setNote] = useState(app.decision_note);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="ws-side-block vx-decision">
      <h3>
        <Scale aria-hidden="true" /> Decision
      </h3>
      {app.decision ? (
        <p className="small">
          <span className="badge badge-info">{app.decision_label}</span> by {app.decision_by?.name ?? "staff"}, {formatWhen(app.decision_at)}
        </p>
      ) : (
        <p className="muted small">No decision recorded.</p>
      )}
      {app.permissions.decide ? (
        <form className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await ws.api.post<LendingApplicationDetail>(`${ws.crm}/lending/applications/${app.id}/decision`, { decision, note, confirm });
              ui.toast({ kind: "success", title: decision ? "Decision recorded" : "Decision cleared", body: r.decision_label });
              setConfirm(false);
              onChanged(r);
            } catch (e2) {
              ui.toast({ kind: "error", title: "Couldn't record the decision", body: describeError(e2) });
            } finally {
              setBusy(false);
            }
          }}>
          <label className="visually-hidden" htmlFor={`${uid}-d`}>
            Decision
          </label>
          <select id={`${uid}-d`} value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">No decision</option>
            <option value="approved">Approved</option>
            <option value="conditional">Approved with conditions</option>
            <option value="declined">Declined</option>
          </select>
          <label className="visually-hidden" htmlFor={`${uid}-n`}>
            Reason
          </label>
          <textarea id={`${uid}-n`} rows={2} placeholder="Reason (internal)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <label className="ws-chip-check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I made this decision as authorised staff
          </label>
          <button type="submit" className="btn btn-sm" disabled={busy || !confirm || decision === app.decision}>
            Record decision
          </button>
        </form>
      ) : (
        <p className="xsmall subtle">Owners, admins and managers record decisions.</p>
      )}
    </div>
  );
}

function AccessLog({ app }: { app: LendingApplicationDetail }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const log = useApiResource((a, signal) => (open ? a.list<AccessLogRow>(`${ws.crm}/lending/applications/${app.id}/access-log`, { limit: 100 }, signal) : Promise.resolve(null)), [ws.crm, app.id, open]);
  return (
    <div className="ws-side-block">
      <h3>
        <ShieldCheck aria-hidden="true" /> Document access log
      </h3>
      <button type="button" className="link-button small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show who uploaded and downloaded what"}
      </button>
      {open && log.data ? (
        log.data.data.length ? (
          <ol className="ws-history">
            {log.data.data.map((r) => (
              <li key={r.id}>
                <span>
                  {r.action_label}: {r.document_name || "a deleted document"}
                  {r.reason ? ` (${r.reason.replace(/_/g, " ")})` : ""}
                </span>
                <span className="xsmall subtle">
                  {r.user?.name ?? "someone"} · {formatWhen(r.at)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">Nothing yet.</p>
        )
      ) : null}
      {open && log.error ? <ErrorState error={log.error} compact /> : null}
    </div>
  );
}

function ApplicationDetailView({ id }: { id: string }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const res = useApiResource((a, signal) => a.get<LendingApplicationDetail>(`${ws.crm}/lending/applications/${id}`, undefined, signal), [ws.crm, id]);
  const history = useApiResource((a, signal) => a.list<{ id: string; from_name: string; to_name: string; changed_by: { name: string } | null; changed_at: string }>(`${ws.crm}/lending/applications/${id}/history`, undefined, signal), [ws.crm, id]);
  const reload = () => {
    res.reload();
    history.reload();
  };
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const a = res.data;
  if (!a) return <LoadingState label="Loading the application…" />;
  const moveTo = async (stageId: string) => {
    try {
      await ws.api.post(`${ws.crm}/lending/applications/${a.id}/move`, { stage_id: stageId });
      ui.toast({ kind: "success", title: "Stage changed", body: a.pipeline.stages.find((s) => s.id === stageId)?.name });
      reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't change the stage", body: describeError(e) });
    }
  };
  return (
    <div className="ws-area-scroll">
      <article className="ws-detail vx-app" aria-labelledby="app-title">
        <header className="ws-detail-header">
          <a href={areaHash("lending")} className="icon-btn" aria-label="Back to the application pipeline">
            <ArrowLeft aria-hidden="true" />
          </a>
          <div className="ws-detail-titles">
            <h2 id="app-title">{a.title}</h2>
            <p className="muted small">
              {a.reference} · {a.product_label} · {money(a.amount_requested, a.currency)}
              {a.target_close_date ? ` · target ${formatDay(a.target_close_date)}` : ""}
            </p>
            <div className="cluster ws-badges">
              <span className="badge badge-accent">{a.stage.name}</span>
              <MissingBadge app={a} />
              {a.status !== "active" ? <span className="badge">{a.status.replace("_", " ")}</span> : null}
              {a.decision ? <span className="badge badge-info">{a.decision_label}</span> : null}
              <span className="badge" title="Visible to owners, admins, managers and the assigned broker only">
                <Lock aria-hidden="true" /> Restricted
              </span>
              <DemoBadge show={a.is_demo} />
            </div>
          </div>
          <div className="ws-detail-actions">
            {a.permissions.change ? (
              <>
                <label className="visually-hidden" htmlFor={`${uid}-stage`}>
                  Stage
                </label>
                <select id={`${uid}-stage`} className="vx-stage-select" value={a.stage.id} onChange={(e) => void moveTo(e.target.value)}>
                  {a.pipeline.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
        </header>
        <div className="ws-detail-grid">
          <div className="ws-detail-main">
            <section className="ws-section" aria-labelledby={`${uid}-w`}>
              <header className="ws-section-header">
                <h3 id={`${uid}-w`}>
                  <ClipboardCheck aria-hidden="true" /> Outstanding work
                </h3>
                <ChecklistProgressBar app={a} />
              </header>
              {a.outstanding_work.length === 0 ? (
                <p className="muted small">Nothing outstanding.</p>
              ) : (
                <ul className="ws-list vx-work">
                  {a.outstanding_work.map((w) => (
                    <li key={`${w.kind}-${w.id}`}>
                      <span className={`badge ${w.kind === "missing_document" || w.kind === "rejected_document" ? "badge-warning" : w.kind === "review_document" ? "badge-info" : ""}`}>
                        {w.kind === "missing_document" ? "Missing" : w.kind === "rejected_document" ? "Rejected" : w.kind === "review_document" ? "To review" : w.kind === "milestone" ? "Deadline" : "Task"}
                      </span>
                      <span className="ws-row-main">
                        <span className="ws-row-title">{w.title}</span>
                      </span>
                      <span className={`xsmall ${w.overdue ? "ws-overdue" : "subtle"}`}>{w.due_date ? `${w.overdue ? "Overdue · " : ""}${formatDay(w.due_date)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ws-section" aria-labelledby={`${uid}-c`}>
              <header className="ws-section-header">
                <h3 id={`${uid}-c`}>
                  <FileLock2 aria-hidden="true" /> Document checklist
                </h3>
                {a.permissions.change ? <UploadButton app={a} onUploaded={reload} label="Upload other document" /> : null}
              </header>
              <div className="alert alert-info small">
                <Info aria-hidden="true" />
                <span>
                  “Request document” marks the item requested and creates a task for your team. Nexus can't send the request to the borrower yet: contact
                  them the usual way. Files are encrypted when stored but not virus-scanned in this build; only open files you expect.
                </span>
              </div>
              {a.checklist_items.length === 0 ? <p className="muted small">No checklist items. Add some, or apply a template.</p> : null}
              <ul className="ws-list vx-checklist">
                {a.checklist_items.map((it) => (
                  <ChecklistRow key={it.id} app={a} item={it} onChanged={reload} />
                ))}
              </ul>
              {a.other_documents.length ? (
                <>
                  <h4 className="ws-subhead">Other documents</h4>
                  <ul className="vx-docs">
                    {a.other_documents.map((d) => (
                      <DocumentRow key={d.id} doc={d} canDelete={a.permissions.change} onDeleted={reload} />
                    ))}
                  </ul>
                </>
              ) : null}
              {a.permissions.change ? <AddChecklistItem appId={a.id} onAdded={reload} /> : null}
            </section>

            <MilestonesSection milestones={a.milestones} parent={{ application_id: a.id }} canChange={a.permissions.change} templates={["lending"]} onChanged={reload} currency={a.currency} />
            <NotesSection app={a} />
          </div>
          <aside className="ws-detail-side" aria-label="Application details">
            <StaffDecisionNote />
            <dl className="ws-kv">
              <dt>Borrowers</dt>
              <dd>
                {a.borrowers.length
                  ? a.borrowers.map((b, i) => (
                      <span key={b.id}>
                        {i ? ", " : ""}
                        <a href={areaHash("contacts", b.id)}>{b.display_name}</a>
                        {b.role !== "borrower" ? ` (${b.role.replace("_", "-")})` : ""}
                      </span>
                    ))
                  : "—"}
                {a.hidden_borrowers ? <span className="subtle"> + {a.hidden_borrowers} you can't see</span> : null}
              </dd>
              <dt>Broker / loan officer</dt>
              <dd>
                <UserLabel user={a.loan_officer} fallback="Nobody" />
              </dd>
              {a.opportunity ? (
                <>
                  <dt>Deal</dt>
                  <dd>
                    <a href={areaHash("crm", a.opportunity.id)}>{a.opportunity.name}</a>
                  </dd>
                </>
              ) : null}
              {a.property ? (
                <>
                  <dt>Property</dt>
                  <dd>
                    <a href={areaHash("properties", a.property.id)}>{a.property.display_name}</a>
                  </dd>
                </>
              ) : null}
              <dt>In this stage since</dt>
              <dd>{formatWhen(a.stage_entered_at)}</dd>
            </dl>
            <DecisionPanel app={a} onChanged={(x) => res.setData(x)} />
            <div className="ws-side-block">
              <h3>
                <History aria-hidden="true" /> Stage history
              </h3>
              <ol className="ws-history">
                {(history.data?.data ?? []).map((h) => (
                  <li key={h.id}>
                    <span>{h.from_name ? `${h.from_name} → ${h.to_name}` : `Created in ${h.to_name}`}</span>
                    <span className="xsmall subtle">
                      {formatWhen(h.changed_at)}
                      {h.changed_by ? ` · ${h.changed_by.name}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            {a.permissions.view_access_log ? <AccessLog app={a} /> : null}
          </aside>
        </div>
      </article>
    </div>
  );
}

function AddChecklistItem({ appId, onAdded }: { appId: string; onAdded: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [name, setName] = useState("");
  const [required, setRequired] = useState(true);
  const [due, setDue] = useState("");
  return (
    <form className="ws-inline-fields"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await ws.api.post(`${ws.crm}/lending/applications/${appId}/checklist`, { name, required, due_date: due || null });
          setName("");
          setDue("");
          onAdded();
        } catch (e2) {
          ui.toast({ kind: "error", title: "Couldn't add the item", body: describeError(e2) });
        }
      }}>
      <label className="visually-hidden" htmlFor={`${uid}-n`}>
        New checklist item
      </label>
      <input id={`${uid}-n`} type="text" placeholder="Add a document to the checklist…" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
      <label className="visually-hidden" htmlFor={`${uid}-d`}>
        Due
      </label>
      <input id={`${uid}-d`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      <label className="ws-chip-check">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
      </label>
      <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
        <Plus aria-hidden="true" /> Add
      </button>
    </form>
  );
}

function LendingPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const id = path[0];
  if (!ws.can("lending.access")) return <EmptyState icon={Landmark} title="Lending isn't part of your role" />;
  return id ? <ApplicationDetailView key={id} id={id} /> : <LendingBoardView />;
}

function LendingArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <LendingPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "lending",
  label: "Lending",
  icon: Landmark,
  order: 74,
  status: "ready",
  feature: "lending",
  capability: "lending.access",
  summary: "Loan applications through your lending pipeline, with document checklists and encrypted documents.",
  component: LendingArea,
});
