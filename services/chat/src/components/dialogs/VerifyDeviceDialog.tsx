import { useEffect, useState } from "react";
import { KeyRound, MonitorSmartphone, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

/** Lets a new device prove it belongs to the account: another device, or the recovery key. */
export function VerifyDeviceDialog({ onClose, onLater }: { onClose: () => void; onLater?: () => void }) {
  const { client, userId, deviceId } = useMatrix();
  const ui = useUi();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [otherDevices, setOtherDevices] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void client.secretStorage.getDefaultKeyId().then((k) => alive && setHasKey(!!k)).catch(() => alive && setHasKey(false));
    void client
      .getCrypto()
      ?.getUserDeviceInfo([userId], true)
      .then((m) => {
        if (!alive) return;
        const devices = m.get(userId);
        setOtherDevices(devices ? [...devices.keys()].filter((d) => d !== deviceId).length : 0);
      })
      .catch(() => alive && setOtherDevices(0));
    return () => {
      alive = false;
    };
  }, [client, userId, deviceId]);

  const loading = hasKey === null || otherDevices === null;
  return (
    <Dialog title="Verify this device" icon={<ShieldCheck />} onClose={onClose}>
      <p>Confirm it's really you, so this device can read your encrypted message history and other people can trust it.</p>
      {loading ? (
        <Spinner label="Checking your options…" />
      ) : (
        <div className="choice-list">
          <button
            type="button"
            className="choice"
            disabled={!otherDevices}
            onClick={() => {
              onClose();
              void ui.verifyOwnDevice();
            }}
          >
            <MonitorSmartphone aria-hidden="true" />
            <span>
              <strong>Use another device</strong>
              <span className="muted small">
                {otherDevices ? "Compare emoji with a device where you're already signed in." : "You aren't signed in on any other device."}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="choice"
            disabled={!hasKey}
            onClick={() => {
              onClose();
              ui.openDialog({ type: "recovery-key" });
            }}
          >
            <KeyRound aria-hidden="true" />
            <span>
              <strong>Use your recovery key</strong>
              <span className="muted small">{hasKey ? "Enter the key you saved when you set up secure backup." : "No recovery key has been set up."}</span>
            </span>
          </button>
          <button
            type="button"
            className="choice danger"
            onClick={() => {
              onClose();
              ui.openDialog({ type: "setup-recovery", mode: "reset" });
            }}
          >
            <TriangleAlert aria-hidden="true" />
            <span>
              <strong>I can't do either</strong>
              <span className="muted small">Reset your encryption identity. You'll lose access to earlier encrypted messages.</span>
            </span>
          </button>
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onLater ?? onClose}>
          Later
        </button>
      </div>
    </Dialog>
  );
}
