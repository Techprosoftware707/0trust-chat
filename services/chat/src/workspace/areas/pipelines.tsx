/**
 * Pipelines: a kanban board per pipeline. Move deals by dragging, with the card's Move menu,
 * or from the keyboard (focus a card: Alt+←/→ changes stage, Alt+↑/↓ reorders). Managers
 * configure stages (rename, add, reorder, delete empty ones, won/lost).
 */

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Plus, Search, Settings2, SquareKanban, Trash2 } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Dialog } from "../../components/primitives/Dialog";
import { Menu } from "../../components/primitives/Menu";
import { Spinner } from "../../components/primitives/Spinner";
import { navigate } from "../../hooks/useRoute";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Board, BoardColumn, Contact, Opportunity, Page, Pipeline, Stage } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, PriorityBadge, formatMoney, formatWhen, initials } from "../ui";

function moveLocal(columns: BoardColumn[], oppId: string, stageId: string, index: number): BoardColumn[] {
  let moving: Opportunity | undefined;
  const without = columns.map((c) => {
    const found = c.opportunities.find((o) => o.id === oppId);
    if (found) moving = found;
    return found ? { ...c, opportunities: c.opportunities.filter((o) => o.id !== oppId), count: c.count - 1 } : c;
  });
  if (!moving) return columns;
  const moved = { ...moving, stage_id: stageId };
  return without.map((c) => {
    if (c.stage.id !== stageId) return c;
    const list = [...c.opportunities];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved);
    return { ...c, opportunities: list, count: c.count + 1 };
  });
}

function DealCard({
  o,
  columns,
  colIndex,
  index,
  onMove,
  dragging,
  setDragging,
}: {
  o: Opportunity;
  columns: BoardColumn[];
  colIndex: number;
  index: number;
  onMove: (o: Opportunity, stageId: string, index: number) => void;
  dragging: string | null;
  setDragging: (id: string | null) => void;
}) {
  const col = columns[colIndex];
  const canMove = o.permissions.change;
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!canMove || !e.altKey) return;
    if (e.key === "ArrowRight" && colIndex < columns.length - 1) onMove(o, columns[colIndex + 1].stage.id, columns[colIndex + 1].opportunities.length);
    else if (e.key === "ArrowLeft" && colIndex > 0) onMove(o, columns[colIndex - 1].stage.id, columns[colIndex - 1].opportunities.length);
    else if (e.key === "ArrowUp" && index > 0) onMove(o, col.stage.id, index - 1);
    else if (e.key === "ArrowDown" && index < col.opportunities.length - 1) onMove(o, col.stage.id, index + 1);
    else return;
    e.preventDefault();
  };
  return (
    <li
      className={`ws-deal${dragging === o.id ? " dragging" : ""}`}
      draggable={canMove}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-nexus-deal", o.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(o.id);
      }}
      onDragEnd={() => setDragging(null)}
      data-deal-id={o.id}
    >
      <div
        className="ws-deal-body"
        tabIndex={0}
        data-deal-focus={o.id}
        onKeyDown={onKey}
        aria-label={`${o.name}, ${col.stage.name}, ${formatMoney(o.value, o.currency)}${canMove ? ". Alt+arrow keys move it." : ""}`}
      >
        <div className="ws-deal-top">
          <span className="ws-deal-name">{o.name}</span>
          {canMove ? (
            <Menu
              label={`Move ${o.name}`}
              icon={<ArrowRight aria-hidden="true" />}
              buttonClassName="icon-btn icon-btn-sm"
              items={[
                ...columns
                  .filter((c) => c.stage.id !== col.stage.id)
                  .map((c) => ({ label: `Move to ${c.stage.name}`, onSelect: () => onMove(o, c.stage.id, c.opportunities.length) })),
                ...(index > 0 ? [{ label: "Move up", icon: <ArrowUp aria-hidden="true" />, onSelect: () => onMove(o, col.stage.id, index - 1) }] : []),
                ...(index < col.opportunities.length - 1
                  ? [{ label: "Move down", icon: <ArrowDown aria-hidden="true" />, onSelect: () => onMove(o, col.stage.id, index + 1) }]
                  : []),
              ]}
            />
          ) : null}
        </div>
        <div className="ws-deal-value">{formatMoney(o.value, o.currency)}</div>
        <div className="ws-deal-meta">
          {o.contacts[0] ? <a href={areaHash("contacts", o.contacts[0].id)}>{o.contacts[0].display_name}</a> : <span className="subtle">No contact</span>}
          {o.expected_close_date ? <span> · Close {formatWhen(o.expected_close_date, { time: false })}</span> : null}
        </div>
        <div className="ws-deal-foot">
          {o.owner ? (
            <span className="ws-avatar xs" title={`Owner: ${o.owner.name}`}>
              {initials(o.owner.name)}
            </span>
          ) : null}
          <PriorityBadge priority={o.priority} />
          <DemoBadge show={o.is_demo} />
        </div>
      </div>
    </li>
  );
}

