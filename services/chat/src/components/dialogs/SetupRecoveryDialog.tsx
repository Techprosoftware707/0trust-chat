import { useEffect, useId, useRef, useState } from "react";
import type { GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api/index.js";
import { CircleCheck, Download, KeyRound, TriangleAlert } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { generateRecoveryKey, normaliseRecoveryKey, resetEncryption, setUpRecovery } from "../../matrix/security";
import { saveBlob } from "../../matrix/media";
import { UiaCancelledError } from "../../matrix/uia";
import { errorMessage } from "../../lib/errors";
import { CopyButton } from "../primitives/CopyButton";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

type Step = "intro" | "show" | "confirm" | "working" | "done" | "error";

/**
 * Creates a recovery key (shown exactly once), asks the user to confirm it,
 * then sets up cross-signing, secret storage and key backup — or, in "reset"
 * mode, replaces the account's encryption identity.
 */
export function SetupRecoveryDialog({
  mode,
  onClose,
  onLater,
}: {
  mode: "setup" | "change" | "reset";
  onClose: () => void;
  onLater?: () => void;
}) {
  const { client, config } = useMatrix();
  const ui = useUi();
  const [step, setStep] = useState<Step>("intro");
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedReset, setTypedReset] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const keyRef = useRef<GeneratedSecretStorageKey | null>(null);
  const [encoded, setEncoded] = useState<string | null>(null);
  const confirmId = useId();
  const resetId = useId();

  // Wipe the key from memory when the dialog goes away.
  useEffect(
    () => () => {
      keyRef.current?.privateKey.fill(0);
      keyRef.current = null;
    },
    [],
  );

  const generate = async () => {
    setError(null);
    try {
      const k = await generateRecoveryKey(client);
      keyRef.current = k;
      setEncoded(k.encodedPrivateKey ?? null);
      setStep("show");
    } catch (e) {
      setError(errorMessage(e));
      setStep("error");
    }
  };

  const apply = async () => {
    const key = keyRef.current;
    if (!key) return;
    setStep("working");
    setError(null);
    try {
      if (mode === "reset") await resetEncryption(client, key);
      else await setUpRecovery(client, key);
      key.privateKey.fill(0);
      keyRef.current = null;
      setEncoded(null);
      setTyped("");
      setStep("done");
      ui.security.refresh();
    } catch (e) {
      setError(e instanceof UiaCancelledError ? "You cancelled the confirmation, so nothing was changed on the server." : errorMessage(e));
      setStep("error");
    }
  };

  const title = mode === "reset" ? "Reset encryption" : mode === "change" ? "Change recovery key" : "Set up secure backup";
  const busy = step === "working";

  return (
    <Dialog title={title} icon={mode === "reset" ? <TriangleAlert /> : <KeyRound />} onClose={onClose} dismissible={!busy} size="md">
      {step === "intro" && mode !== "reset" ? (
        <div className="stack">
          <p>
            {mode === "setup"
              ? "Your messages are end-to-end encrypted, so only your devices hold the keys. A recovery key lets you unlock your message history on new devices, or if you lose this one."
              : "Create a new recovery key. Your current recovery key will stop working."}
          </p>
          <ul className="check-list small">
            <li>
              <CircleCheck aria-hidden="true" /> Your keys are encrypted with the recovery key before they're stored on the server.
            </li>
            <li>
              <CircleCheck aria-hidden="true" /> {config.brand.shortName} never sees your recovery key. Keep it somewhere safe, like a password manager.
            </li>
          </ul>
          {ui.security.backupInfo && !ui.security.backupKeyCached ? (
            <div className="alert alert-warning small">
              <TriangleAlert aria-hidden="true" />
              <p>This device can't unlock your existing key backup, so a new backup will be started.</p>
            </div>
          ) : null}
          <div className="dialog-actions">
            {onLater ? (
              <button type="button" className="btn btn-ghost" onClick={onLater}>
                Later
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={generate}>
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {step === "intro" && mode === "reset" ? (
        <div className="stack">
          <div className="alert alert-danger">
            <TriangleAlert aria-hidden="true" />
            <div>
              <p>
                <strong>Only do this if you've lost access to all your other devices and your recovery key.</strong>
              </p>
              <ul className="small">
                <li>Your encrypted message history will become unreadable unless another verified device still has the keys.</li>
                <li>Your existing key backups will be deleted.</li>
                <li>Everyone you've verified will see that your identity changed, and will need to verify you again.</li>
                <li>Your other devices will need to be verified again.</li>
              </ul>
            </div>
          </div>
          <div className="field">
            <label htmlFor={resetId}>
              Type <strong>RESET</strong> to confirm
            </label>
            <input id={resetId} type="text" autoComplete="off" value={typedReset} onChange={(e) => setTypedReset(e.target.value)} />
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={typedReset.trim() !== "RESET"} onClick={generate}>
              Continue to reset
            </button>
          </div>
        </div>
      ) : null}

      {step === "show" && encoded ? (
        <div className="stack">
          <p>
            This is your recovery key. <strong>It's shown only once</strong> — save it now somewhere safe.
          </p>
          <p className="recovery-key" aria-label="Recovery key">
            {encoded}
          </p>
          <div className="cluster">
            <CopyButton text={encoded} label="Copy key" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                saveBlob(
                  new Blob(
                    [
                      `${config.brand.name} recovery key\n\n${encoded}\n\nKeep this file private. Anyone with this key can read your encrypted message history.\n`,
                    ],
                    { type: "text/plain" },
                  ),
                  `${config.brand.shortName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-recovery-key.txt`,
                )
              }
            >
              <Download aria-hidden="true" /> Download
            </button>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I've saved my recovery key somewhere safe</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!saved} onClick={() => setStep("confirm")}>
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {step === "confirm" && encoded ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (normaliseRecoveryKey(typed) !== normaliseRecoveryKey(encoded)) {
              setMismatch(true);
              return;
            }
            void apply();
          }}
        >
          <p>To make sure you saved it, enter your recovery key.</p>
          <div className="field">
            <label htmlFor={confirmId}>Recovery key</label>
            <input
              id={confirmId}
              className="mono"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed}
              aria-invalid={mismatch}
              onChange={(e) => {
                setTyped(e.target.value);
                setMismatch(false);
              }}
            />
          </div>
          {mismatch ? (
            <p className="form-error" role="alert">
              That doesn't match the key shown on the previous step.
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setStep("show")}>
              Back
            </button>
            <button type="submit" className={`btn ${mode === "reset" ? "btn-danger" : "btn-primary"}`} disabled={!typed.trim()}>
              {mode === "reset" ? "Reset encryption" : "Finish set-up"}
            </button>
          </div>
        </form>
      ) : null}

      {step === "working" ? (
        <div className="verify-state">
          <Spinner size="lg" label={mode === "reset" ? "Resetting your encryption…" : "Setting up secure backup…"} />
          <p className="small muted">You may be asked to confirm with your account.</p>
        </div>
      ) : null}

      {step === "done" ? (
        <div className="verify-state">
          <CircleCheck className="verify-icon ok celebrate" aria-hidden="true" />
          <p role="status">
            {mode === "reset" ? (
              "Your encryption has been reset and is protected by your new recovery key."
            ) : (
              <>
                <strong className="verify-headline">You're all set.</strong> Secure backup is set up: your message keys are backed up, encrypted with your
                recovery key.
              </>
            )}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {step === "error" ? (
        <div className="stack">
          <div className="alert alert-danger" role="alert">
            <TriangleAlert aria-hidden="true" />
            <p>{error}</p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn-primary" onClick={() => (keyRef.current ? void apply() : void generate())}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
