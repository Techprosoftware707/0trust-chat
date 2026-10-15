/** Builders for outgoing message content (pure, unit-tested). */
import { RelationType } from "matrix-js-sdk";
import { hasFormatting, parseMessage, toHtml } from "../lib/markdown";

export interface TextContent {
  msgtype: "m.text";
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.relates_to"?: Record<string, unknown>;
  "m.new_content"?: Omit<TextContent, "m.relates_to" | "m.new_content">;
  "m.mentions"?: { user_ids?: string[] };
}

function formatted(body: string): Pick<TextContent, "format" | "formatted_body"> {
  const blocks = parseMessage(body);
  return hasFormatting(blocks) ? { format: "org.matrix.custom.html", formatted_body: toHtml(blocks) } : {};
}

/** A text message, optionally replying to `replyToEventId` (no reply fallback, per Matrix v1.13). */
export function textContent(body: string, replyToEventId?: string | null): TextContent {
  const content: TextContent = { msgtype: "m.text", body, ...formatted(body), "m.mentions": {} };
  if (replyToEventId) content["m.relates_to"] = { "m.in_reply_to": { event_id: replyToEventId } };
  return content;
}

/** An edit (m.replace) of `originalEventId`. */
export function editContent(originalEventId: string, newBody: string): TextContent {
  const inner = { msgtype: "m.text" as const, body: newBody, ...formatted(newBody), "m.mentions": {} };
  return {
    msgtype: "m.text",
    body: `* ${newBody}`,
    ...(inner.formatted_body ? { format: inner.format, formatted_body: `* ${inner.formatted_body}` } : {}),
    "m.new_content": inner,
    "m.mentions": {},
    "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
  };
}

export function reactionContent(eventId: string, key: string) {
  return { "m.relates_to": { rel_type: RelationType.Annotation as const, event_id: eventId, key } };
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];
