/**
 * Route and feature registry of the workspace shell.
 *
 * Every navigation area (Home, Contacts, Inbox, ...) is ONE file in ./areas/ that exports
 * `area` (and optionally `roomPanel`). Files are discovered automatically, so a team adds or
 * replaces its own file and never edits the shell, the rail or other areas:
 *
 *   // src/workspace/areas/inbox.tsx
 *   import { defineArea } from "../define";
 *   export const area = defineArea({
 *     id: "inbox", label: "Inbox", icon: Inbox, order: 20, status: "ready",
 *     summary: "Email and messages from connected tools.", feature: "integrations",
 *     component: InboxPage,
 *   });
 *
 * Routing: `#/<id>` and `#/<id>/<sub/path>` open the area with `path` = the segments.
 * `#/`, `#/room/...` and `#/dm/...` stay the chat routes (unchanged).
 * Visibility: `feature` (workspace feature flag from the API) and `capability` (role
 * capability) hide an area; `status: "coming_soon"` areas are always listed and show a clear
 * "coming in this test build" state, never sample data. Hiding is UX only: the API enforces
 * everything.
 */

import type { AreaDefinition, RoomPanelDefinition } from "./define";

export * from "./define";

interface AreaModule {
  area?: AreaDefinition;
  roomPanel?: RoomPanelDefinition;
}

let cache: { areas: AreaDefinition[]; panels: RoomPanelDefinition[] } | null = null;

function load(): { areas: AreaDefinition[]; panels: RoomPanelDefinition[] } {
  if (cache) return cache;
  const modules = import.meta.glob<AreaModule>("./areas/*.tsx", { eager: true });
  const areas: AreaDefinition[] = [];
  const panels: RoomPanelDefinition[] = [];
  const ids = new Set<string>();
  for (const mod of Object.values(modules)) {
    if (mod.area) {
      if (ids.has(mod.area.id)) throw new Error(`duplicate area id ${mod.area.id}`);
      ids.add(mod.area.id);
      areas.push(mod.area);
    }
    if (mod.roomPanel) panels.push(mod.roomPanel);
  }
  areas.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  panels.sort((a, b) => a.order - b.order);
  cache = { areas, panels };
  return cache;
}

export function allAreas(): AreaDefinition[] {
  return load().areas;
}

export function allRoomPanels(): RoomPanelDefinition[] {
  return load().panels;
}

export function findArea(id: string): AreaDefinition | undefined {
  return load().areas.find((a) => a.id === id);
}

