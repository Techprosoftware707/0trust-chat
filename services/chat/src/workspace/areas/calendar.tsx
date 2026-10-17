/**
 * Calendar: placeholder until a later step replaces this file with the real area
 * (keep the id "calendar"; set status "ready" and a component). See ../registry.ts.
 */
import { CalendarDays } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "calendar",
  label: "Calendar",
  icon: CalendarDays,
  order: 90,
  status: "coming_soon",
  summary: "Your appointments, showings and closings next to tasks and follow-ups.",
});
