import { useState } from "react";
import { UserPlus } from "lucide-react";
import { KnownMembership } from "matrix-js-sdk";
import { useMatrix } from "../../matrix/context";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { UserPicker, type PickedUser } from "./UserPicker";

export function InviteDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { client } = useMatrix();
  const room = client.getRoom(roomId);
  const [people, setPeople] = useState<PickedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exclude = room
    ? [...room.getMembersWithMembership(KnownMembership.Join), ...room.getMembersWithMembership(KnownMembership.Invite)].map((m) => m.userId)
    : [];
  return (
    <Dialog title={`Invite to ${room?.name ?? "conversation"}`} icon={<UserPlus />} onClose={onClose} dismissible={!busy}>
      <UserPicker selected={people} onChange={setPeople} multiple exclude={exclude} />
      {room?.hasEncryptionStateEvent() ? (
        <p className="small muted">New members can read messages sent after they join. Earlier messages stay encrypted for them.</p>
      ) : null}
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
          disabled={busy || people.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const failed: string[] = [];
            for (const p of people) {
              try {
                await client.invite(roomId, p.userId);
              } catch (e) {
                failed.push(`${p.userId}: ${errorMessage(e)}`);
              }
            }
            setBusy(false);
            if (failed.length) setError(`Some invites failed. ${failed.join("; ")}`);
            else onClose();
          }}
        >
          {busy ? <Spinner size="sm" /> : null} Invite
        </button>
      </div>
    </Dialog>
  );
}