function NewDealDialog({ pipeline, onClose, onCreated }: { pipeline: Pipeline; onClose: () => void; onCreated: (o: Opportunity) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [stageId, setStageId] = useState(pipeline.stages[0]?.id ?? "");
  const [contactQ, setContactQ] = useState("");
  const [contact, setContact] = useState<Contact | null>(null);
  const [matches, setMatches] = useState<Contact[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!contactQ.trim() || contact) {
      setMatches([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      ws.api
        .list<Contact>(`${ws.crm}/contacts`, { q: contactQ, limit: 6 }, ctrl.signal)
        .then((p) => setMatches(p.data))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [contactQ, contact, ws.api, ws.crm]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const o = await ws.api.post<Opportunity>(`${ws.crm}/opportunities`, {
        name,
        pipeline_id: pipeline.id,
        stage_id: stageId,
        value: value.trim() ? value.trim() : null,
        contact_ids: contact ? [contact.id] : [],
      });
      ui.toast({ kind: "success", title: "Deal created", body: o.name });
      onCreated(o);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "validation_error") setErrors(Object.fromEntries(Object.entries(e2.fields).map(([k, v]) => [k, v[0]])));
      else ui.toast({ kind: "error", title: "Couldn't create the deal", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="New deal" description={`In ${pipeline.name}`} onClose={onClose} dismissible={!busy}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${uid}-n`}>Name</label>
          <input id={`${uid}-n`} type="text" required value={name} maxLength={160} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? "true" : undefined} aria-describedby={errors.name ? `${uid}-ne` : undefined} autoFocus />
          {errors.name ? (
            <p className="form-error" id={`${uid}-ne`}>
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-v`}>Value ({pipeline.currency})</label>
          <input id={`${uid}-v`} type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={errors.value ? "true" : undefined} />
          {errors.value ? <p className="form-error">{errors.value}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-s`}>Stage</label>
          <select id={`${uid}-s`} value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {pipeline.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-c`}>Contact (optional)</label>
          {contact ? (
            <div className="cluster">
              <span className="badge badge-accent">{contact.display_name}</span>
              <button type="button" className="link-button small" onClick={() => setContact(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input id={`${uid}-c`} type="search" placeholder="Search contacts" value={contactQ} onChange={(e) => setContactQ(e.target.value)} autoComplete="off" />
              {matches.length ? (
                <ul className="ws-picker" aria-label="Matching contacts">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setContact(c)}>
                        {c.display_name}
                        {c.company ? <span className="subtle"> · {c.company}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size="sm" /> : <Plus aria-hidden="true" />} Create deal
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function StagesDialog({ pipeline, onClose, onChanged }: { pipeline: Pipeline; onClose: () => void; onChanged: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const [stages, setStages] = useState<Stage[]>(pipeline.stages);
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(pipeline.stages.map((s) => [s.id, s.name])));
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      ui.toast({ kind: "success", title: ok });
      onChanged();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't change the stages", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const reorder = (i: number, dir: -1 | 1) =>
    run(async () => {
      const next = [...stages];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      const p = await ws.api.post<Pipeline>(`${ws.crm}/pipelines/${pipeline.id}/stage-order`, { stage_ids: next.map((s) => s.id) });
      setStages(p.stages);
    }, "Stage order saved");
  return (
    <Dialog title={`Stages of ${pipeline.name}`} description="Rename, reorder, add or remove stages. Stages that still hold deals can't be removed." onClose={onClose} size="lg">
      <ol className="ws-stage-editor">
        {stages.map((s, i) => (
          <li key={s.id}>
            <label className="visually-hidden" htmlFor={`${uid}-${s.id}`}>
              Stage {i + 1} name
            </label>
            <input id={`${uid}-${s.id}`} type="text" value={names[s.id] ?? s.name} maxLength={80} onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))} />
            <label className="ws-chip-check">
              <input
                type="checkbox"
                checked={s.is_won}
                disabled={busy}
                onChange={() =>
                  run(async () => {
                    const u = await ws.api.patch<Stage>(`${ws.crm}/stages/${s.id}`, { is_won: !s.is_won, is_lost: false });
                    setStages((all) => all.map((x) => (x.id === u.id ? u : x)));
                  }, "Stage saved")
                }
              />{" "}
              Won
            </label>
            <label className="ws-chip-check">
              <input
                type="checkbox"
                checked={s.is_lost}
                disabled={busy}
                onChange={() =>
                  run(async () => {
                    const u = await ws.api.patch<Stage>(`${ws.crm}/stages/${s.id}`, { is_lost: !s.is_lost, is_won: false });
                    setStages((all) => all.map((x) => (x.id === u.id ? u : x)));
                  }, "Stage saved")
                }
              />{" "}
              Lost
            </label>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !(names[s.id] ?? "").trim() || names[s.id] === s.name}
              onClick={() =>
                run(async () => {
                  const u = await ws.api.patch<Stage>(`${ws.crm}/stages/${s.id}`, { name: names[s.id] });
                  setStages((all) => all.map((x) => (x.id === u.id ? u : x)));
                }, "Stage renamed")
              }
            >
              Rename
            </button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Move ${s.name} up`} disabled={busy || i === 0} onClick={() => void reorder(i, -1)}>
              <ArrowUp aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Move ${s.name} down`} disabled={busy || i === stages.length - 1} onClick={() => void reorder(i, 1)}>
              <ArrowDown aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-sm danger"
              aria-label={`Remove ${s.name}`}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await ws.api.delete(`${ws.crm}/stages/${s.id}`);
                  setStages((all) => all.filter((x) => x.id !== s.id));
                }, "Stage removed")
              }
            >
              <Trash2 aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <form
        className="ws-inline-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          void run(async () => {
            const st = await ws.api.post<Stage>(`${ws.crm}/pipelines/${pipeline.id}/stages`, { name: newName });
            setStages((all) => [...all, st]);
            setNames((n) => ({ ...n, [st.id]: st.name }));
            setNewName("");
          }, "Stage added");
        }}
      >
        <label className="visually-hidden" htmlFor={`${uid}-new`}>
          New stage name
        </label>
        <input id={`${uid}-new`} type="text" placeholder="New stage" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !newName.trim()}>
          <Plus aria-hidden="true" /> Add stage
        </button>
      </form>
    </Dialog>
  );
}

