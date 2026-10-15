import { useState } from "react";
import { Ban } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { blockUser } from "../../matrix/block";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";

/** Confirms blocking; `onBlocked` runs after the server has stored the change. */
export function BlockUserDialog({ userId, name, onClose, onBlocked }: { userId: string; name: string; onClose: () => void; onBlocked?: () => void }) {
  const { client } = useMatrix();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Block ${name}?`} icon={<Ban />} onClose={onClose} dismissible={!busy} size="sm">
      <p className="muted">
        You won't see their messages or invites on any of your devices, in every conversation. They aren't told, but they may notice that
        you don't reply. You can unblock them in Settings → Security & privacy.
      </p>
      <p className="small muted mono break">{userId}</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await blockUser(client, userId);
              onBlocked?.();
              onClose();
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size="sm" /> : <Ban aria-hidden="true" />} Block
        </button>
      </div>
    </Dialog>
  );
}
