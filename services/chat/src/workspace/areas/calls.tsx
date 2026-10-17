/**
 * Calls & Meetings: placeholder until a later step replaces this file with the real area
 * (keep the id "calls"; set status "ready" and a component). See ../registry.ts.
 */
import { Video } from "lucide-react";
import { defineArea } from "../define";

export const area = defineArea({
  id: "calls",
  label: "Calls & Meetings",
  icon: Video,
  order: 40,
  status: "coming_soon",
  summary: "Scheduled meetings with end-to-end encrypted video calls, joined from the record they belong to.",
});
