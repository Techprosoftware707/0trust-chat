import { useId, useState } from "react";
import { KeyRound } from "lucide-react";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage.js";
import { useMatrix } from "../../matrix/context";
import { keyFromUserInput } from "../../matrix/security";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";

/** Asked by the SDK (via cryptoCallbacks) when it needs the secret-storage key. */
export function SecretKeyPromptDialog({
  info,
  onDone,
}: {
  keyId: string;
  info: SecretStorageKeyDescription;
  onDone: (key: Uint8Array<ArrayBuffer> | null) => void;
}) {
  const { client } = useMatrix();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <Dialog title="Enter your recovery key" icon={<KeyRound />} onClose={() => onDone(null)} size="sm" dismissible={!busy}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const key = await keyFromUserInput(input, info);
            if (!(await client.secretStorage.checkKey(key, info))) {
              key.fill(0);
              setError("That recovery key doesn't match.");
              setBusy(false);
              return;
            }
            setInput("");
            onDone(key);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="muted">Your recovery key is needed to unlock your encrypted secrets for this action.</p>
        <div className="field">
          <label htmlFor={id}>Recovery key</label>
          <input id={id} className="mono" type="password" autoComplete="off" required value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onDone(null)} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
            {busy ? <Spinner size="sm" /> : null} Continue
          </button>
        </div>
      </form>
    </Dialog>
  );
}
