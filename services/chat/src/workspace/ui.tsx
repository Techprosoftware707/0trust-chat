/** Small building blocks shared by the workspace areas. */

import type { ReactNode } from "react";
import { Construction, LogIn, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Spinner } from "../components/primitives/Spinner";
import { describeError } from "./api";
import { useWorkspace } from "./context";
import type { AreaDefinition } from "./registry";
import type { Priority, UserRef } from "./types";

export function PageHeader({ title, subtitle, actions, icon: Icon }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <header className="ws-page-header">
      <div className="ws-page-titles">
        <h1>
          {Icon ? <Icon aria-hidden="true" className="ws-title-icon" /> : null}
          {title}
        </h1>
        {subtitle ? <p className="muted small">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ws-page-actions">{actions}</div> : null}
    </header>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="ws-state" aria-busy="true">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ws-state ws-empty">
      {Icon ? <Icon aria-hidden="true" /> : null}
      <p className="ws-state-title">{title}</p>
      {children ? <p className="muted small">{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`ws-state ws-error${compact ? " compact" : ""}`} role="alert">
      <TriangleAlert aria-hidden="true" />
      <p>{describeError(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Try again
        </button>
      ) : null}
    </div>
  );
}

/** What an area shows until the workspace connection is ready. */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  if (ws.status === "ready") return <>{children}</>;
  if (ws.status === "connecting") return <LoadingState label="Connecting to your workspace…" />;
  if (ws.status === "no-workspace") {
    return (
      <EmptyState icon={LogIn} title="You're not in a workspace yet">
        Create one or accept an invitation in the portal, then come back here.
      </EmptyState>
    );
  }
  return (
    <div className="ws-state ws-connect">
      <LogIn aria-hidden="true" />
      <p className="ws-state-title">Connect your workspace</p>
      <p className="muted small">
        Your business records come from your workspace account. Connecting signs you in with the same account you use for the portal; your
        conversations stay end-to-end encrypted either way.
      </p>
      {ws.error ? (
        <p className="form-error" role="alert">
          {ws.error}
        </p>
      ) : null}
      <button type="button" className="btn btn-primary" onClick={ws.connect}>
        <LogIn aria-hidden="true" /> Connect workspace
      </button>
    </div>
  );
}

export function ComingSoon({ area }: { area: AreaDefinition }) {
  const Icon = area.icon;
  return (
    <div className="ws-area-scroll">
      <PageHeader title={area.label} icon={Icon} />
      <div className="ws-coming-soon">
        <Construction aria-hidden="true" />
        <p className="ws-state-title">Coming in this test build</p>
        <p className="muted">{area.summary}</p>
        {area.owner ? <p className="xsmall subtle">Being built by the {area.owner}. Nothing here is shown until it works with real data.</p> : null}
      </div>
    </div>
  );
}

const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export function PriorityBadge({ priority, hideNormal = true }: { priority: Priority; hideNormal?: boolean }) {
  if (hideNormal && priority === "normal") return null;
  const cls = priority === "urgent" ? "badge-danger" : priority === "high" ? "badge-warning" : "";
  return <span className={`badge ${cls}`}>{PRIORITY_LABEL[priority]}</span>;
}

export const KIND_LABEL: Record<string, string> = {
  lead: "Lead",
  prospect: "Prospect",
  client: "Client",
  past_client: "Past client",
  partner: "Partner",
};

export const ROLE_LABEL: Record<string, string> = {
  buyer: "Buyer",
  seller: "Seller",
  landlord: "Landlord",
  tenant: "Tenant",
  investor: "Investor",
  borrower: "Borrower",
  co_borrower: "Co-borrower",
  referral_partner: "Referral partner",
  vendor: "Vendor",
  other: "Other",
};

export function KindBadge({ kind }: { kind: string }) {
  return <span className={`badge ws-kind ws-kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>;
}

export function DemoBadge({ show }: { show: boolean }) {
  return show ? (
    <span className="badge ws-demo" title="Synthetic demo record">
      Demo
    </span>
  ) : null;
}

export function UserLabel({ user, fallback = "Unassigned" }: { user: UserRef | null; fallback?: string }) {
  return user ? <span title={user.matrix_id}>{user.name}</span> : <span className="subtle">{fallback}</span>;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 15:00", "Tomorrow", "12 Oct", "3 Jan 2027". */
export function formatWhen(iso: string | null, { time = true, now = new Date() }: { time?: boolean; now?: Date } = {}): string {
  if (!iso) return "";
  const d = new Date(iso);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const t = time ? ` ${timeFmt.format(d)}` : "";
  if (sameDay(d, now)) return `Today${t}`;
  if (sameDay(d, tomorrow)) return `Tomorrow${t}`;
  if (sameDay(d, yesterday)) return `Yesterday${t}`;
  return (d.getFullYear() === now.getFullYear() ? dateFmt : dateYearFmt).format(d);
}

export function formatMoney(value: string | null, currency = "USD"): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** For <input type="datetime-local">: local "YYYY-MM-DDTHH:mm" <-> ISO. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
