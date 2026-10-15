import { useId, useState } from "react";
import { CircleCheck, KeyRound, TriangleAlert } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { verifyWithRecoveryKey, type RestoreProgress } from "../../matrix/security";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../primitives/Dialog";
import { ProgressBar, Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

/** "Verify this device with your recovery key", then restore the key backup. */
export function RecoveryKeyDialog({ onClose }: { onClose: () => void }) {
  const { client } = useMatrix();
  const ui = useUi();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [result, setResult] = useState<{ imported: number; total: number } | null | "no-backup">(null);
  const id = useId();

  if (result !== null) {
    return (
      <Dialog title="Device verified" icon={<CircleCheck />} onClose={onClose}>
        <div className="verify-state">
          <CircleCheck className="verify-icon ok" aria-hidden="true" />
          <p role="status">
            This device is now verified.{" "}
            {result === "no-backup"
              ? "There was no key backup to restore."
              : `Restored ${result.imported} of ${result.total} message key${result.total === 1 ? "" : "s"} from your backup.`}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Verify with your recovery key" icon={<KeyRound />} onClose={onClose} dismissible={!busy}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await verifyWithRecoveryKey(client, input, setProgress);
            setInput("");
            setResult(res ?? "no-backup");
            ui.security.refresh();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
            setProgress(null);
          }
        }}
      >
        <p>Enter the recovery key you saved when you set up secure backup. It unlocks your message history on this device.</p>
        <div className="field">
          <label htmlFor={id}>Recovery key (or security phrase)</label>
          <input
            id={id}
            className="mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        {error ? (
          <div className="alert alert-danger" role="alert">
            <TriangleAlert aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        {busy ? (
          progress?.stage === "load" && progress.total > 0 ? (
            <div className="stack-sm">
              <ProgressBar value={progress.done} max={progress.total} label="Restoring message keys" />
              <p className="small muted" role="status">
                Restoring message keys: {progress.done} of {progress.total}
              </p>
            </div>
          ) : (
            <Spinner size="sm" label={progress ? "Downloading your key backup…" : "Checking your recovery key…"} />
          )
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
            Verify
          </button>
        </div>
      </form>
    </Dialog>
  );
}
