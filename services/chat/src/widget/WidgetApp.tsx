/**
 * The call widget's UI: the web client's own call screen (same component, same CallSession),
 * inside the two contexts it expects. The widget has no crypto, dialogs or settings of its own:
 * verification and account security live in the native app.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { useActiveCall } from "../calls/store";
import type { AppConfig } from "../config";
import { CallScreen } from "../components/calls/CallScreen";
import { Spinner } from "../components/primitives/Spinner";
import { ToastRegion } from "../components/ToastRegion";
import { UiContext, type Toast, type UiContextValue } from "../components/UiContext";
import type { SecurityState } from "../hooks/security";
import { errorMessage } from "../lib/errors";
import { MatrixContext, type MatrixContextValue } from "../matrix/context";
import { watchCallState, type CallStateMessage } from "./callState";

/** The widget never sees the account's crypto state; nothing here is shown or acted on. */
const NO_SECURITY: SecurityState & { refresh: () => void } = {
  loading: false,
  error: null,
  crossSigningExists: false,
  crossSigningReady: false,
  thisDeviceVerified: false,
  keysInSecretStorage: false,
  secretStorageReady: false,
  backupInfo: null,
  backupActiveVersion: null,
  backupTrusted: false,
  backupKeyCached: false,
  sessionsRemaining: null,
  next: "unknown",
  refresh: () => undefined,
};

export function WidgetStatus({ title, detail, busy }: { title: string; detail?: string | null; busy?: boolean }) {
  return (
    <div className={`call-widget-status${busy ? " busy" : ""}`} role="status" aria-live="polite">
      {busy ? (
        <span className="call-widget-pulse" aria-hidden="true">
          <Spinner size="lg" />
        </span>
      ) : null}
      <p className="call-widget-title">{title}</p>
      {detail ? <p className="call-widget-detail">{detail}</p> : null}
    </div>
  );
}

export function WidgetApp({ client, config, onCallState }: { client: MatrixClient; config: AppConfig; onCallState: (m: CallStateMessage) => void }) {
  const active = useActiveCall();
  const [endedText, setEndedText] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    if (!active) return;
    return watchCallState(active, (m) => {
      onCallState(m);
      if (m.state === "ended") setEndedText(m.reason ?? "The call ended.");
    });
  }, [active, onCallState]);

  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id"> & { id?: string }) => {
      const id = t.id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setToasts((ts) => [...ts.filter((x) => x.id !== id), { ...t, id }].slice(-3));
      const ms = t.timeoutMs === undefined ? 6000 : t.timeoutMs;
      if (ms) setTimeout(() => dismissToast(id), ms);
      return id;
    },
    [dismissToast],
  );
  const ui = useMemo<UiContextValue>(
    () => ({
      openDialog: () => undefined,
      closeDialog: () => undefined,
      toast,
      dismissToast,
      reportError: (e: unknown, context: string) => void toast({ kind: "error", title: context, body: errorMessage(e) }),
      security: NO_SECURITY,
      verifyUser: async () => undefined,
      verifyOwnDevice: async () => undefined,
      openPanel: () => undefined,
    }),
    [toast, dismissToast],
  );
  const matrix = useMemo<MatrixContextValue>(() => ({ client, config, userId: client.getUserId()!, deviceId: client.getDeviceId()! }), [client, config]);

  return (
    <MatrixContext.Provider value={matrix}>
      <UiContext.Provider value={ui}>
        <main className="call-widget">
          {active ? <CallScreen session={active} embedded /> : <WidgetStatus title={endedText ? "Call ended" : "Joining the call…"} detail={endedText} busy={!endedText} />}
        </main>
        <ToastRegion toasts={toasts} onDismiss={dismissToast} />
      </UiContext.Provider>
    </MatrixContext.Provider>
  );
}
