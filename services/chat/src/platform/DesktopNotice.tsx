import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import type { DesktopStorageProtection } from "./desktop-api";
import { desktopApi } from "./desktop";

/**
 * Desktop app only: a visible warning when the OS can't protect the app's keys (Linux without
 * a Secret Service/KWallet keyring, or no protected storage at all). Renders nothing in a browser.
 */
export function DesktopStorageNotice() {
  const [protection, setProtection] = useState<DesktopStorageProtection | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    void desktopApi()
      ?.storageProtection()
      .then(setProtection)
      .catch(() => undefined);
  }, []);
  if (!protection || protection.level === "os" || dismissed) return null;
  return (
    <div className="alert alert-warning desktop-notice" role="alert" data-testid="keyring-warning">
      <TriangleAlert aria-hidden="true" />
      <p>
        {protection.level === "basic"
          ? "No OS keyring is available (Secret Service or KWallet), so this app can't encrypt your session keys with the operating system. Anyone who can read your files could use your session."
          : "Protected storage isn't available on this system, so your session keys are only protected by the app's local storage."}
      </p>
      <button type="button" className="btn btn-ghost btn-sm" aria-label="Hide this warning until the app restarts" onClick={() => setDismissed(true)}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
