export {};
interface View {
  platform: string;
  appVersion: string;
  electronVersion: string;
  packaged: boolean;
  brand: { name: string; shortName: string };
  server: { serverName: string; homeserverUrl: string; accountUrl: string | null } | null;
  settings: { closeToTray: boolean; openAtLogin: boolean; doNotDisturb: boolean; autoLockMinutes: number; lockOnSuspend: boolean; touchId: boolean };
  autoLockChoices: number[];
  lockEnabled: boolean;
  touchIdAvailable: boolean;
  openAtLoginSupported: boolean;
  storage: { level: "os" | "basic" | "unavailable"; backend: string };
  update: { status: string; message: string };
}
interface SettingsApi {
  get(): Promise<View>;
  set(patch: Record<string, unknown>): Promise<View>;
  setPin(current: string | null, next: string): Promise<{ ok: boolean; error?: string }>;
  removePin(current: string): Promise<{ ok: boolean; error?: string }>;
  lockNow(): Promise<boolean>;
  changeServer(): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  openAccount(): void;
  onChanged(cb: (v: View) => void): () => void;
}
const api = (window as unknown as { lumenSettings: SettingsApi }).lumenSettings;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cb = (id: string) => $<HTMLInputElement>(id);

const BACKENDS: Record<string, string> = {
  dpapi: "Windows Data Protection (DPAPI), tied to your Windows account",
  keychain: "the macOS Keychain",
  gnome_libsecret: "the Secret Service keyring (GNOME Keyring or compatible)",
  kwallet: "KWallet",
  kwallet5: "KWallet 5",
  kwallet6: "KWallet 6",
};

function pinMessage(kind: "error" | "success" | null, text = "") {
  const m = $("pin-msg");
  m.hidden = !kind;
  m.className = `alert ${kind === "error" ? "alert-error" : "alert-success"}`;
  m.textContent = text;
}

function render(v: View) {
  document.title = `${v.brand.name} — Desktop settings`;
  $("lock-status").textContent = v.lockEnabled ? "An app PIN is set. The app asks for it when it starts and after it locks." : "No app PIN is set.";
  $("current-field").hidden = !v.lockEnabled;
  $("pin-save").textContent = v.lockEnabled ? "Change PIN" : "Set PIN";
  $("pin-remove").hidden = !v.lockEnabled;
  $("lock-now").hidden = !v.lockEnabled;
  $("lock-options").hidden = !v.lockEnabled;
  const sel = $<HTMLSelectElement>("auto-lock");
  if (sel.options.length === 0) {
    for (const m of v.autoLockChoices) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = m === 0 ? "Never" : m === 1 ? "1 minute" : m === 60 ? "1 hour" : `${m} minutes`;
      sel.append(o);
    }
  }
  sel.value = String(v.settings.autoLockMinutes);
  cb("lock-suspend").checked = v.settings.lockOnSuspend;
  $("touchid-row").hidden = !v.touchIdAvailable;
  cb("touchid").checked = v.settings.touchId;

  const s = $("storage");
  s.className = `small alert ${v.storage.level === "os" ? "alert-success" : "alert-warning"}`;
  s.textContent =
    v.storage.level === "os"
      ? `Your session keys are encrypted with ${BACKENDS[v.storage.backend] ?? v.storage.backend}.`
      : v.storage.level === "basic"
        ? "No OS keyring is available (Secret Service / KWallet), so the keys are stored with a fixed, publicly known key — effectively unprotected. Install and unlock a keyring, then sign in again."
        : "No protected storage is available. Session keys stay in this app's browser storage only.";

  cb("close-to-tray").checked = v.settings.closeToTray;
  const oal = cb("open-at-login");
  oal.checked = v.settings.openAtLogin;
  oal.disabled = !v.openAtLoginSupported;
  if (!v.openAtLoginSupported) $("open-at-login-desc").textContent = "Not available on this platform: use your desktop environment's autostart settings.";
  cb("dnd").checked = v.settings.doNotDisturb;

  const facts = $("server-facts");
  facts.replaceChildren();
  const add = (k: string, val: string) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.className = "mono";
    dd.textContent = val;
    facts.append(dt, dd);
  };
  if (v.server) {
    add("Server", v.server.serverName);
    add("Homeserver", v.server.homeserverUrl);
  } else add("Server", "not set up");
  $("account").hidden = !v.server?.accountUrl;

  $("update-msg").textContent = v.update.message;
  $("update-check").hidden = ["disabled", "checking", "downloading", "downloaded"].includes(v.update.status);
  $("update-install").hidden = v.update.status !== "downloaded";
  $("about").textContent = `${v.brand.name} desktop ${v.appVersion} · Electron ${v.electronVersion}${v.packaged ? "" : " · development build"}`;
}

$<HTMLFormElement>("pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const current = $<HTMLInputElement>("pin-current");
  const next = $<HTMLInputElement>("pin-new");
  const repeat = $<HTMLInputElement>("pin-repeat");
  if (next.value !== repeat.value) return pinMessage("error", "The two new PINs don't match.");
  void api.setPin(current.closest(".field")?.hasAttribute("hidden") ? null : current.value, next.value).then(async (r) => {
    if (!r.ok) return pinMessage("error", r.error ?? "Couldn't set the PIN.");
    current.value = next.value = repeat.value = "";
    pinMessage("success", "PIN saved.");
    render(await api.get());
  });
});
$("pin-remove").addEventListener("click", () => {
  const current = $<HTMLInputElement>("pin-current");
  if (!current.value) return pinMessage("error", "Enter your current PIN to remove it.");
  void api.removePin(current.value).then(async (r) => {
    if (!r.ok) return pinMessage("error", r.error ?? "Couldn't remove the PIN.");
    current.value = "";
    pinMessage("success", "PIN removed. The app no longer locks.");
    render(await api.get());
  });
});
$("lock-now").addEventListener("click", () => void api.lockNow());
$<HTMLSelectElement>("auto-lock").addEventListener("change", (e) => void api.set({ autoLockMinutes: Number((e.target as HTMLSelectElement).value) }).then(render));
for (const [id, key] of [["lock-suspend", "lockOnSuspend"], ["touchid", "touchId"], ["close-to-tray", "closeToTray"], ["open-at-login", "openAtLogin"], ["dnd", "doNotDisturb"]] as const) {
  cb(id).addEventListener("change", (e) => void api.set({ [key]: (e.target as HTMLInputElement).checked }).then(render));
}
$("change-server").addEventListener("click", () => void api.changeServer());
$("account").addEventListener("click", () => api.openAccount());
$("update-check").addEventListener("click", () => void api.checkForUpdates());
$("update-install").addEventListener("click", () => void api.installUpdate());

api.onChanged(render);
void api.get().then(render);
