import { LockKeyhole, MessageSquarePlus, Users } from "lucide-react";
import { useMatrix } from "../matrix/context";
import { useUserProfile } from "../hooks/matrix";
import { useUi } from "./UiContext";
import { BrandLogo } from "./BrandLogo";

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function EmptyRoomPane() {
  const { client, config, userId } = useMatrix();
  const ui = useUi();
  const { displayName } = useUserProfile(client, userId);
  const first = displayName && displayName !== userId ? displayName.split(/\s+/)[0] : null;
  const returning = client.getRooms().length > 0;
  return (
    <div className="empty-pane">
      <div className="empty-card">
        <span className="empty-logo">
          <BrandLogo size={56} />
        </span>
        <h1>{returning ? `${greeting()}${first ? `, ${first}` : ""}` : `Welcome to ${config.brand.shortName}${first ? `, ${first}` : ""}`}</h1>
        <p className="muted">
          {returning
            ? "Pick up a conversation from the list, or start something new."
            : "Start your first conversation. Every new conversation is end-to-end encrypted."}
        </p>
        <div className="cluster center-cluster">
          <button type="button" className="btn btn-primary" onClick={() => ui.openDialog({ type: "new-dm" })}>
            <MessageSquarePlus aria-hidden="true" /> New message
          </button>
          <button type="button" className="btn" onClick={() => ui.openDialog({ type: "new-group" })}>
            <Users aria-hidden="true" /> New group
          </button>
        </div>
        <p className="empty-foot small subtle">
          <LockKeyhole aria-hidden="true" /> Encrypted on your device before it leaves it · Built on Matrix
        </p>
      </div>
    </div>
  );
}
