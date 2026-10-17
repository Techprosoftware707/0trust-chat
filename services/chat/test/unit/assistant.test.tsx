import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_LABEL,
  actionIsOpen,
  answerView,
  buildMessages,
  buildSavePayload,
  connectorSteps,
  contextFromPath,
  dedupeSources,
  selectionProblem,
  sourceHref,
  updateAction,
} from "../../src/workspace/assistant/logic";
import type { ChatAnswer, ChatMessageCandidate, PendingAction, Turn } from "../../src/workspace/assistant/types";

const post = vi.fn();
const get = vi.fn();
const toast = vi.fn();

vi.mock("../../src/workspace/context", () => ({
  useWorkspace: () => ({
    api: { post, get },
    workspace: { id: "ws1", settings: { save_to_record_enabled: false } },
    status: "ready",
    crm: "/workspaces/ws1/crm",
    hasFeature: (f: string) => f !== "save_to_record",
    can: () => true,
  }),
  useApiResource: () => ({ data: null, error: null, loading: false, reload: () => undefined, setData: () => undefined }),
}));
vi.mock("../../src/components/UiContext", () => ({ useUi: () => ({ toast }) }));

const { AnswerCard } = await import("../../src/workspace/assistant/components");
const { textMessages } = await import("../../src/workspace/assistant/SaveToRecord");

const future = new Date(Date.now() + 5 * 60_000).toISOString();

function action(over: Partial<PendingAction> = {}): PendingAction {
  return {
    pending_action_id: "pa1",
    action: "create_task",
    status: "pending",
    preview: { kind: "create_task", title: "Create task “Call Pat”", fields: [{ label: "Title", value: "Call Pat" }] },
    expires_at: future,
    ...over,
  };
}

function answer(over: Partial<ChatAnswer> = {}): ChatAnswer {
  return {
    interaction_id: "i1",
    provider: { name: "dev", label: DEV_LABEL, model: "", is_model: false },
    mode_label: DEV_LABEL,
    answer: `${DEV_LABEL}. These are the records for your request; there is no AI-written summary in this mode.`,
    answer_kind: "development",
    facts: [{ tool: "get_contact_summary", title: "Contact summary", lines: ["Pat Example — lead, owner Avery."], sources: [] }],
    sources: [
      { type: "crm.contact", id: "c1", label: "Pat Example", url: "http://127.0.0.1:5713/#/contacts/c1" },
      { type: "crm.contact", id: "c1", label: "Pat Example", url: "http://127.0.0.1:5713/#/contacts/c1" },
    ],
    actions: [],
    tool_calls: [{ name: "get_contact_summary", ok: true, error_code: "" }],
    untrusted_used: false,
    stop: "end",
    ...over,
  };
}

function turn(q: string, a: ChatAnswer | null, error: string | null = null): Turn {
  return { id: q, question: q, context: {}, answer: a, error, pending: false };
}

afterEach(() => {
  post.mockReset();
  get.mockReset();
  toast.mockReset();
  document.body.innerHTML = "";
});

