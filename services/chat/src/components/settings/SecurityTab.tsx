import { useEffect, useState } from "react";
import { BadgeCheck, CircleAlert, CircleCheck, CloudDownload, KeyRound, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import type { OwnDeviceKeys } from "matrix-js-sdk/lib/crypto-api/index.js";
import { useMatrix } from "../../matrix/context";
import { restoreFromBackup, type RestoreProgress } from "../../matrix/security";
import { setPrefs, usePrefs } from "../../lib/prefs";
import { errorMessage } from "../../lib/errors";
import { ProgressBar, Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";
import { Toggle } from "./Toggle";

function Row({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <li className="status-row">
      {ok === null ? <CircleAlert aria-hidden="true" className="subtle" /> : ok ? <CircleCheck aria-hidden="true" className="ok" /> : <CircleAlert aria-hidden="true" className="warn" />}
      <span className="status-label">{label}</span>
      <span className="status-value">{value}</span>
    </li>
  );
}

/** Groups a base64 key into blocks of 4 for easier reading aloud. */
function groupKey(k: string): string {
  return k.replace(/(.{4})/g, "$1 ").trim();
}

export function SecurityTab() {
  const { client, deviceId } = useMatrix();
  const ui = useUi();
  const s = ui.security;
  const prefs = usePrefs();
  const [keys, setKeys] = useState<OwnDeviceKeys | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void client.getCrypto()?.getOwnDeviceKeys().then(setKeys).catch(() => undefined);
    s.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const backupText = !s.backupInfo
    ? "Not set up"
    : s.backupActiveVersion
      ? `Active on this device (version ${s.backupActiveVersion}${typeof s.backupInfo.count === "number" ? `, ${s.backupInfo.count} keys stored` : ""})`
      : s.backupTrusted
        ? "Exists, but this device isn't backing up to it yet"
        : "Exists, but this device can't verify it";

  return (
    <div className="settings-section stack-lg">
      <section className="stack">
        <h3>This device</h3>
        {s.loading ? (
          <Spinner size="sm" label="Checking…" />
        ) : s.thisDeviceVerified ? (
          <p className="alert alert-success small">
            <BadgeCheck aria-hidden="true" />
            <span>This device is verified: it's signed by your cross-signing identity.</span>
          </p>
        ) : (
          <div className="alert alert-warning small">
            <ShieldAlert aria-hidden="true" />
            <div>
              <p>This device isn't verified yet, so it may not be able to read your earlier messages, and others can't tell it's really you.</p>
              {s.crossSigningExists ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => ui.openDialog({ type: "verify-device" })}>
                  Verify this device
                </button>
              ) : null}
            </div>
          </div>
        )}
        <dl className="kv small">
          <dt>Device ID</dt>
          <dd className="mono">{deviceId}</dd>
          <dt>Fingerprint (Ed25519)</dt>
          <dd className="mono break">{keys ? groupKey(keys.ed25519) : "…"}</dd>
        </dl>
      </section>

      <section className="stack">
        <h3>Secure backup</h3>
        <p className="small muted">
          Your message keys can be backed up to the server, encrypted with your recovery key. Only you can unlock them.
        </p>
        {s.error ? (
          <p className="form-error" role="alert">
            {s.error}
          </p>
        ) : null}
        <ul className="list-plain status-list">
          <Row ok={s.loading ? null : s.crossSigningExists} label="Cross-signing" value={s.crossSigningExists ? (s.crossSigningReady ? "Set up and trusted on this device" : "Set up on your account") : "Not set up"} />
          <Row ok={s.loading ? null : s.secretStorageReady} label="Recovery key" value={s.secretStorageReady ? "Set up" : s.keysInSecretStorage ? "Set up (needs update)" : "Not set up"} />
          <Row ok={s.loading ? null : !!s.backupActiveVersion} label="Key backup" value={backupText} />
          {s.sessionsRemaining ? <Row ok={null} label="Waiting to back up" value={`${s.sessionsRemaining} keys`} /> : null}
        </ul>
        <div className="cluster">
          {s.next === "setup" || (!s.secretStorageReady && s.crossSigningReady) ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => ui.openDialog({ type: "setup-recovery", mode: "setup" })}>
              <KeyRound aria-hidden="true" /> Set up secure backup
            </button>
          ) : null}
          {s.secretStorageReady && s.crossSigningReady ? (
            <button type="button" className="btn btn-sm" onClick={() => ui.openDialog({ type: "setup-recovery", mode: "change" })}>
              <RefreshCw aria-hidden="true" /> Change recovery key
            </button>
          ) : null}
          {s.backupInfo ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                setRestoreMsg(null);
                try {
                  const r = await restoreFromBackup(client, setProgress);
                  setRestoreMsg(
                    r
                      ? { kind: "ok", text: `Restored ${r.imported} of ${r.total} keys from your backup.` }
                      : { kind: "error", text: "Couldn't unlock the backup on this device." },
                  );
                } catch (e) {
                  setRestoreMsg({ kind: "error", text: errorMessage(e) });
                } finally {
                  setRestoring(false);
                  setProgress(null);
                  s.refresh();
                }
              }}
            >
              {restoring ? <Spinner size="sm" /> : <CloudDownload aria-hidden="true" />} Restore keys from backup
            </button>
          ) : null}
        </div>
        {restoring && progress?.stage === "load" && progress.total > 0 ? (
          <ProgressBar value={progress.done} max={progress.total} label="Restoring keys" />
        ) : null}
        {restoreMsg ? (
          <p className={restoreMsg.kind === "ok" ? "form-ok" : "form-error"} role={restoreMsg.kind === "ok" ? "status" : "alert"}>
            {restoreMsg.text}
          </p>
        ) : null}
      </section>

      <section className="stack">
        <h3>Privacy</h3>
        <Toggle
          label="Send read receipts"
          description="Let others see when you've read their messages. When off, your read position is still synced privately between your own devices."
          checked={prefs.sendReadReceipts}
          onChange={(on) => setPrefs({ sendReadReceipts: on })}
        />
        <Toggle
          label="Send typing notifications"
          description="Let others see when you're typing."
          checked={prefs.sendTypingNotifications}
          onChange={(on) => setPrefs({ sendTypingNotifications: on })}
        />
      </section>

      <section className="stack danger-zone">
        <h3>Reset encryption</h3>
        <p className="small muted">
          Only if you've lost your recovery key and all your other devices. You'll lose access to your encrypted message history, and contacts will
          see that your identity changed.
        </p>
        <div>
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => ui.openDialog({ type: "setup-recovery", mode: "reset" })}>
            <TriangleAlert aria-hidden="true" /> Reset encryption…
          </button>
        </div>
      </section>
    </div>
  );
}
