import { useEffect, useReducer, useState } from "react";
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { BadgeCheck, CircleX, ShieldCheck } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

const started = new WeakSet<Verifier>();

const CANCEL_TEXT: Record<string, string> = {
  "m.user": "The verification was cancelled.",
  "m.timeout": "The verification timed out.",
  "m.mismatched_sas": "The emoji didn't match, so the verification was cancelled. Don't trust this device until you verify it successfully.",
  "m.key_mismatch": "The keys didn't match. Someone may be intercepting your connection.",
  "m.accepted": "The request was handled on another of your devices.",
  "m.unexpected_message": "The other side sent an unexpected message.",
  "m.unknown_method": "The other device doesn't support emoji verification.",
};

/**
 * Interactive SAS (emoji) verification, driven entirely by matrix-js-sdk's
 * VerificationRequest / Verifier objects.
 */
export function VerificationDialog({ request, onClose }: { request: VerificationRequest; onClose: () => void }) {
  const { client } = useMatrix();
  const ui = useUi();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [sas, setSas] = useState<ShowSasCallbacks | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request.on(VerificationRequestEvent.Change, force);
    return () => {
      request.off(VerificationRequestEvent.Change, force);
    };
  }, [request]);

  const verifier = request.verifier;
  useEffect(() => {
    if (!verifier) return;
    const onShow = (s: ShowSasCallbacks) => setSas(s);
    verifier.on(VerifierEvent.ShowSas, onShow);
    const existing = verifier.getShowSasCallbacks();
    if (existing) setSas(existing);
    if (!started.has(verifier)) {
      started.add(verifier);
      verifier.verify().catch((e: unknown) => {
        if (!verifier.hasBeenCancelled) setError(errorMessage(e, "Verification failed."));
      });
    }
    return () => {
      verifier.off(VerifierEvent.ShowSas, onShow);
    };
  }, [verifier]);

  const phase = request.phase;
  useEffect(() => {
    if (phase === VerificationPhase.Done) ui.security.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const otherName = request.isSelfVerification
    ? `your other device${request.otherDeviceId ? ` (${request.otherDeviceId})` : ""}`
    : (client.getUser(request.otherUserId)?.displayName ?? request.otherUserId);

  const finished = phase === VerificationPhase.Done || phase === VerificationPhase.Cancelled;
  const close = () => {
    if (!finished) void request.cancel().catch(() => undefined);
    onClose();
  };

  let body;
  if (error && !finished) {
    body = (
      <div className="verify-state">
        <CircleX className="verify-icon danger" aria-hidden="true" />
        <p role="alert">{error}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  } else if (phase === VerificationPhase.Unsent || phase === VerificationPhase.Requested) {
    body = request.initiatedByMe ? (
      <div className="verify-state">
        <Spinner size="lg" />
        <p>
          Waiting for <strong>{otherName}</strong> to accept…
        </p>
        <p className="small muted">
          {request.isSelfVerification ? "Open the app on your other device to continue." : "They'll see a verification request in their app."}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <div className="verify-state">
        <ShieldCheck className="verify-icon" aria-hidden="true" />
        <p>
          <strong>{otherName}</strong> wants to verify {request.isSelfVerification ? "this device" : "you"}.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            Decline
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || request.accepting}
            onClick={async () => {
              setBusy(true);
              try {
                await request.accept();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Accept
          </button>
        </div>
      </div>
    );
  } else if (phase === VerificationPhase.Ready) {
    const supportsSas = request.otherPartySupportsMethod(VerificationMethod.Sas);
    body = (
      <div className="verify-state">
        <ShieldCheck className="verify-icon" aria-hidden="true" />
        {supportsSas ? (
          <>
            <p>
              Compare a set of emoji with <strong>{otherName}</strong>. Do this in person or over a call you trust.
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await request.startVerification(VerificationMethod.Sas);
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Spinner size="sm" /> : null} Compare emoji
              </button>
            </div>
          </>
        ) : (
          <>
            <p>The other device doesn't support emoji verification, which is the only method this app offers.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    );
  } else if (phase === VerificationPhase.Started) {
    if (!sas) {
      body = (
        <div className="verify-state">
          <Spinner size="lg" label="Preparing emoji…" />
        </div>
      );
    } else if (confirmed) {
      body = (
        <div className="verify-state">
          <Spinner size="lg" />
          <p>
            Waiting for <strong>{otherName}</strong> to confirm…
          </p>
        </div>
      );
    } else {
      const emoji = sas.sas.emoji;
      body = (
        <div className="verify-sas">
          <p>
            Confirm that the emoji below appear on <strong>{otherName}</strong>'s screen, in the same order:
          </p>
          {emoji ? (
            <ol className="sas-grid" aria-label="Verification emoji">
              {emoji.map(([e, name], i) => (
                <li key={i} className="sas-item">
                  <span className="sas-emoji" aria-hidden="true">
                    {e}
                  </span>
                  <span className="sas-name">{name}</span>
                </li>
              ))}
            </ol>
          ) : sas.sas.decimal ? (
            <p className="sas-decimal" aria-label="Verification numbers">
              {sas.sas.decimal.join(" ")}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-outline-danger" onClick={() => sas.mismatch()}>
              They don't match
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                setConfirmed(true);
                try {
                  await sas.confirm();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              <BadgeCheck aria-hidden="true" /> They match
            </button>
          </div>
        </div>
      );
    }
  } else if (phase === VerificationPhase.Done) {
    body = (
      <div className="verify-state">
        <BadgeCheck className="verify-icon ok celebrate" aria-hidden="true" />
        <p role="status">
          {request.isSelfVerification ? (
            <>
              <strong className="verify-headline">Nicely done.</strong> This device is verified. Your encryption keys will be shared with it from your other
              device.
            </>
          ) : (
            <>
              <strong>{otherName}</strong> is verified. Messages from their verified devices will show a green shield.
            </>
          )}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  } else {
    const code = request.cancellationCode ?? "m.user";
    body = (
      <div className="verify-state">
        <CircleX className="verify-icon danger" aria-hidden="true" />
        <p role="alert">{CANCEL_TEXT[code] ?? `The verification was cancelled (${code}).`}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <Dialog
      title={request.isSelfVerification ? "Verify device" : `Verify ${otherName}`}
      icon={<ShieldCheck />}
      onClose={close}
      size="md"
    >
      {body}
    </Dialog>
  );
}
