import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** If false, Escape / backdrop / close button are disabled (e.g. while an operation runs). */
  dismissible?: boolean;
  icon?: ReactNode;
  className?: string;
}

/**
 * Modal dialog on the native <dialog> element: focus is trapped and restored
 * by the browser, Escape closes it, and it renders in the top layer.
 */
export function Dialog({ title, description, onClose, children, size = "md", dismissible = true, icon, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // The browser focuses the first focusable element (the close button) unless a field
    // asked for autofocus; start on the panel instead so screen readers read the title first.
    if (d && document.activeElement?.classList.contains("dialog-close")) panelRef.current?.focus();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissRef.current) onClose();
      }}
      onMouseDown={(e) => {
        // click on the backdrop (outside the panel) closes
        if (e.target === ref.current && dismissRef.current) onClose();
      }}
    >
      <div className="dialog-panel" ref={panelRef} tabIndex={-1}>
        <header className="dialog-header">
          {icon ? <div className="dialog-icon" aria-hidden="true">{icon}</div> : null}
          <div className="dialog-titles">
            <h2 id={titleId}>{title}</h2>
            {description ? (
              <p id={descId} className="dialog-description">
                {description}
              </p>
            ) : null}
          </div>
          {dismissible ? (
            <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Close">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </dialog>
  );
}
