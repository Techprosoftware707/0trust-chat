import { useEffect, useRef, useState } from "react";
import { CloudOff, RefreshCw, WifiOff } from "lucide-react";
import { SyncState } from "matrix-js-sdk";
import { useClient } from "../matrix/context";
import { useSyncState } from "../hooks/matrix";
import { useOnline } from "../hooks/useOnline";
import { errorMessage } from "../lib/errors";
import { Spinner } from "./primitives/Spinner";

/** Connection state from the real sync loop (plus navigator.onLine). */
export function ConnectionBanner() {
  const client = useClient();
  const { state, error } = useSyncState(client);
  const online = useOnline();
  const [announce, setAnnounce] = useState("");
  const wasBad = useRef(false);

  const bad = !online || state === SyncState.Reconnecting || state === SyncState.Error || state === SyncState.Stopped;
  useEffect(() => {
    if (bad) wasBad.current = true;
    else if (wasBad.current && (state === SyncState.Syncing || state === SyncState.Prepared)) {
      wasBad.current = false;
      setAnnounce("Connected again.");
      const t = setTimeout(() => setAnnounce(""), 4000);
      return () => clearTimeout(t);
    }
  }, [bad, state]);

  useEffect(() => {
    // When the browser comes back online, retry the sync immediately instead of waiting for back-off.
    if (online) client.retryImmediately();
  }, [online, client]);

  let content = null;
  if (!online) {
    content = (
      <div className="conn-banner conn-offline">
        <WifiOff aria-hidden="true" />
        <span>You're offline. New messages can't be sent until you reconnect.</span>
      </div>
    );
  } else if (state === SyncState.Reconnecting) {
    content = (
      <div className="conn-banner conn-warn">
        <Spinner size="sm" />
        <span>Reconnecting to the server…</span>
        <button type="button" className="btn btn-sm" onClick={() => client.retryImmediately()}>
          <RefreshCw aria-hidden="true" /> Retry now
        </button>
      </div>
    );
  } else if (state === SyncState.Error) {
    content = (
      <div className="conn-banner conn-error">
        <CloudOff aria-hidden="true" />
        <span>Connection problem: {errorMessage(error, "the server can't be reached")}</span>
        <button type="button" className="btn btn-sm" onClick={() => client.retryImmediately()}>
          <RefreshCw aria-hidden="true" /> Retry
        </button>
      </div>
    );
  } else if (state === SyncState.Stopped) {
    content = (
      <div className="conn-banner conn-error">
        <CloudOff aria-hidden="true" />
        <span>Syncing has stopped.</span>
        <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  } else if (state === SyncState.Catchup) {
    content = (
      <div className="conn-banner conn-info">
        <Spinner size="sm" />
        <span>Catching up on new messages…</span>
      </div>
    );
  }
  return (
    <div className="conn-region" role="status" aria-live="polite">
      {content}
      {!content && announce ? <span className="visually-hidden">{announce}</span> : null}
    </div>
  );
}