describe("assistant logic", () => {
  it("builds the request history from answered turns only", () => {
    const msgs = buildMessages([turn("first?", answer({ answer: "One." })), turn("broken?", null, "failed"), turn("second?", answer({ answer: "" }))], "third?");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(msgs[1].content).toBe("One.");
    expect(msgs[3].content).toBe("(answered with records only)");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "third?" });
    const many = Array.from({ length: 40 }, (_, i) => turn(`q${i}`, answer({ answer: `a${i}` })));
    const capped = buildMessages(many, "last");
    expect(capped.length).toBeLessThanOrEqual(30);
    expect(capped[0].role).toBe("user");
  });

  it("keeps verified facts apart from AI text and labels development mode", () => {
    const dev = answerView(answer());
    expect(dev.modeLabel).toBe(DEV_LABEL);
    expect(dev.suggestionIsAi).toBe(false);
    expect(dev.suggestion.startsWith(DEV_LABEL)).toBe(false);
    expect(dev.facts[0].lines[0]).toContain("Pat Example");
    expect(dev.sources).toHaveLength(1);
    const ai = answerView(answer({ provider: { name: "anthropic", label: "Claude (Anthropic API)", model: "m", is_model: true }, mode_label: "", answer: "Call Pat today.", answer_kind: "ai" }));
    expect(ai.modeLabel).toBe("");
    expect(ai.suggestionIsAi).toBe(true);
    expect(ai.suggestion).toBe("Call Pat today.");
  });

  it("links sources inside the app and dedupes them", () => {
    expect(sourceHref({ type: "crm.contact", id: "c1", label: "x", url: "http://127.0.0.1:5713/#/contacts/c1" }, "http://127.0.0.1:5713")).toBe("#/contacts/c1");
    expect(sourceHref({ type: "crm.contact", id: "c1", label: "x", url: "https://app.example.com/#/crm/o1" }, "http://other")).toBe("#/crm/o1");
    expect(dedupeSources(answer().sources)).toHaveLength(1);
  });

  it("updates one proposal everywhere and knows when it expired", () => {
    const turns = [turn("q", answer({ actions: [action()] }))];
    const next = updateAction(turns, action({ status: "confirmed" }));
    expect(next[0].answer!.actions[0].status).toBe("confirmed");
    expect(turns[0].answer!.actions[0].status).toBe("pending");
    expect(actionIsOpen(action())).toBe(true);
    expect(actionIsOpen(action({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
    expect(actionIsOpen(action({ status: "canceled" }))).toBe(false);
  });

  it("reads the context from the route", () => {
    expect(contextFromPath(["contact", "c9"])).toEqual({ contact_id: "c9" });
    expect(contextFromPath(["deal", "o1"])).toEqual({ opportunity_id: "o1" });
    expect(contextFromPath([])).toEqual({});
  });

  it("prepares Save to record payloads in time order and checks the selection", () => {
    const msgs: ChatMessageCandidate[] = [
      { eventId: "$b", sender: "Pat", senderId: "@pat:x", ts: 2000, text: "second" },
      { eventId: "$a", sender: "", senderId: "@me:x", ts: 1000, text: "first" },
    ];
    expect(selectionProblem([])).toMatch(/at least one/);
    expect(selectionProblem(msgs)).toBeNull();
    expect(selectionProblem([{ ...msgs[0], text: "x".repeat(19000) }])).toMatch(/too much/);
    const p = buildSavePayload("!r:x", { type: "contact", id: "c1" }, msgs);
    expect(p).toEqual({
      room_id: "!r:x",
      contact_id: "c1",
      messages: [
        { event_id: "$a", sender: "@me:x", sent_at: new Date(1000).toISOString(), text: "first" },
        { event_id: "$b", sender: "Pat", sent_at: new Date(2000).toISOString(), text: "second" },
      ],
    });
    expect(buildSavePayload("!r:x", { type: "opportunity", id: "o1" }, msgs).opportunity_id).toBe("o1");
  });

  it("explains how to add the connector in Claude", () => {
    const steps = connectorSteps("https://nexus.example.com/mcp");
    expect(steps.join(" ")).toContain("Add custom connector");
    expect(steps.join(" ")).toContain("https://nexus.example.com/mcp");
  });
});

describe("answer card", () => {
  it("shows the development label and verified facts, never an AI suggestion in dev mode", () => {
    const html = renderToStaticMarkup(<AnswerCard answer={answer({ untrusted_used: true })} onActionChange={() => undefined} />);
    expect(html).toContain(DEV_LABEL);
    expect(html).toContain("Verified facts from records");
    expect(html).not.toContain("AI suggestion");
    expect(html).toContain('href="#/contacts/c1"');
    expect(html).toContain("treated as information only");
  });

  it("labels model text as an AI suggestion, separate from the facts", () => {
    const html = renderToStaticMarkup(
      <AnswerCard answer={answer({ provider: { name: "anthropic", label: "Claude (Anthropic API)", model: "m", is_model: true }, mode_label: "", answer: "Call Pat today.", answer_kind: "ai" })} onActionChange={() => undefined} />,
    );
    expect(html).not.toContain(DEV_LABEL);
    expect(html).toContain("AI suggestion · check before acting");
    expect(html.indexOf("Verified facts from records")).toBeLessThan(html.indexOf("AI suggestion"));
  });

  it("offers Confirm and Cancel only for an open proposal", () => {
    const open = renderToStaticMarkup(<AnswerCard answer={answer({ actions: [action()] })} onActionChange={() => undefined} />);
    expect(open).toContain("Proposed change");
    expect(open).toContain("Confirm");
    expect(open).toContain("Nothing changes until you confirm");
    const done = renderToStaticMarkup(<AnswerCard answer={answer({ actions: [action({ status: "confirmed" })] })} onActionChange={() => undefined} />);
    expect(done).not.toContain(">Confirm<");
    expect(done).toContain("Done");
  });

  it("shows what happened after confirming, with a link to review a draft", () => {
    const html = renderToStaticMarkup(
      <AnswerCard
        answer={answer({
          actions: [
            action({
              action: "create_email_reply_draft",
              status: "confirmed",
              result: { message: "Nothing was sent. Review and send it in Nexus.", records: [{ type: "integrations.inboxitem", id: "t1", url: "http://127.0.0.1:5713/#/inbox/t1" }] },
            }),
          ],
        })}
        onActionChange={() => undefined}
      />,
    );
    expect(html).toContain("Review and send it in Nexus.");
    expect(html).toContain('href="#/inbox/t1"');
  });

  it("confirms through the API when the person clicks Confirm", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    post.mockResolvedValue(action({ status: "confirmed" }));
    const onChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AnswerCard answer={answer({ actions: [action()] })} onActionChange={onChange} />));
    const confirm = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirm"))!;
    await act(async () => confirm.click());
    expect(post).toHaveBeenCalledWith("/workspaces/ws1/assistant/actions/pa1/confirm", {});
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed" }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "success" }));
    act(() => root.unmount());
  });
});

