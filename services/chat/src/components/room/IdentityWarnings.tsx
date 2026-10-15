import { useEffect, useState } from "react";
import { KnownMembership, RoomStateEvent, type Room } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { ShieldAlert } from "lucide-react";
import { useClient } from "../../matrix/context";
import { useUi } from "../UiContext";
import { Spinner } from "../primitives/Spinner";

interface Issue {
  userId: string;
  kind: "changed" | "violation";
}

const MAX_MEMBERS_CHECKED = 100;

/**
 * Warns when someone's cryptographic identity changed (the SDK reports
 * `needsUserApproval`, or a previously verified identity is no longer verified).
 */
export function IdentityWarnings({ room, encrypted }: { room: Room; encrypted: boolean | null }) {
  const client = useClient();
  const ui = useUi();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    room.on(RoomStateEvent.Members, bump);
    client.on(CryptoEvent.UserTrustStatusChanged, bump);
    client.on(CryptoEvent.KeysChanged, bump);
    return () => {
      room.off(RoomStateEvent.Members, bump);
      client.off(CryptoEvent.UserTrustStatusChanged, bump);
      client.off(CryptoEvent.KeysChanged, bump);
    };
  }, [client, room]);

  useEffect(() => {
    let alive = true;
    const crypto = client.getCrypto();
    if (!crypto || !encrypted) {
      setIssues([]);
      return;
    }
    const me = client.getUserId();
    const members = [...room.getMembersWithMembership(KnownMembership.Join), ...room.getMembersWithMembership(KnownMembership.Invite)]
      .map((m) => m.userId)
      .filter((u) => u !== me)
      .slice(0, MAX_MEMBERS_CHECKED);
    void Promise.all(
      members.map(async (userId): Promise<Issue | null> => {
        const s = await crypto.getUserVerificationStatus(userId);
        if (s.wasCrossSigningVerified() && !s.isCrossSigningVerified()) return { userId, kind: "violation" };
        if (s.needsUserApproval) return { userId, kind: "changed" };
        return null;
      }),
    )
      .then((res) => alive && setIssues(res.filter((x): x is Issue => x !== null)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, room, encrypted, tick]);

  if (!issues.length) return null;
  const issue = issues[0];
  const name = room.getMember(issue.userId)?.name ?? issue.userId;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.reportError(e, "Couldn't update the identity");
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };
  return (
    <div className={`identity-banner ${issue.kind === "violation" ? "danger" : "warning"}`} role="alert">
      <ShieldAlert aria-hidden="true" />
      <p>
        {issue.kind === "violation" ? (
          <>
            <strong>{name}</strong>'s verified identity has changed. Until you verify them again, you can't be sure messages are really from them.
          </>
        ) : (
          <>
            <strong>{name}</strong>'s identity appears to have changed. This happens when they reset their encryption — or if someone is impersonating
            them. Verify them to be sure.
          </>
        )}
        {issues.length > 1 ? <span className="muted"> (+{issues.length - 1} more)</span> : null}
      </p>
      <div className="identity-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void ui.verifyUser(issue.userId)}>
          Verify {name}
        </button>
        {issue.kind === "violation" ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => act(() => client.getCrypto()!.withdrawVerificationRequirement(issue.userId))}
          >
            {busy ? <Spinner size="sm" /> : null} Withdraw verification
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => client.getCrypto()!.pinCurrentUserIdentity(issue.userId))}>
            {busy ? <Spinner size="sm" /> : null} I understand
          </button>
        )}
      </div>
    </div>
  );
}
