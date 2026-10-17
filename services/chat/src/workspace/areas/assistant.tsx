/**
 * AI Assistant: placeholder until the AI team replaces this file with the real area
 * (keep the id "assistant"; set status "ready" and a component). See ../registry.ts.
 */
import { Sparkles } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "assistant",
  label: "AI Assistant",
  icon: Sparkles,
  order: 100,
  status: "coming_soon",
  owner: "AI team",
  summary: "An assistant that drafts follow-ups and suggests tasks from your business records. It never reads your end-to-end encrypted chats.",
});
