import { Moon, Sun } from "lucide-react";
import { setThemeChoice, useTheme } from "../lib/theme";

export function ThemeToggle() {
  const { effective } = useTheme();
  const dark = effective === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={dark}
      onClick={() => setThemeChoice(dark ? "light" : "dark")}
    >
      {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}
