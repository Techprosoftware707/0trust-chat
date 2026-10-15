import { useState } from "react";
import { DoorOpen } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { errorMessage } from "../../lib/errors";
import { navigate } from "../../hooks/useRoute";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";

export function LeaveRoomDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { client } = useMatrix();
  const room = client.getRoom(roomId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Leave ${room?.name ?? "conversation"}?`} icon={<DoorOpen />} onClose={onClose} dismissible={!busy} size="sm">
      <p className="muted">You'll stop receiving messages. You can only rejoin if someone invites you again.</p>
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
              await client.leave(roomId);
              onClose();
              navigate("#/");
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size="sm" /> : null} Leave
        </button>
      </div>
    </Dialog>
  );
}
