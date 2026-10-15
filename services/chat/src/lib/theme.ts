/** Light/dark theme, shared with the website through localStorage "lumen-theme". */
import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "lumen-theme";
const EVENT = "lumen-theme-change";

export function getThemeChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage disabled: apply for this page only */
  }
  applyThemeChoice(choice);
  window.dispatchEvent(new Event(EVENT));
}

export function effectiveTheme(): "light" | "dark" {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Re-renders when the theme choice or the OS preference changes. */
export function useTheme(): { choice: ThemeChoice; effective: "light" | "dark" } {
  const [state, setState] = useState(() => ({ choice: getThemeChoice(), effective: effectiveTheme() }));
  useEffect(() => {
    const update = () => setState({ choice: getThemeChoice(), effective: effectiveTheme() });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    mq?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
      mq?.removeEventListener?.("change", update);
    };
  }, []);
  return state;
}