function BoardView({ pipeline, pipelines }: { pipeline: Pipeline; pipelines: Pipeline[] }) {
  const ws = useWorkspace();
  const ui = useUi();
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const board = useApiResource((api, signal) => api.get<Board>(`${ws.crm}/pipelines/${pipeline.id}/board`, { q: dq, owner: mine ? "me" : "" }, signal), [ws.crm, pipeline.id, dq, mine]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [dialog, setDialog] = useState<"new" | "stages" | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const columns = board.data?.columns ?? [];

  const move = async (o: Opportunity, stageId: string, index: number) => {
    if (!board.data) return;
    const before = board.data;
    const target = before.columns.find((c) => c.stage.id === stageId);
    board.setData({ ...before, columns: moveLocal(before.columns, o.id, stageId, index) });
    setAnnounce(`Moved ${o.name} to ${target?.stage.name}, position ${index + 1}.`);
    requestAnimationFrame(() => boardRef.current?.querySelector<HTMLElement>(`[data-deal-focus="${o.id}"]`)?.focus());
    try {
      const updated = await ws.api.post<Opportunity>(`${ws.crm}/opportunities/${o.id}/move`, { stage_id: stageId, index });
      board.setData((cur) =>
        cur ? { ...cur, columns: cur.columns.map((c) => ({ ...c, opportunities: c.opportunities.map((x) => (x.id === updated.id ? updated : x)) })) } : cur,
      );
      if (updated.status !== "open" && o.status === "open") ui.toast({ kind: "success", title: updated.status === "won" ? "Deal won" : "Deal marked lost", body: updated.name });
    } catch (e) {
      board.setData(before);
      setAnnounce(`Couldn't move ${o.name}.`);
      ui.toast({ kind: "error", title: "Couldn't move the deal", body: describeError(e) });
    }
  };

  const onDrop = (e: DragEvent<HTMLElement>, col: BoardColumn) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData("text/x-nexus-deal");
    const o = columns.flatMap((c) => c.opportunities).find((x) => x.id === id);
    if (!o) return;
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-deal-id]")).filter((el) => el.dataset.dealId !== id);
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    void move(o, col.stage.id, index);
  };

  return (
    <div className="ws-board-wrap">
      <header className="ws-page-header ws-board-header">
        <div className="ws-page-titles">
          <h1>
            <SquareKanban aria-hidden="true" className="ws-title-icon" />
            <label className="visually-hidden" htmlFor="pipeline-pick">
              Pipeline
            </label>
            <select id="pipeline-pick" className="ws-title-select" value={pipeline.id} onChange={(e) => navigate(areaHash("pipelines", e.target.value))}>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </h1>
          <p className="muted small">
            {board.data ? `${columns.reduce((n, c) => n + c.count, 0)} deals` : "Loading…"} · drag cards, or focus one and use Alt + arrow keys
          </p>
        </div>
        <div className="ws-page-actions">
          <div className="ws-search sm">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="board-q">
              Search deals
            </label>
            <input id="board-q" type="search" placeholder="Search deals" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
            Mine
          </button>
          {board.data?.can_configure ? (
            <button type="button" className="btn btn-sm" onClick={() => setDialog("stages")}>
              <Settings2 aria-hidden="true" /> Stages
            </button>
          ) : null}
          {board.data?.can_create ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog("new")}>
              <Plus aria-hidden="true" /> New deal
            </button>
          ) : null}
        </div>
      </header>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      {pipeline.kind === "lending" && ws.hasFeature("lending") ? (
        <p className="alert alert-info small vx-callout">
          Lending applications move through this pipeline's stages: open them in{" "}
          <a href={areaHash("lending")}>Lending</a>. Stage names here are steps of the process, never decisions.
        </p>
      ) : null}
      {board.error && !board.data ? <ErrorState error={board.error} onRetry={board.reload} /> : null}
      {!board.data && !board.error ? <LoadingState label="Loading the board…" /> : null}
      {board.data ? (
        <div className="ws-board" ref={boardRef} role="list" aria-label={`${pipeline.name} stages`}>
          {columns.map((col, ci) => (
            <section
              key={col.stage.id}
              role="listitem"
              className={`ws-column${dropTarget === col.stage.id ? " drop" : ""}${col.stage.is_won ? " won" : col.stage.is_lost ? " lost" : ""}`}
              aria-label={`${col.stage.name}: ${col.count} deals`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropTarget !== col.stage.id) setDropTarget(col.stage.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
              }}
              onDrop={(e) => onDrop(e, col)}
            >
              <header className="ws-column-header">
                <h2>{col.stage.name}</h2>
                <span className="ws-column-count">{col.count}</span>
                <span className="ws-column-total">{formatMoney(col.total_value, pipeline.currency)}</span>
              </header>
              <ul className="ws-column-list">
                {col.opportunities.map((o, i) => (
                  <DealCard key={o.id} o={o} columns={columns} colIndex={ci} index={i} onMove={move} dragging={dragging} setDragging={setDragging} />
                ))}
                {col.opportunities.length === 0 ? <li className="ws-column-empty">No deals</li> : null}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {dialog === "new" ? (
        <NewDealDialog
          pipeline={board.data?.pipeline ?? pipeline}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            board.reload();
          }}
        />
      ) : null}
      {dialog === "stages" ? <StagesDialog pipeline={board.data?.pipeline ?? pipeline} onClose={() => setDialog(null)} onChanged={() => board.reload()} /> : null}
    </div>
  );
}

function PipelinesPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const res = useApiResource((api, signal) => api.list<Pipeline>(`${ws.crm}/pipelines`, { limit: 100 }, signal), [ws.crm]);
  const pipelines = useMemo(() => (res.data as Page<Pipeline> | null)?.data ?? [], [res.data]);
  // Lending pipelines carry lending applications (the Lending area), not deals: open the
  // first deal pipeline unless a lending one is asked for by its ID (to edit its stages).
  const deals = pipelines.filter((p) => p.kind !== "lending" || !ws.hasFeature("lending"));
  const selected = pipelines.find((p) => p.id === path[0]) ?? deals.find((p) => p.is_default) ?? deals[0] ?? pipelines[0];
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <LoadingState />;
  if (!selected) {
    return (
      <EmptyState icon={SquareKanban} title="No pipelines yet">
        {ws.can("crm.configure") ? "Business profiles create a pipeline for you; managers can add more." : "A manager can set one up."}
      </EmptyState>
    );
  }
  return <BoardView key={selected.id} pipeline={selected} pipelines={pipelines} />;
}

function PipelinesArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <PipelinesPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "pipelines",
  label: "Pipelines",
  icon: SquareKanban,
  order: 70,
  status: "ready",
  feature: "crm",
  summary: "Deals by stage on a kanban board, per pipeline.",
  component: PipelinesArea,
});