describe("save to record message list", () => {
  function ev(o: { id: string; type?: string; body?: string; msgtype?: string; failed?: boolean; redacted?: boolean; sender?: string; ts?: number; rel?: string }) {
    return {
      getId: () => o.id,
      getType: () => o.type ?? "m.room.message",
      getRelation: () => (o.rel ? { rel_type: o.rel } : null),
      isRedacted: () => !!o.redacted,
      isDecryptionFailure: () => !!o.failed,
      getContent: () => ({ msgtype: o.msgtype ?? "m.text", body: o.body ?? "" }),
      getSender: () => o.sender ?? "@pat:x",
      getTs: () => o.ts ?? 1,
      replyEventId: undefined,
    };
  }

  it("lists only decrypted text messages this device can read", () => {
    const events = [
      ev({ id: "$1", body: "Hello", ts: 1 }),
      ev({ id: "$2", failed: true, type: "m.room.encrypted" }),
      ev({ id: "$3", body: "gone", redacted: true }),
      ev({ id: "$4", msgtype: "m.image", body: "photo.jpg" }),
      ev({ id: "$5", body: "edit", rel: "m.replace" }),
      ev({ id: "~local", body: "sending" }),
      ev({ id: "$6", body: "  ", ts: 6 }),
      ev({ id: "$7", body: "Can we meet?", ts: 7, sender: "@me:x" }),
    ];
    const room = {
      getLiveTimeline: () => ({ getEvents: () => events }),
      getMember: (id: string) => (id === "@pat:x" ? { name: "Pat Example" } : null),
    };
    const out = textMessages(room as never);
    expect(out.map((m) => m.eventId)).toEqual(["$1", "$7"]);
    expect(out[0]).toMatchObject({ sender: "Pat Example", text: "Hello" });
    expect(out[1].sender).toBe("@me:x");
    expect(textMessages(null)).toEqual([]);
  });
});
