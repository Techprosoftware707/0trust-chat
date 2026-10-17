/**
 * Inbox: placeholder until the integrations team replaces this file with the real area
 * (keep the id "inbox"; set status "ready" and a component). See ../registry.ts.
 */
import { Inbox } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "inbox",
  label: "Inbox",
  icon: Inbox,
  order: 20,
  status: "coming_soon",
  owner: "integrations team",
  summary: "One inbox for email and messages from Gmail, GoHighLevel and Slack, linked to your contacts and deals.",
});
