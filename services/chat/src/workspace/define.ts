/**
 * Area and room-panel definitions (types, defineArea, routing helpers). Kept apart from the
 * registry's discovery (./registry.ts) because area files import this module while the
 * registry imports the area files. See ./registry.ts for how to add an area.
 */

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { WorkspaceDetail } from "./types";

export interface AreaProps {
  /** Sub-path segments after `#/<id>/` (already URI-decoded). */
  path: string[];
}

export interface AreaDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Position in the navigation (lower first). Chat is 30. */
  order: number;
  status: "ready" | "coming_soon";
  /** One sentence: what the area does (shown on the coming-soon page and as a tooltip). */
  summary: string;
  /** The team that delivers it (coming-soon pages say so). */
  owner?: string;
  /** Workspace feature flag required (GET /api/v1/workspaces/<id> -> features). */
  feature?: string;
  /** Role capability required (-> capabilities), e.g. "records.view_all". */
  capability?: string;
  /** Shown in the phone bottom bar (the rest is under "More"). */
  mobile?: boolean;
  component?: ComponentType<AreaProps>;
}

export interface RoomPanelProps {
  roomId: string;
  onClose: () => void;
}

/** A side panel next to a conversation (opened from the room header). */
export interface RoomPanelDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  order: number;
  feature?: string;
  component: ComponentType<RoomPanelProps>;
}

/** Chat's own routes and panels. */
const RESERVED = new Set(["room", "dm", "chat", "oauth"]);
export const BUILTIN_PANELS = new Set(["info", "search", "calls"]);

export function defineArea(a: AreaDefinition): AreaDefinition {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(a.id) || RESERVED.has(a.id)) throw new Error(`invalid area id ${a.id}`);
  if (a.status === "ready" && !a.component) throw new Error(`area ${a.id} is ready but has no component`);
  return a;
}

export function defineRoomPanel(p: RoomPanelDefinition): RoomPanelDefinition {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(p.id) || BUILTIN_PANELS.has(p.id)) throw new Error(`invalid room panel id ${p.id}`);
  return p;
}


export const CHAT_AREA = { id: "chat", label: "Chat", order: 30, mobile: true } as const;

/**
 * Whether an area is listed for this workspace. Without workspace details yet (not
 * connected) every area is listed: each shows its own "connect" state.
 */
export function isAreaVisible(area: AreaDefinition, ws: WorkspaceDetail | null): boolean {
  if (!ws) return true;
  if (area.capability && !ws.capabilities[area.capability]) return false;
  // Coming-soon areas are listed even before their feature flag exists.
  if (area.status === "coming_soon") return true;
  return !area.feature || !!ws.features[area.feature];
}

export function isRoomPanelVisible(panel: RoomPanelDefinition, ws: WorkspaceDetail | null): boolean {
  return !!ws && (!panel.feature || !!ws.features[panel.feature]);
}

export type WorkspaceRoute = { kind: "chat" } | { kind: "area"; area: string; path: string[] };

/** `#/contacts/abc` -> {area: "contacts", path: ["abc"]}; chat routes -> {kind: "chat"}. */
export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const h = hash.replace(/^#/, "");
  if (!h || h === "/") return { kind: "chat" };
  const m = /^\/([a-z][a-z0-9-]*)(?:\/(.*))?$/.exec(h);
  if (!m || m[1] === "room" || m[1] === "dm" || m[1] === "chat") return { kind: "chat" };
  const path = (m[2] ?? "")
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
  return { kind: "area", area: m[1], path };
}

export function areaHash(id: string, ...path: string[]): string {
  return `#/${id}${path.length ? "/" + path.map(encodeURIComponent).join("/") : ""}`;
}
