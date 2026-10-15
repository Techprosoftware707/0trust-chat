import { useEffect, useState } from "react";
import { EventStatus, MatrixEventEvent, type MatrixEvent } from "matrix-js-sdk";
import { CryptoEvent, EventShieldColour, EventShieldReason } from "matrix-js-sdk/lib/crypto-api/index.js";
import { Lock, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { useClient } from "../../matrix/context";

type Shield =
  | { kind: "none" }
  | { kind: "plain"; inEncryptedRoom: boolean }
  | { kind: "verified" }
  | { kind: "encrypted" }
  | { kind: "warning"; colour: "grey" | "red"; text: string };

const REASON_TEXT: Record<number, string> = {
  [EventShieldReason.UNKNOWN]: "Encrypted, but the sender's authenticity couldn't be checked.",
  [EventShieldReason.UNVERIFIED_IDENTITY]: "Encrypted by a user you haven't verified.",
  [EventShieldReason.UNSIGNED_DEVICE]: "Encrypted by a device its owner hasn't verified.",
  [EventShieldReason.UNKNOWN_DEVICE]: "Encrypted by an unknown or deleted device.",
  [EventShieldReason.AUTHENTICITY_NOT_GUARANTEED]: "The authenticity of this encrypted message can't be guaranteed on this device.",
  [EventShieldReason.VERIFICATION_VIOLATION]: "Sent after the sender's verified identity changed.",
  [EventShieldReason.MISMATCHED_SENDER]: "The sender of this message doesn't match the device that encrypted it.",
};

/**
 * Per-message encryption indicator from the Rust crypto layer's
 * `getEncryptionInfoForEvent` plus the sender's cross-signing status.
 */
export function EncryptionShield({ event, roomEncrypted }: { event: MatrixEvent; roomEncrypted: boolean | null }) {
  const client = useClient();
  const [shield, setShield] = useState<Shield>({ kind: "none" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const sender = event.getSender();
    const onTrust = (userId: string) => userId === sender && bump();
    const onDevices = (users: string[]) => sender && users.includes(sender) && bump();
    event.on(MatrixEventEvent.Decrypted, bump);
    event.on(MatrixEventEvent.Status, bump);
    client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    client.on(CryptoEvent.DevicesUpdated, onDevices);
    return () => {
      event.off(MatrixEventEvent.Decrypted, bump);
      event.off(MatrixEventEvent.Status, bump);
      client.off(CryptoEvent.UserTrustStatusChanged, onTrust);
      client.off(CryptoEvent.DevicesUpdated, onDevices);
    };
  }, [client, event]);

  useEffect(() => {
    let alive = true;
    const crypto = client.getCrypto();
    const isLocal = event.status !== null;
    if (event.isRedacted()) {
      setShield({ kind: "none" });
      return;
    }
    if (isLocal) {
      // Our own message still being sent: it is encrypted iff the room is.
      setShield(roomEncrypted ? { kind: "encrypted" } : { kind: "plain", inEncryptedRoom: false });
      return;
    }
    if (!event.isEncrypted()) {
      setShield({ kind: "plain", inEncryptedRoom: !!roomEncrypted });
      return;
    }
    if (event.isDecryptionFailure() || event.isBeingDecrypted() || !crypto) {
      setShield({ kind: "none" });
      return;
    }
    void (async () => {
      const info = await crypto.getEncryptionInfoForEvent(event);
      if (!alive || !info) return;
      if (info.shieldColour === EventShieldColour.NONE) {
        const sender = event.getSender();
        const me = client.getUserId();
        // Messages from other users show "verified" only if you verified them.
        const verified = !!sender && sender !== me && (await crypto.getUserVerificationStatus(sender)).isCrossSigningVerified();
        if (alive) setShield(verified ? { kind: "verified" } : { kind: "encrypted" });
      } else {
        setShield({
          kind: "warning",
          colour: info.shieldColour === EventShieldColour.RED ? "red" : "grey",
          text: REASON_TEXT[info.shieldReason ?? EventShieldReason.UNKNOWN] ?? REASON_TEXT[EventShieldReason.UNKNOWN],
        });
      }
    })().catch(() => alive && setShield({ kind: "none" }));
    return () => {
      alive = false;
    };
  }, [client, event, roomEncrypted, tick, event.status]);

  switch (shield.kind) {
    case "none":
      return null;
    case "plain":
      return (
        <span className={`shield ${shield.inEncryptedRoom ? "shield-red" : "shield-muted"}`} title="Not encrypted" role="img" aria-label="Not encrypted">
          <ShieldOff aria-hidden="true" />
        </span>
      );
    case "verified":
      return (
        <span className="shield shield-ok" title="Encrypted · sent by a verified user" role="img" aria-label="Encrypted, verified sender">
          <ShieldCheck aria-hidden="true" />
        </span>
      );
    case "encrypted":
      return (
        <span className="shield shield-neutral" title="End-to-end encrypted" role="img" aria-label="End-to-end encrypted">
          <Lock aria-hidden="true" />
        </span>
      );
    case "warning":
      return (
        <span className={`shield shield-${shield.colour}`} title={shield.text} role="img" aria-label={shield.text}>
          <ShieldAlert aria-hidden="true" />
        </span>
      );
  }
}

export function isPendingLocal(ev: MatrixEvent): boolean {
  return ev.status === EventStatus.SENDING || ev.status === EventStatus.ENCRYPTING || ev.status === EventStatus.QUEUED;
}
