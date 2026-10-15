import { useState } from "react";
import { BellOff, Info } from "lucide-react";
import { setPrefs, usePrefs } from "../../lib/prefs";
import { notificationPermission, requestNotificationPermission } from "../../matrix/notifications";
import { Toggle } from "./Toggle";

export function NotificationsTab() {
  const prefs = usePrefs();
  const [permission, setPermission] = useState(notificationPermission());
  const [asking, setAsking] = useState(false);
  return (
    <div className="settings-section stack">
      <h3>Notifications</h3>
      {permission === "unsupported" ? (
        <p className="alert alert-warning small">
          <BellOff aria-hidden="true" />
          <span>This browser doesn't support desktop notifications.</span>
        </p>
      ) : (
        <>
          <Toggle
            label="Desktop notifications"
            description="Show a notification for new messages while this tab is in the background, following your notification rules."
            checked={prefs.notifications && permission === "granted"}
            disabled={asking || permission === "denied"}
            onChange={async (on) => {
              if (!on) return setPrefs({ notifications: false });
              setAsking(true);
              const p = permission === "granted" ? "granted" : await requestNotificationPermission();
              setPermission(p);
              setAsking(false);
              setPrefs({ notifications: p === "granted" });
            }}
          />
          {permission === "denied" ? (
            <p className="alert alert-warning small">
              <BellOff aria-hidden="true" />
              <span>Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</span>
            </p>
          ) : null}
          <Toggle
            label="Show message previews"
            description="Include the message text in notifications. Off by default: anyone who can see your screen could read them."
            checked={prefs.notificationPreviews}
            disabled={!prefs.notifications}
            onChange={(on) => setPrefs({ notificationPreviews: on })}
          />
        </>
      )}
      <p className="small muted alert alert-info">
        <Info aria-hidden="true" />
        <span>Notifications are generated on this device after your messages are decrypted here. Nothing about them is sent to third-party push services.</span>
      </p>
    </div>
  );
}
