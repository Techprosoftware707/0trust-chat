import { useState } from "react";
import { MessageSquarePlus, LockKeyhole } from "lucide-react";
import { MatrixError } from "matrix-js-sdk";
import { useMatrix } from "../../matrix/context";
import { openOrCreateDm, waitForRoom } from "../../matrix/rooms";
import { roomHash } from "../../lib/matrix-id";
import { errorMessage } from "../../lib/errors";
import { navigate } from "../../hooks/useRoute";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { UserPicker, type PickedUser } from "./UserPicker";

export async function startDm(client: ReturnType<typeof useMatrix>["client"], userId: string): Promise<string> {
  try {
    await client.getProfileInfo(userId);
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") throw new Error(`${userId} doesn't seem to exist.`, { cause: e });
    // Other errors (e.g. federation) don't prove the user doesn't exist: continue.
  }
  const roomId = await openOrCreateDm(client, userId);
  await waitForRoom(client, roomId);
  return roomId;
}

export function NewDmDialog({ onClose, initialUser }: { onClose: () => void; initialUser?: string }) {
  const { client } = useMatrix();
  const [selected, setSelected] = useState<PickedUser[]>(initialUser ? [{ userId: initialUser }] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = selected[0];
  return (
    <Dialog title="New direct message" icon={<MessageSquarePlus />} onClose={onClose} dismissible={!busy}>
      {initialUser ? (
        <p>
          Start an end-to-end encrypted conversation with <strong className="break">{initialUser}</strong>?
        </p>
      ) : (
        <UserPicker selected={selected} onChange={setSelected} multiple={false} />
      )}
      {target && !initialUser ? (
        <p className="small">
          Selected: <strong className="break">{target.displayName ? `${target.displayName} (${target.userId})` : target.userId}</strong>
        </p>
      ) : null}
      <p className="small muted">
        <LockKeyhole aria-hidden="true" className="inline-icon" /> The conversation is encrypted from the first message.
      </p>
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
          className="btn btn-primary"
          disabled={!target || busy}
          onClick={async () => {
            if (!target) return;
            setBusy(true);
            setError(null);
            try {
              const roomId = await startDm(client, target.userId);
              onClose();
              navigate(roomHash(roomId));
            } catch (e) {
              setError(errorMessage(e, "Couldn't start the conversation."));
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size="sm" /> : null} Start conversation
        </button>
      </div>
    </Dialog>
  );
}
