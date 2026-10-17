/**
 * Integrations: placeholder until the integrations team replaces this file with the real area
 * (keep the id "integrations"; set status "ready" and a component). See ../registry.ts.
 */
import { Plug } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "integrations",
  label: "Integrations",
  icon: Plug,
  order: 120,
  status: "coming_soon",
  owner: "integrations team",
  summary: "Connect Gmail, GoHighLevel and Slack to your workspace.",
});
