/**
 * Reports: placeholder until a later step replaces this file with the real area
 * (keep the id "reports"; set status "ready" and a component). See ../registry.ts.
 */
import { ChartColumn } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "reports",
  label: "Reports",
  icon: ChartColumn,
  order: 110,
  status: "coming_soon",
  summary: "Pipeline, activity and team reports for managers.",
  capability: "records.view_all",
});
