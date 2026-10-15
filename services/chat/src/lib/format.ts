/** Formatting helpers for timestamps, days and sizes (locale-aware, pure). */

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function formatTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ts);
}

export function formatFullDate(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(ts);
}

/** "Today", "Yesterday", a weekday within the last week, else a date. */
export function formatDayLabel(ts: number, now: number = Date.now(), locale?: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(ts);
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ts);
}

/** Compact timestamp for the room list: time today, weekday this week, else date. */
export function formatListTimestamp(ts: number, now: number = Date.now(), locale?: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days === 0) return formatTime(ts, locale);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(ts);
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }) }).format(ts);
}

export function formatRelative(ts: number | undefined | null, now: number = Date.now()): string {
  if (!ts) return "Unknown";
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  if (diff < min) return "Just now";
  if (diff < 60 * min) {
    const m = Math.floor(diff / min);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY_MS) {
    const h = Math.floor(diff / (60 * min));
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / DAY_MS);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(ts);
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[u]}`;
}

/** Initial(s) for an avatar placeholder. */
export function initials(name: string): string {
  const cleaned = name.replace(/^[@#!+]/, "").trim();
  const first = [...cleaned][0];
  return first ? first.toUpperCase() : "?";
}
