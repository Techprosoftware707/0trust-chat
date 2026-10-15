import { LockKeyhole, MessageSquarePlus, Users } from "lucide-react";
import { useMatrix } from "../matrix/context";
import { useUi } from "./UiContext";
import { BrandLogo } from "./BrandLogo";

export function EmptyRoomPane() {
  const { config } = useMatrix();
  const ui = useUi();
  return (
    <div className="empty-pane">
      <div className="empty-card">
        <BrandLogo size={56} />
        <h1>Welcome to {config.brand.shortName}</h1>
        <p className="muted">Pick a conversation from the list, or start a new one. Every new conversation is end-to-end encrypted.</p>
        <div className="cluster center-cluster">
          <button type="button" className="btn btn-primary" onClick={() => ui.openDialog({ type: "new-dm" })}>
            <MessageSquarePlus aria-hidden="true" /> New message
          </button>
          <button type="button" className="btn" onClick={() => ui.openDialog({ type: "new-group" })}>
            <Users aria-hidden="true" /> New group
          </button>
        </div>
        <p className="empty-foot small subtle">
          <LockKeyhole aria-hidden="true" /> Messages are encrypted on your device before they leave it.
        </p>
      </div>
    </div>
  );
}
