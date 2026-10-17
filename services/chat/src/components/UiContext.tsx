import { createContext, useContext } from "react";
import type { VerificationRequest } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { SecurityState } from "../hooks/security";

export type SettingsTab = "profile" | "appearance" | "notifications" | "calls" | "security" | "sessions" | "about";

export type DialogSpec =
  | { type: "settings"; tab?: SettingsTab }
  | { type: "new-dm" }
  | { type: "new-group" }
  | { type: "invite"; roomId: string }
  | { type: "verification"; request: VerificationRequest }
  | { type: "setup-recovery"; mode: "setup" | "change" | "reset" }
  | { type: "recovery-key" }
  | { type: "verify-device" }
  | { type: "sign-out" }
  | { type: "deeplink-dm"; userId: string }
  | { type: "leave-room"; roomId: string };

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error" | "verification";
  title: string;
  body?: string;
  actions?: ToastAction[];
  /** Auto-dismiss after this many ms (default: errors/info 6s, verification never). */
  timeoutMs?: number | null;
}

export interface UiContextValue {
  openDialog: (d: DialogSpec) => void;
  closeDialog: () => void;
  toast: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
  reportError: (e: unknown, context: string) => void;
  security: SecurityState & { refresh: () => void };
  /** Starts verifying another user (in a DM with them) or yourself. */
  verifyUser: (userId: string) => Promise<void>;
  /** Starts verifying this device against your other devices, or a specific device of yours. */
  verifyOwnDevice: (deviceId?: string) => Promise<void>;
  openPanel: (panel: PanelId | null) => void;
}

/** "info" | "search" | "calls", or the id of a registered room panel (src/workspace/registry.ts). */
export type PanelId = string;

export const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const v = useContext(UiContext);
  if (!v) throw new Error("useUi outside UiContext");
  return v;
}
