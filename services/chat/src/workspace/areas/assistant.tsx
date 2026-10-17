/**
 * AI Assistant: a conversation about your business records. Answers keep "Verified facts
 * from records" (written by the tools, with links) apart from AI text, show the provider or
 * the development-mode label, and turn proposed changes into Confirm/Cancel cards. Nothing
 * changes without your click; the assistant never sees end-to-end encrypted chats.
 *
 * The conversation lives in this tab only (sessionStorage): the server keeps an audit entry
 * per question and, only if your workspace enabled retention, the text.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Lock, RotateCcw, Send, Sparkles } from "lucide-react";
import { Spinner } from "../../components/primitives/Spinner";
import { describeError } from "../api";
import { AnswerCard, ProviderBadge, useAsk, useAssistantStatus } from "../assistant/components";
import { contextFromPath, updateAction } from "../assistant/logic";
import type { ChatContext, Turn } from "../assistant/types";
import { ConnectionGate, EmptyState, ErrorState, LoadingState, PageHeader } from "../ui";
import { useApiResource, useWorkspace } from "../context";
import { defineArea, type AreaProps } from "../define";
import type { Contact } from "../types";

const STORE = "nexus-assistant-turns";
const SUGGESTIONS = [
  "What are my tasks?",
  "Prepare me for my next meeting",
  "Overdue follow-ups",
  "Leads not contacted in 14 days",
  "Pipeline overview",
  "Weekly summary",
];

function loadTurns(workspaceId: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(`${STORE}:${workspaceId}`);
    const turns = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(turns) ? turns.filter((t) => !t.pending).slice(-30) : [];
  } catch {
    return [];
  }
}

function saveTurns(workspaceId: string, turns: Turn[]) {
  try {
    sessionStorage.setItem(`${STORE}:${workspaceId}`, JSON.stringify(turns.slice(-30)));
  } catch {
    /* a convenience only */
  }
}

function ContextChip({ context, onClear }: { context: ChatContext; onClear: () => void }) {
  const ws = useWorkspace();
  const id = context.contact_id;
  const c = useApiResource((api, signal) => (id ? api.get<Contact>(`${ws.crm}/contacts/${id}`, undefined, signal) : Promise.resolve(null)), [id, ws.crm]);
  if (!id) return null;
  return (
    <p className="ai-context">
      About <strong>{c.data?.display_name ?? "this contact"}</strong>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClear}>
        Ask about anything
      </button>
    </p>
  );
}

function AssistantPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const wsId = ws.workspace?.id ?? "";
  const { status, error, reload } = useAssistantStatus();
  const ask = useAsk();
  const uid = useId();
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(wsId));
  const [q, setQ] = useState("");
  const [context, setContext] = useState<ChatContext>(() => contextFromPath(path));
  const endRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.pending);

  useEffect(() => setContext(contextFromPath(path)), [path]);
  useEffect(() => saveTurns(wsId, turns), [wsId, turns]);
  useEffect(() => endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" }), [turns.length, busy]);

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const turn: Turn = { id: `${Date.now()}-${turns.length}`, question: text, context, answer: null, error: null, pending: true };
    const history = turns;
    setTurns((t) => [...t, turn]);
    setQ("");
    try {
      const answer = await ask(history, text, context);
      setTurns((t) => t.map((x) => (x.id === turn.id ? { ...x, answer, pending: false } : x)));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === turn.id ? { ...x, error: describeError(e), pending: false } : x)));
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!status) return <LoadingState label="Starting the assistant…" />;
  const off = !status.features.assistant;
  const noProvider = !status.provider.configured;
  return (
    <div className="ws-area-scroll ai-page">
      <PageHeader
        icon={Sparkles}
        title="AI Assistant"
        subtitle="Ask about your contacts, deals, tasks and calendar. Answers come from records you're allowed to see."
        actions={
          <div className="cluster">
            <ProviderBadge status={status} />
            {turns.length ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTurns([])} disabled={busy}>
                <RotateCcw aria-hidden="true" /> New conversation
              </button>
            ) : null}
          </div>
        }
      />
      {off ? (
        <EmptyState icon={Sparkles} title="The assistant is turned off for this workspace">
          An owner or admin can turn it on in Settings → AI and connectors.
        </EmptyState>
      ) : noProvider ? (
        <EmptyState icon={Sparkles} title="No AI provider is connected">
          {status.provider.problem} The operator of this installation configures it (AI_PROVIDER). Connecting Claude as a connector doesn't give
          this app a model.
        </EmptyState>
      ) : (
        <div className="ai-chat">
          {turns.length === 0 ? (
            <div className="ai-welcome">
              <p className="ws-state-title">What would you like to know?</p>
              <p className="muted small">Try one of these, or ask in your own words.</p>
              <div className="cluster ai-quick">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="btn btn-sm" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="ai-turns" aria-label="Conversation">
              {turns.map((t) => (
                <li key={t.id} className="ai-turn">
                  <p className="ai-question">
                    <span className="visually-hidden">You asked: </span>
                    {t.question}
                  </p>
                  {t.pending ? <Spinner label="Reading your records…" /> : null}
                  {t.error ? (
                    <div className="alert alert-danger" role="alert">
                      <p>{t.error}</p>
                    </div>
                  ) : null}
                  {t.answer ? <AnswerCard answer={t.answer} onActionChange={(a) => setTurns((all) => updateAction(all, a))} /> : null}
                </li>
              ))}
            </ol>
          )}
          <div ref={endRef} />
          <form
            className="ai-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(q);
            }}
          >
            <ContextChip context={context} onClear={() => setContext({})} />
            <div className="ai-composer-row">
              <label className="visually-hidden" htmlFor={`${uid}-q`}>
                Your question
              </label>
              <textarea
                id={`${uid}-q`}
                rows={2}
                value={q}
                maxLength={8000}
                placeholder="Ask about your records…"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(q);
                  }
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={!q.trim() || busy} aria-label="Send question">
                {busy ? <Spinner size="sm" /> : <Send aria-hidden="true" />}
              </button>
            </div>
            <p className="xsmall subtle ai-privacy">
              <Lock aria-hidden="true" className="inline-icon" /> The assistant can't read your end-to-end encrypted chats, never sends emails or
              messages, and changes nothing until you confirm.
            </p>
          </form>
        </div>
      )}
    </div>
  );
}

function Keyed(props: AreaProps) {
  const ws = useWorkspace();
  // One conversation per workspace: switching workspace starts from that workspace's own.
  return <AssistantPage key={ws.workspace?.id ?? "none"} {...props} />;
}

function Gated(props: AreaProps) {
  return (
    <ConnectionGate>
      <Keyed {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "assistant",
  label: "AI Assistant",
  icon: Sparkles,
  order: 100,
  status: "ready",
  feature: "crm",
  summary: "Ask about your records; the assistant prepares tasks and notes for you to confirm. It never reads your end-to-end encrypted chats.",
  component: Gated,
});
