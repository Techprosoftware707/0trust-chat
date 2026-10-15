import { CircleAlert, CircleCheck, Info, ShieldCheck, X } from "lucide-react";
import type { Toast } from "./UiContext";

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <section className="toasts" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="toast-icon" aria-hidden="true">
            {t.kind === "error" ? <CircleAlert /> : t.kind === "success" ? <CircleCheck /> : t.kind === "verification" ? <ShieldCheck /> : <Info />}
          </span>
          <div className="toast-body">
            <p className="toast-title">{t.title}</p>
            {t.body ? <p className="toast-text">{t.body}</p> : null}
            {t.actions?.length ? (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button key={a.label} type="button" className={`btn btn-sm${a.primary ? " btn-primary" : ""}`} onClick={a.onClick}>
                    {a.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="icon-btn toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </section>
  );
}
