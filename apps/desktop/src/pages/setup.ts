export {};
/** Server picker (first run, or after "Change server…"). Discovery runs in the main process. */
interface Summary {
  serverName: string;
  homeserverUrl: string;
  brandName: string;
  isLumen: boolean;
  sso: boolean;
  passwordLogin: boolean;
  signupUrl: string | null;
  calls: "advertised" | "after-sign-in" | "none";
}
interface SetupApi {
  init(): Promise<{ defaultServer: string | null; storage: { level: string; backend: string } }>;
  discover(input: string): Promise<{ ok: true; summary: Summary } | { ok: false; error: string }>;
  connect(): Promise<boolean>;
  openSignup(): void;
}
const api = (window as unknown as { lumenSetup: SetupApi }).lumenSetup;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const input = $<HTMLInputElement>("server-input");
const error = $("error");
const btn = $<HTMLButtonElement>("continue");

function busy(on: boolean, label = "Continue") {
  btn.disabled = on;
  btn.textContent = "";
  if (on) {
    const s = document.createElement("span");
    s.className = "spinner";
    btn.append(s, " Checking…");
  } else btn.textContent = label;
}

function showError(msg: string | null) {
  error.hidden = !msg;
  error.textContent = msg ?? "";
}

async function discover(value: string) {
  showError(null);
  busy(true);
  const r = await api.discover(value);
  busy(false);
  if (!r.ok) {
    showError(r.error);
    input.focus();
    return;
  }
  const s = r.summary;
  $("brand").textContent = s.brandName;
  $("confirm-title").textContent = `Connect to ${s.brandName}?`;
  $("f-server").textContent = s.serverName;
  $("f-homeserver").textContent = s.homeserverUrl;
  $("f-signin").textContent = s.sso ? "Single sign-on in your web browser" : s.passwordLogin ? "Password" : "—";
  $("f-calls").textContent = s.calls === "advertised" ? "Available" : s.calls === "after-sign-in" ? "Checked after you sign in" : "Not offered by this server";
  $("signup-row").hidden = !s.signupUrl;
  $("step-input").hidden = true;
  $("step-confirm").hidden = false;
  $<HTMLButtonElement>("connect").focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void discover(input.value);
});
$("back").addEventListener("click", () => {
  $("step-confirm").hidden = true;
  $("step-input").hidden = false;
  input.focus();
});
$("connect").addEventListener("click", () => {
  const b = $<HTMLButtonElement>("connect");
  b.disabled = true;
  void api.connect().then((ok) => {
    if (!ok) b.disabled = false;
  });
});
$("signup").addEventListener("click", (e) => {
  e.preventDefault();
  api.openSignup();
});

void api.init().then((info) => {
  if (info.storage.level !== "os") {
    const w = $("keyring-warning");
    w.hidden = false;
    w.textContent =
      info.storage.level === "basic"
        ? "Your system has no keyring (Secret Service / KWallet), so this app can't protect its keys with the operating system. Anyone who can read your files could read your session."
        : "Protected storage is not available on this system. Your session keys are only protected by this app's local storage.";
  }
  if (info.defaultServer) {
    input.value = info.defaultServer;
    void discover(info.defaultServer);
  } else input.focus();
});
