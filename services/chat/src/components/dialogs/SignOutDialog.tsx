import { useEffect, useState } from "react";
import { LogOut, TriangleAlert } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { signOut, wipeLocalData } from "../../matrix/client";
import { errorMessage } from "../../lib/errors";
import { resetPrefs } from "../../lib/prefs";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

export function SignOutDialog({ onClose, onSignedOut }: { onClose: () => void; onSignedOut: (notice: string) => void }) {
  const { client } = useMatrix();
  const ui = useUi();
  const [backupActive, setBackupActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client
      .getCrypto()
      ?.getActiveSessionBackupVersion()
      .then((v) => setBackupActive(v !== null))
      .catch(() => setBackupActive(false));
  }, [client]);
  const done = (notice: string) => {
    resetPrefs();
    onSignedOut(notice);
  };
  return (
    <Dialog title="Sign out?" icon={<LogOut />} onClose={onClose} dismissible={!busy} size="sm">
      {backupActive === false ? (
        <div className="alert alert-warning">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p>
              <strong>Your message keys aren't backed up.</strong> If you sign out and have no other verified device, you won't be able to read your
              encrypted messages again.
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onClose();
                ui.openDialog({ type: "setup-recovery", mode: "setup" });
              }}
            >
              Set up secure backup first
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">This removes this device from your account and deletes its local data and encryption keys from this browser.</p>
      )}
      {error ? (
        <div className="alert alert-danger" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p>{error}</p>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={async () => {
                setBusy(true);
                await wipeLocalData(client);
                done("Signed out on this device. The session may still be listed on the server until you remove it from another device.");
              }}
            >
              Sign out on this device anyway
            </button>
          </div>
        </div>
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
            setError(null);
            try {
              await signOut(client);
              done("You've signed out.");
            } catch (e) {
              setError(`Couldn't sign out on the server: ${errorMessage(e)}`);
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size="sm" /> : <LogOut aria-hidden="true" />} Sign out
        </button>
      </div>
    </Dialog>
  );
}
