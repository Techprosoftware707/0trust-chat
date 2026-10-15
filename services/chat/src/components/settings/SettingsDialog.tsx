import { useId, useState, type ReactNode } from "react";
import { Bell, Info, MonitorSmartphone, Palette, ShieldCheck, UserRound } from "lucide-react";
import { Dialog } from "../primitives/Dialog";
import type { SettingsTab } from "../UiContext";
import { ProfileTab } from "./ProfileTab";
import { AppearanceTab } from "./AppearanceTab";
import { NotificationsTab } from "./NotificationsTab";
import { SecurityTab } from "./SecurityTab";
import { SessionsTab } from "./SessionsTab";
import { AboutTab } from "./AboutTab";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "profile", label: "Profile", icon: <UserRound aria-hidden="true" /> },
  { id: "appearance", label: "Appearance", icon: <Palette aria-hidden="true" /> },
  { id: "notifications", label: "Notifications", icon: <Bell aria-hidden="true" /> },
  { id: "security", label: "Security & privacy", icon: <ShieldCheck aria-hidden="true" /> },
  { id: "sessions", label: "Sessions", icon: <MonitorSmartphone aria-hidden="true" /> },
  { id: "about", label: "About", icon: <Info aria-hidden="true" /> },
];

export function SettingsDialog({ initialTab = "profile", onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const base = useId();
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      setTab(TABS[next].id);
      document.getElementById(`${base}-tab-${TABS[next].id}`)?.focus();
    }
  };
  return (
    <Dialog title="Settings" onClose={onClose} size="xl" className="settings-dialog">
      <div className="settings">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={onKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`${base}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${base}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className="settings-tab"
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab}`} tabIndex={0}>
          {tab === "profile" ? <ProfileTab /> : null}
          {tab === "appearance" ? <AppearanceTab /> : null}
          {tab === "notifications" ? <NotificationsTab /> : null}
          {tab === "security" ? <SecurityTab /> : null}
          {tab === "sessions" ? <SessionsTab /> : null}
          {tab === "about" ? <AboutTab /> : null}
        </div>
      </div>
    </Dialog>
  );
}
