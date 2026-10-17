/**
 * Building blocks of the AI assistant UI: the answer card (verified facts kept apart from AI
 * text, sources, proposals with Confirm/Cancel) and the inline "Ask AI" panel used on a
 * contact and next to a conversation.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { Bot, Check, CircleAlert, Database, ExternalLink, FlaskConical, Info, Link2, ShieldAlert, Sparkles, X } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { describeError } from "../api";
import { useWorkspace } from "../context";
import { areaHash } from "../define";
import { formatWhen } from "../ui";
import { ACTION_STATUS_LABEL, actionIsOpen, answerView, buildMessages, sourceHref } from "./logic";
import type { AssistantStatus, ChatAnswer, ChatContext, PendingAction, Turn } from "./types";

export function assistantBase(workspaceId: string): string {
  return `/workspaces/${workspaceId}/assistant`;
}

const statusCache = new Map<string, Promise<AssistantStatus>>();

/** The assistant status of the selected workspace (provider, settings, features). */
export function useAssistantStatus() {
  const ws = useWorkspace();
  const id = ws.workspace?.id ?? "";
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (ws.status !== "ready" || !id) return;
    let alive = true;
    const key = `${id}:${tick}`;
    if (!statusCache.has(key)) statusCache.set(key, ws.api.get<AssistantStatus>(`${assistantBase(id)}/status`));
    statusCache
      .get(key)!
      .then((s) => alive && setStatus(s))
      .catch((e: unknown) => {
        statusCache.delete(key);
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [ws.api, ws.status, id, tick]);
  const reload = useCallback(() => {
    statusCache.clear();
    setTick((t) => t + 1);
  }, []);
  return { status, error, reload };
}

export function useAsk() {
  const ws = useWorkspace();
  return useCallback(
    async (turns: Turn[], question: string, context: ChatContext): Promise<ChatAnswer> =>
      ws.api.post<ChatAnswer>(`${assistantBase(ws.workspace!.id)}/chat`, { messages: buildMessages(turns, question), context }),
    [ws.api, ws.workspace],
  );
}

export function ProviderBadge({ status }: { status: AssistantStatus | null }) {
  if (!status) return null;
  const p = status.provider;
  if (!p.configured) {
    return (
      <span className="badge badge-warning" title={p.problem}>
        <CircleAlert aria-hidden="true" /> No AI provider
      </span>
    );
  }
  return p.is_model ? (
    <span className="badge badge-accent" title={p.model ? `Model: ${p.model}` : undefined}>
      <Sparkles aria-hidden="true" /> {p.label}
    </span>
  ) : (
    <span className="badge badge-info">
      <FlaskConical aria-hidden="true" /> Development mode: no AI model connected
    </span>
  );
}

function ActionCard({ action, onChange }: { action: PendingAction; onChange: (a: PendingAction) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const open = actionIsOpen(action);
  const expired = action.status === "pending" && !open;
  const decide = async (what: "confirm" | "cancel") => {
    setBusy(what);
    try {
      const updated = await ws.api.post<PendingAction>(`${assistantBase(ws.workspace!.id)}/actions/${action.pending_action_id}/${what}`, {});
      onChange(updated);
      ui.toast(what === "confirm" ? { kind: "success", title: "Done", body: action.preview.title } : { kind: "info", title: "Canceled", body: "Nothing was changed." });
    } catch (e) {
      ui.toast({ kind: "error", title: what === "confirm" ? "Couldn't apply the change" : "Couldn't cancel", body: describeError(e) });
      try {
        onChange(await ws.api.get<PendingAction>(`${assistantBase(ws.workspace!.id)}/actions/${action.pending_action_id}`));
      } catch {
        /* keep the current state */
      }
    } finally {
      setBusy(null);
    }
  };
  const p = action.preview;
  return (
    <section className={`ai-action ai-action-${action.status}`} aria-label={`Proposed change: ${p.title}`}>
      <header className="ai-action-header">
        <span className="ai-kicker">Proposed change</span>
        <strong>{p.title}</strong>
        <span className={`badge ${action.status === "confirmed" ? "badge-success" : action.status === "failed" || expired ? "badge-warning" : ""}`}>
          {expired ? "Expired" : ACTION_STATUS_LABEL[action.status]}
        </span>
      </header>
      {p.changes?.length ? (
        <table className="ai-changes">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {p.changes.map((c) => (
              <tr key={c.label}>
                <th scope="row">{c.label}</th>
                <td>{c.before}</td>
                <td>{c.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {p.fields?.length ? (
        <dl className="ws-kv ai-fields">
          {p.fields.map((f) => (
            <div key={f.label} className="ai-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {p.note ? <p className="xsmall muted">{p.note}</p> : null}
      {open ? (
        <div className="cluster ai-action-buttons">
          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void decide("confirm")}>
            {busy === "confirm" ? <Spinner size="sm" /> : <Check aria-hidden="true" />} Confirm
          </button>
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void decide("cancel")}>
            {busy === "cancel" ? <Spinner size="sm" /> : <X aria-hidden="true" />} Cancel
          </button>
          <span className="xsmall subtle">Nothing changes until you confirm. Expires {formatWhen(action.expires_at)}.</span>
        </div>
      ) : expired ? (
        <p className="xsmall subtle">This proposal expired. Ask again if you still want the change.</p>
      ) : null}
    </section>
  );
}

export function AnswerCard({ answer, onActionChange, compact }: { answer: ChatAnswer; onActionChange: (a: PendingAction) => void; compact?: boolean }) {
  const v = answerView(answer);
  return (
    <div className={`ai-answer${compact ? " compact" : ""}`}>
      {v.modeLabel ? (
        <p className="ai-mode" role="note">
          <FlaskConical aria-hidden="true" /> {v.modeLabel}
        </p>
      ) : null}
      {v.facts.length ? (
        <section className="ai-facts" aria-label="Verified facts from records">
          <h3 className="ai-kicker">
            <Database aria-hidden="true" /> Verified facts from records
          </h3>
          {v.facts.map((f, i) => (
            <div key={`${f.title}-${i}`} className="ai-fact-group">
              {v.facts.length > 1 ? <p className="ai-fact-title">{f.title}</p> : null}
              <ul>
                {f.lines.map((line, j) => (
                  <li key={j}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
      {v.untrusted ? (
        <p className="ai-untrusted xsmall">
          <ShieldAlert aria-hidden="true" /> Some of these records came from outside your organisation (for example an email). They were treated as
          information only, never as instructions.
        </p>
      ) : null}
      {v.suggestion ? (
        <section className={v.suggestionIsAi ? "ai-suggestion" : "ai-dev-note"} aria-label={v.suggestionIsAi ? "AI suggestion" : "Assistant note"}>
          {v.suggestionIsAi ? (
            <h3 className="ai-kicker">
              <Bot aria-hidden="true" /> AI suggestion · check before acting
            </h3>
          ) : null}
          <p className="ai-text">{v.suggestion}</p>
        </section>
      ) : null}
      {v.actions.map((a) => (
        <ActionCard key={a.pending_action_id} action={a} onChange={onActionChange} />
      ))}
      {v.sources.length ? (
        <nav className="ai-sources" aria-label="Sources">
          <span className="ai-kicker">
            <Link2 aria-hidden="true" /> Sources
          </span>
          <ul className="cluster">
            {v.sources.map((s) => (
              <li key={`${s.type}:${s.id}`}>
                <a href={sourceHref(s)}>{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {v.failedTools.length ? <p className="xsmall subtle">Some records couldn't be read ({v.failedTools.join(", ")}).</p> : null}
    </div>
  );
}

/** Inline "Ask AI" with quick prompts; the answer appears in place. */
export function AskAiPanel({ context, prompts, title = "Ask AI" }: { context: ChatContext; prompts: string[]; title?: string }) {
  const ws = useWorkspace();
  const { status } = useAssistantStatus();
  const ask = useAsk();
  const uid = useId();
  const [turn, setTurn] = useState<Turn | null>(null);
  const [q, setQ] = useState("");
  if (!ws.hasFeature("assistant")) return null;
  const run = async (question: string) => {
    if (!question.trim()) return;
    const t: Turn = { id: `${Date.now()}`, question, context, answer: null, error: null, pending: true };
    setTurn(t);
    try {
      const answer = await ask([], question, context);
      setTurn({ ...t, answer, pending: false });
    } catch (e) {
      setTurn({ ...t, error: describeError(e), pending: false });
    }
  };
  const unavailable = status && !status.provider.configured;
  const continueHref = context.contact_id ? areaHash("assistant", "contact", context.contact_id) : areaHash("assistant");
  return (
    <section className="ai-ask" aria-labelledby={`${uid}-t`}>
      <header className="ai-ask-header">
        <h3 id={`${uid}-t`}>
          <Sparkles aria-hidden="true" /> {title}
        </h3>
        <ProviderBadge status={status} />
      </header>
      {unavailable ? (
        <p className="xsmall muted">
          <Info aria-hidden="true" className="inline-icon" /> {status!.provider.problem}
        </p>
      ) : (
        <>
          <div className="cluster ai-quick">
            {prompts.map((p) => (
              <button key={p} type="button" className="btn btn-sm" disabled={turn?.pending} onClick={() => void run(p)}>
                {p}
              </button>
            ))}
          </div>
          <form
            className="ws-inline-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void run(q);
              setQ("");
            }}
          >
            <label className="visually-hidden" htmlFor={`${uid}-q`}>
              Ask about this record
            </label>
            <input id={`${uid}-q`} type="text" value={q} maxLength={2000} placeholder="Ask about this record…" onChange={(e) => setQ(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={!q.trim() || turn?.pending}>
              Ask
            </button>
          </form>
        </>
      )}
      {turn ? (
        <div className="ai-ask-result" aria-live="polite">
          <p className="xsmall subtle">“{turn.question}”</p>
          {turn.pending ? <Spinner label="Reading your records…" /> : null}
          {turn.error ? (
            <p className="form-error" role="alert">
              {turn.error}
            </p>
          ) : null}
          {turn.answer ? (
            <AnswerCard
              compact
              answer={turn.answer}
              onActionChange={(a) => setTurn((t) => (t && t.answer ? { ...t, answer: { ...t.answer, actions: t.answer.actions.map((x) => (x.pending_action_id === a.pending_action_id ? a : x)) } } : t))}
            />
          ) : null}
          <a className="xsmall" href={continueHref}>
            Continue in the assistant <ExternalLink aria-hidden="true" className="inline-icon" />
          </a>
        </div>
      ) : null}
    </section>
  );
}
