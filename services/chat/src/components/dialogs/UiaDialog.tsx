import { useId, useState } from "react";
import { ExternalLink, LockKeyhole } from "lucide-react";
import type { UiaPromptRequest } from "../../matrix/uia";
import { Dialog } from "../primitives/Dialog";

/**
 * Confirms a sensitive action with the account: password, or SSO via the
 * homeserver's fallback page in a new window.
 */
export function UiaDialog({ request, onDone }: { request: UiaPromptRequest; onDone: (v: string | true | null) => void }) {
  const [password, setPassword] = useState("");
  const [opened, setOpened] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const id = useId();
  return (
    <Dialog title="Confirm it's you" icon={<LockKeyhole />} onClose={() => onDone(null)} size="sm">
      <p>
        To <strong>{request.action.charAt(0).toLowerCase() + request.action.slice(1)}</strong>, confirm your identity.
      </p>
      {request.error ? (
        <p className="form-error" role="alert">
          {request.error}
        </p>
      ) : null}
      {request.kind === "password" ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const pw = password;
            setPassword("");
            onDone(pw);
          }}
        >
          <div className="field">
            <label htmlFor={id}>Password</label>
            <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!password}>
              Confirm
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <ol className="small steps-list">
            <li>Open the sign-in window and confirm with your account.</li>
            <li>When it says you're done, close it and come back here.</li>
          </ol>
          <button
            type="button"
            className="btn btn-block"
            onClick={() => {
              const w = window.open(request.fallbackUrl, "lumen-uia", "popup,width=520,height=720");
              setBlocked(!w);
              setOpened(true);
            }}
          >
            <ExternalLink aria-hidden="true" /> Open sign-in window
          </button>
          {blocked ? (
            <p className="small">
              Your browser blocked the window.{" "}
              <a href={request.fallbackUrl} target="_blank" rel="noopener noreferrer">
                Open it in a new tab
              </a>{" "}
              instead.
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!opened} onClick={() => onDone(true)}>
              I've confirmed
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
