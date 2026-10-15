import { Monitor, Moon, Sun } from "lucide-react";
import { setThemeChoice, useTheme, type ThemeChoice } from "../../lib/theme";

const OPTIONS: { id: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "Match system", icon: <Monitor aria-hidden="true" /> },
  { id: "light", label: "Light", icon: <Sun aria-hidden="true" /> },
  { id: "dark", label: "Dark", icon: <Moon aria-hidden="true" /> },
];

export function AppearanceTab() {
  const { choice } = useTheme();
  return (
    <div className="settings-section stack">
      <h3>Appearance</h3>
      <fieldset className="theme-options">
        <legend className="label">Theme</legend>
        {OPTIONS.map((o) => (
          <label key={o.id} className={`theme-option${choice === o.id ? " selected" : ""}`}>
            <input type="radio" name="theme" value={o.id} checked={choice === o.id} onChange={() => setThemeChoice(o.id)} />
            <span className={`theme-swatch swatch-${o.id}`} aria-hidden="true">
              {o.icon}
            </span>
            <span>{o.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">Your choice is shared with the website on this browser.</p>
    </div>
  );
}
