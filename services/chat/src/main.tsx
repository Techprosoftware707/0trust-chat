import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { configureSdkLogging } from "./lib/logger";
import { applyThemeChoice, getThemeChoice } from "./lib/theme";
import { App } from "./App";

// Quiet SDK (and Rust crypto) logging in production. Nothing sensitive is logged by the app.
configureSdkLogging(import.meta.env.PROD ? "error" : "warn");
applyThemeChoice(getThemeChoice());

// Operator overrides (/brand/theme.css) load after our own CSS so they win.
// A missing file (e.g. in development) is harmless.
const brandCss = document.createElement("link");
brandCss.rel = "stylesheet";
brandCss.href = "/brand/theme.css";
document.head.appendChild(brandCss);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
