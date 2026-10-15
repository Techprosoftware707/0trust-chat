import type { DialogSpec } from "./UiContext";
import { SettingsDialog } from "./settings/SettingsDialog";
import { NewDmDialog } from "./dialogs/NewDmDialog";
import { NewGroupDialog } from "./dialogs/NewGroupDialog";
import { InviteDialog } from "./dialogs/InviteDialog";
import { VerificationDialog } from "./dialogs/VerificationDialog";
import { SetupRecoveryDialog } from "./dialogs/SetupRecoveryDialog";
import { RecoveryKeyDialog } from "./dialogs/RecoveryKeyDialog";
import { VerifyDeviceDialog } from "./dialogs/VerifyDeviceDialog";
import { SignOutDialog } from "./dialogs/SignOutDialog";
import { LeaveRoomDialog } from "./dialogs/LeaveRoomDialog";
import { navigate } from "../hooks/useRoute";

export function DialogHost({
  dialogs,
  onClose,
  onSignedOut,
  onDismissFirstRun,
}: {
  dialogs: { id: number; spec: DialogSpec }[];
  onClose: () => void;
  onSignedOut: (notice: string) => void;
  onDismissFirstRun: () => void;
}) {
  return (
    <>
      {dialogs.map(({ id, spec: d }, i) => {
        // Only the top-most dialog may close itself (each closes the top of the stack).
        const close = i === dialogs.length - 1 ? onClose : () => undefined;
        const key = `dialog-${id}`;
        switch (d.type) {
          case "settings":
            return <SettingsDialog key={key} initialTab={d.tab} onClose={close} />;
          case "new-dm":
            return <NewDmDialog key={key} onClose={close} />;
          case "deeplink-dm":
            return (
              <NewDmDialog
                key={key}
                initialUser={d.userId}
                onClose={() => {
                  close();
                  if (window.location.hash.startsWith("#/dm/")) navigate("#/");
                }}
              />
            );
          case "new-group":
            return <NewGroupDialog key={key} onClose={close} />;
          case "invite":
            return <InviteDialog key={key} roomId={d.roomId} onClose={close} />;
          case "verification":
            return <VerificationDialog key={key} request={d.request} onClose={close} />;
          case "setup-recovery":
            return (
              <SetupRecoveryDialog
                key={key}
                mode={d.mode}
                onClose={close}
                onLater={
                  d.mode === "setup"
                    ? () => {
                        onDismissFirstRun();
                        close();
                      }
                    : undefined
                }
              />
            );
          case "recovery-key":
            return <RecoveryKeyDialog key={key} onClose={close} />;
          case "verify-device":
            return (
              <VerifyDeviceDialog
                key={key}
                onClose={close}
                onLater={() => {
                  onDismissFirstRun();
                  close();
                }}
              />
            );
          case "sign-out":
            return <SignOutDialog key={key} onClose={close} onSignedOut={onSignedOut} />;
          case "leave-room":
            return <LeaveRoomDialog key={key} roomId={d.roomId} onClose={close} />;
        }
      })}
    </>
  );
}
