/**
 * The workspace shell around chat: a persistent navigation rail (desktop/tablet), a bottom
 * bar with "More" (phone), and the host that renders the active area. Areas come from the
 * registry; chat itself keeps its own layout untouched.
 */

import { useEffect, useRef, useState } from "react";
import { Ellipsis, Flag, MessagesSquare, X } from "lucide-react";
import type { AppEnvironment } from "../config";
import { BrandLogo } from "../components/BrandLogo";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useWorkspaceOptional } from "./context";
import { CHAT_AREA, allAreas, areaHash, findArea, isAreaVisible, type AreaDefinition } from "./registry";
import { ComingSoon, EmptyState } from "./ui";

export function envLabel(env: AppEnvironment): string {
  return env === "test" ? "Test" : env === "development" ? "Development" : "";
}

export function withEnvPrefix(title: string, env: AppEnvironment): string {
  const label = envLabel(env);
  return label ? `[${label}] ${title}` : title;
}

/** The persistent "Test environment · synthetic demo data" banner. */
export function EnvBanner({ env }: { env: AppEnvironment }) {
  const label = envLabel(env);
  if (!label) return null;
  return (
    <div className="env-banner" role="note" aria-label="Environment">
      <Flag aria-hidden="true" /> <strong>{label} environment</strong> · synthetic demo data
      <span className="env-banner-note">Don't enter real customer information.</span>
    </div>
  );
}

function useVisibleAreas(): AreaDefinition[] {
  const ws = useWorkspaceOptional();
  const detail = ws?.status === "ready" ? ws.workspace : null;
  return allAreas().filter((a) => isAreaVisible(a, detail));
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: AreaDefinition["icon"];
  soon: boolean;
  mobile: boolean;
  summary: string;
  badge?: number;
}

function navItems(areas: AreaDefinition[], unread: number): NavItem[] {
  const items: NavItem[] = areas.map((a) => ({
    id: a.id,
    label: a.label,
    href: areaHash(a.id),
    icon: a.icon,
    soon: a.status === "coming_soon",
    mobile: !!a.mobile,
    summary: a.summary,
  }));
  const chat: NavItem = { id: CHAT_AREA.id, label: CHAT_AREA.label, href: "#/", icon: MessagesSquare, soon: false, mobile: true, summary: "End-to-end encrypted conversations and calls.", badge: unread };
  const at = items.findIndex((i) => (findArea(i.id)?.order ?? 0) > CHAT_AREA.order);
  items.splice(at < 0 ? items.length : at, 0, chat);
  return items;
}

export function WorkspaceRail({ active, unread, brandName }: { active: string; unread: number; brandName: string }) {
  const items = navItems(useVisibleAreas(), unread);
  return (
    <nav className="ws-rail" aria-label="Workspace">
      <a className="ws-rail-brand" href="#/home" aria-label={`${brandName} home`}>
        <BrandLogo size={30} />
      </a>
      <ul className="ws-rail-list">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={it.href}
              className={`ws-rail-item${active === it.id ? " active" : ""}${it.soon ? " soon" : ""}`}
              aria-current={active === it.id ? "page" : undefined}
              title={it.soon ? `${it.label}: coming in this test build` : it.summary}
            >
              <it.icon aria-hidden="true" />
              <span className="ws-rail-label">{it.label}</span>
              {it.badge ? (
                <span className="ws-rail-badge" aria-label={`${it.badge} unread`}>
                  {it.badge > 99 ? "99+" : it.badge}
                </span>
              ) : null}
              {it.soon ? <span className="visually-hidden"> (coming soon)</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BottomNav({ active, unread }: { active: string; unread: number }) {
  const items = navItems(useVisibleAreas(), unread);
  const primary = items.filter((i) => i.mobile).slice(0, 4);
  const rest = items.filter((i) => !primary.includes(i));
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    sheet.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => setOpen(false), [active]);
  const moreActive = rest.some((i) => i.id === active);
  return (
    <>
      <nav className="ws-bottom" aria-label="Workspace">
        {primary.map((it) => (
          <a key={it.id} href={it.href} className={`ws-bottom-item${active === it.id ? " active" : ""}`} aria-current={active === it.id ? "page" : undefined}>
            <it.icon aria-hidden="true" />
            <span>{it.label}</span>
            {it.badge ? <span className="ws-rail-badge">{it.badge > 99 ? "99+" : it.badge}</span> : null}
          </a>
        ))}
        <button type="button" className={`ws-bottom-item${moreActive ? " active" : ""}`} aria-expanded={open} aria-controls="ws-more" onClick={() => setOpen((o) => !o)}>
          <Ellipsis aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
      {open ? (
        <div className="ws-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="ws-sheet" id="ws-more" ref={sheet} role="dialog" aria-modal="true" aria-label="All areas">
            <header className="ws-sheet-header">
              <h2>All areas</h2>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
                <X aria-hidden="true" />
              </button>
            </header>
            <ul className="ws-sheet-list">
              {rest.map((it) => (
                <li key={it.id}>
                  <a href={it.href} className={active === it.id ? "active" : ""} aria-current={active === it.id ? "page" : undefined}>
                    <it.icon aria-hidden="true" />
                    <span>
                      {it.label}
                      {it.soon ? <span className="badge">Soon</span> : null}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AreaHost({ id, path }: { id: string; path: string[] }) {
  const ws = useWorkspaceOptional();
  const area = findArea(id);
  const visible = useVisibleAreas();
  const titleRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // After navigating to another area, move focus to its heading (keyboard and
    // screen-reader users land at the top of the new page, not on the old link).
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const h = titleRef.current?.querySelector<HTMLElement>("h1");
      if (h && !titleRef.current?.contains(document.activeElement)) {
        h.setAttribute("tabindex", "-1");
        h.focus({ preventScroll: true });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [id]);
  if (!area) {
    return (
      <EmptyState title="This page doesn't exist">
        <a href="#/home">Go to Home</a>
      </EmptyState>
    );
  }
  if (!visible.includes(area)) {
    return (
      <EmptyState icon={area.icon} title={`${area.label} isn't available here`}>
        {ws?.workspace ? `It isn't enabled for ${ws.workspace.name}, or your role doesn't include it.` : "It isn't enabled for this workspace."}
      </EmptyState>
    );
  }
  const Component = area.component;
  return (
    <div className="ws-area" ref={titleRef} data-area={area.id}>
      <ErrorBoundary compact key={area.id}>
        {area.status === "coming_soon" || !Component ? <ComingSoon area={area} /> : <Component path={path} />}
      </ErrorBoundary>
    </div>
  );
}
