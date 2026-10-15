import { useEffect, useId, useState } from "react";
import { Preset } from "matrix-js-sdk";
import { Lock, Users } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { createGroup, waitForRoom } from "../../matrix/rooms";
import { roomHash } from "../../lib/matrix-id";
import { errorMessage } from "../../lib/errors";
import { navigate } from "../../hooks/useRoute";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { UserPicker, type PickedUser } from "./UserPicker";

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const { client } = useMatrix();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [encrypted, setEncrypted] = useState(true);
  const [people, setPeople] = useState<PickedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  const id = useId();
  // Some servers encrypt every new room regardless of what the client asks for: say so.
  useEffect(() => {
    let alive = true;
    client
      .doesServerForceEncryptionForPreset(Preset.PrivateChat)
      .then((f) => {
        if (!alive || !f) return;
        setForced(true);
        setEncrypted(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client]);
  return (
    <Dialog title="New group" icon={<Users />} onClose={onClose} dismissible={!busy}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const roomId = await createGroup(client, { name: name.trim(), topic: topic.trim(), invite: people.map((p) => p.userId), encrypted });
            await waitForRoom(client, roomId);
            onClose();
            navigate(roomHash(roomId));
          } catch (err) {
            setError(errorMessage(err, "Couldn't create the group."));
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-name`}>Group name</label>
          <input id={`${id}-name`} type="text" required maxLength={255} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor={`${id}-topic`}>Topic (optional)</label>
          <input id={`${id}-topic`} type="text" maxLength={500} value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        <UserPicker selected={people} onChange={setPeople} multiple label="Invite people" autoFocus={false} />
        <label className="checkbox">
          <input type="checkbox" checked={encrypted} disabled={forced} onChange={(e) => setEncrypted(e.target.checked)} />
          <span>
            <strong>
              <Lock aria-hidden="true" className="inline-icon" /> End-to-end encryption
            </strong>
            <br />
            <span className="muted small">
              {forced
                ? "Your server encrypts all new conversations."
                : encrypted
                  ? "Recommended. Can't be turned off later."
                  : "Without encryption the server can read every message in this group."}
            </span>
          </span>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner size="sm" /> : null} Create group
          </button>
        </div>
      </form>
    </Dialog>
  );
}
