import { LoaderCircle } from "lucide-react";

export function Spinner({ label, size = "md" }: { label?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`spinner spinner-${size}`} role={label ? "status" : undefined}>
      <LoaderCircle aria-hidden="true" className="spin" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
