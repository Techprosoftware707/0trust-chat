/**
 * Pure logic of the assistant UI (unit-tested in test/unit/assistant.test.ts): building the
 * request history, keeping verified facts apart from AI text, updating proposals, and
 * preparing "Save to record" payloads.
 */

import type { ActionStatus, ChatAnswer, ChatContext, ChatMessageCandidate, PendingAction, Source, Turn } from "./types";

export const MAX_HISTORY = 30;
export const MAX_CHARS = 8000;
export const DEV_LABEL = "Development mode: no AI model connected";

/** The `messages` array for POST /assistant/chat: earlier turns (question + answer text) and the new question. */
export function buildMessages(turns: Turn[], question: string): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of turns) {
    if (!t.answer || t.error) continue;
    out.push({ role: "user", content: t.question.slice(0, MAX_CHARS) });
    const text = t.answer.answer.trim() || "(answered with records only)";
    out.push({ role: "assistant", content: text.slice(0, MAX_CHARS) });
  }
  out.push({ role: "user", content: question.trim().slice(0, MAX_CHARS) });
  return out.slice(-MAX_HISTORY).filter((m, i, arr) => !(i === 0 && m.role === "assistant" && arr.length > 1));
}

export interface AnswerView {
  /** "Development mode: no AI model connected" or "" for a real model. */
  modeLabel: string;
  /** Lines produced by tools from records: never written by a model. */
  facts: { title: string; lines: string[]; sources: Source[] }[];
  /** The model's text (an AI suggestion) or, in development mode, the fixed sentence. */
  suggestion: string;
  suggestionIsAi: boolean;
  sources: Source[];
  actions: PendingAction[];
  untrusted: boolean;
  failedTools: string[];
}

export function answerView(a: ChatAnswer): AnswerView {
  const dev = !a.provider.is_model;
  let suggestion = a.answer.trim();
  if (dev && suggestion.startsWith(DEV_LABEL)) suggestion = suggestion.slice(DEV_LABEL.length).replace(/^[.\s]+/, "");
  return {
    modeLabel: dev ? a.mode_label || DEV_LABEL : "",
    facts: a.facts.filter((f) => f.lines.length).map((f) => ({ title: f.title, lines: f.lines, sources: f.sources })),
    suggestion,
    suggestionIsAi: !dev,
    sources: dedupeSources(a.sources),
    actions: a.actions,
    untrusted: a.untrusted_used,
    failedTools: a.tool_calls.filter((c) => !c.ok).map((c) => c.name),
  };
}

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.type}:${s.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A route inside the SPA for a source (strips the app origin so links stay in this tab). */
export function sourceHref(s: Source, origin: string = typeof window !== "undefined" ? window.location.origin : ""): string {
  if (origin && s.url.startsWith(origin + "/")) return s.url.slice(origin.length + 1) || "#/";
  const i = s.url.indexOf("#/");
  return i >= 0 ? s.url.slice(i) : s.url;
}

/** Replaces one proposal (by id) in all turns, e.g. after Confirm or Cancel. */
export function updateAction(turns: Turn[], updated: PendingAction): Turn[] {
  return turns.map((t) =>
    t.answer && t.answer.actions.some((a) => a.pending_action_id === updated.pending_action_id)
      ? { ...t, answer: { ...t.answer, actions: t.answer.actions.map((a) => (a.pending_action_id === updated.pending_action_id ? updated : a)) } }
      : t,
  );
}

export function actionIsOpen(a: PendingAction, now: number = Date.now()): boolean {
  return a.status === "pending" && new Date(a.expires_at).getTime() > now;
}

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  pending: "Waiting for your confirmation",
  confirmed: "Done",
  canceled: "Canceled, nothing changed",
  failed: "Couldn't be applied",
};

/** The context query string the assistant route carries, e.g. #/assistant/contact/<id>. */
export function contextFromPath(path: string[]): ChatContext {
  if (path[0] === "contact" && path[1]) return { contact_id: path[1] };
  if (path[0] === "deal" && path[1]) return { opportunity_id: path[1] };
  return {};
}

// --- Save to record ------------------------------------------------------------------------------

export const SAVE_MAX_MESSAGES = 50;
export const SAVE_MAX_TOTAL = 18000;

export interface SavePayload {
  room_id: string;
  contact_id?: string;
  opportunity_id?: string;
  messages: { event_id: string; sender: string; sent_at: string; text: string }[];
}

export function selectionProblem(selected: ChatMessageCandidate[]): string | null {
  if (!selected.length) return "Select at least one message.";
  if (selected.length > SAVE_MAX_MESSAGES) return `Select at most ${SAVE_MAX_MESSAGES} messages.`;
  const total = selected.reduce((n, m) => n + m.text.length, 0);
  if (total > SAVE_MAX_TOTAL) return "That's too much text for one note. Select fewer messages.";
  return null;
}

export function buildSavePayload(roomId: string, target: { type: "contact" | "opportunity"; id: string }, selected: ChatMessageCandidate[]): SavePayload {
  const messages = [...selected]
    .sort((a, b) => a.ts - b.ts)
    .map((m) => ({ event_id: m.eventId, sender: m.sender.slice(0, 255) || m.senderId, sent_at: new Date(m.ts).toISOString(), text: m.text.slice(0, 4000) }));
  return { room_id: roomId, ...(target.type === "contact" ? { contact_id: target.id } : { opportunity_id: target.id }), messages };
}

// --- Claude connector ------------------------------------------------------------------------------

export function connectorSteps(url: string): string[] {
  return [
    "In Claude, open Customize → Connectors and choose “Add custom connector”.",
    `Paste this URL: ${url}`,
    "Leave the OAuth client fields empty: Claude registers itself.",
    "Select Connect, sign in to this workspace's account and choose what Claude may do.",
  ];
}
