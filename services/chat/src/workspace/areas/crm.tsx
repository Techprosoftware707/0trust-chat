/** CRM: every deal across pipelines in one table, with filters, and a detail panel
 * (stage history and timeline). */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Briefcase, History, Search } from "lucide-react";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import type { Activity, Opportunity, Pipeline } from "../types";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, PriorityBadge, UserLabel, formatMoney, formatWhen } from "../ui";
import { ActivityItem, listKeys } from "./contacts";

interface HistoryRow {
  id: string;
  from_name: string;
  to_name: string;
  changed_by: { name: string } | null;
  changed_at: string;
}

function DealDetail({ id }: { id: string }) {
  const { crm } = useWorkspace();
  const deal = useApiResource((api, signal) => api.get<Opportunity>(`${crm}/opportunities/${id}`, undefined, signal), [crm, id]);
  const history = useApiResource((api, signal) => api.list<HistoryRow>(`${crm}/opportunities/${id}/history`, undefined, signal), [crm, id]);
  const timeline = useApiResource((api, signal) => api.list<Activity>(`${crm}/activities`, { opportunity: id, limit: 50 }, signal), [crm, id]);
  if (deal.error) return <ErrorState error={deal.error} onRetry={deal.reload} />;
  const o = deal.data;
  if (!o) return <LoadingState />;
  return (
    <article className="ws-detail" aria-labelledby="deal-title">
      <header className="ws-detail-header">
        <a href={areaHash("crm")} className="icon-btn ws-back" aria-label="Back to deals">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ws-detail-titles">
          <h2 id="deal-title">{o.name}</h2>
          <p className="muted small">
            {o.stage.name} · {formatMoney(o.value, o.currency)} · <span className={`ws-status ws-status-${o.status}`}>{o.status === "open" ? "Open" : o.status === "won" ? "Won" : "Lost"}</span>
          </p>
          <div className="cluster ws-badges">
            <PriorityBadge priority={o.priority} />
            <DemoBadge show={o.is_demo} />
          </div>
        </div>
        <div className="ws-detail-actions">
          <a className="btn btn-sm" href={areaHash("pipelines", o.pipeline_id)}>
            Open board
          </a>
        </div>
      </header>
      <div className="ws-detail-grid">
        <div className="ws-detail-main">
          <section className="ws-section" aria-label="Timeline">
            <h3 className="ws-section-title">Timeline</h3>
            {timeline.data?.data.length ? (
              <ol className="ws-timeline">
                {timeline.data.data.map((a) => (
                  <ActivityItem key={a.id} a={a} showRecord />
                ))}
              </ol>
            ) : timeline.loading ? (
              <LoadingState />
            ) : (
              <p className="muted small">Nothing on the timeline yet.</p>
            )}
          </section>
        </div>
        <aside className="ws-detail-side" aria-label="Deal details">
          <dl className="ws-kv">
            <dt>Owner</dt>
            <dd>
              <UserLabel user={o.owner} fallback="No owner" />
            </dd>
            <dt>Contacts</dt>
            <dd>
              {o.contacts.length
                ? o.contacts.map((c, i) => (
                    <span key={c.id}>
                      {i ? ", " : ""}
                      <a href={areaHash("contacts", c.id)}>{c.display_name}</a>
                    </span>
                  ))
                : "—"}
            </dd>
            <dt>Expected close</dt>
            <dd>{o.expected_close_date ? formatWhen(o.expected_close_date, { time: false }) : "—"}</dd>
            <dt>Collaborators</dt>
            <dd>{o.collaborators.length ? o.collaborators.map((u) => u.name).join(", ") : "—"}</dd>
          </dl>
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
        </aside>
      </div>
    </article>
  );
}

function CrmPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("open");
  const [pipeline, setPipeline] = useState("");
  const [mine, setMine] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const pipelines = useApiResource((api, signal) => api.list<Pipeline>(`${ws.crm}/pipelines`, undefined, signal), [ws.crm]);
  const query = useMemo(() => ({ q: dq, status, pipeline, owner: mine ? "me" : "", limit: 100 }), [dq, status, pipeline, mine]);
  const res = useApiResource((api, signal) => api.list<Opportunity>(`${ws.crm}/opportunities`, query, signal), [ws.crm, query]);
  const names = new Map((pipelines.data?.data ?? []).map((p) => [p.id, p.name]));
  const selected = path[0] ?? null;
  return (
    <div className="ws-split wide-list" data-detail={selected ? "open" : "closed"}>
      <section className="ws-list-pane" aria-label="Deals">
        <header className="ws-list-header">
          <h1 className="ws-list-title">
            <Briefcase aria-hidden="true" /> Deals
          </h1>
          <div className="ws-search">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="deals-q">
              Search deals
            </label>
            <input id="deals-q" type="search" placeholder="Search deals" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="ws-filters" role="group" aria-label="Filters">
            <label className="visually-hidden" htmlFor="deals-status">
              Status
            </label>
            <select id="deals-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="">All</option>
            </select>
            <label className="visually-hidden" htmlFor="deals-pipeline">
              Pipeline
            </label>
            <select id="deals-pipeline" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
              <option value="">All pipelines</option>
              {(pipelines.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
              Mine
            </button>
          </div>
        </header>
        <div className="ws-list-scroll" onKeyDown={listKeys}>
          {res.error ? <ErrorState error={res.error} onRetry={res.reload} compact /> : null}
          {res.loading && !res.data ? <LoadingState /> : null}
          {res.data && res.data.data.length === 0 ? <EmptyState icon={Briefcase} title="No deals match" /> : null}
          <ul className="ws-records">
            {(res.data?.data ?? []).map((o) => (
              <li key={o.id}>
                <a data-nav-item href={areaHash("crm", o.id)} className={`ws-record${o.id === selected ? " active" : ""}`} aria-current={o.id === selected ? "page" : undefined}>
                  <span className="ws-record-main">
                    <span className="ws-record-top">
                      <span className="ws-row-title">{o.name}</span>
                      <span className="ws-record-value">{formatMoney(o.value, o.currency)}</span>
                    </span>
                    <span className="ws-row-meta">
                      {names.get(o.pipeline_id) ?? ""} · {o.stage.name}
                      {o.owner ? ` · ${o.owner.name}` : ""}
                      {o.expected_close_date ? ` · close ${formatWhen(o.expected_close_date, { time: false })}` : ""}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="ws-detail-pane" aria-label="Deal">
        {selected ? (
          <DealDetail key={selected} id={selected} />
        ) : (
          <EmptyState icon={Briefcase} title="Select a deal">
            See its stage history and timeline here.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function CrmArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <CrmPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "crm",
  label: "CRM",
  icon: Briefcase,
  order: 60,
  status: "ready",
  feature: "crm",
  summary: "Every deal across your pipelines, with its history.",
  component: CrmArea,
});
