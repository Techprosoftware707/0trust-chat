/** Preload of the desktop settings window (app://desktop/settings.html). */
import { contextBridge, ipcRenderer } from "electron";

if (window.location.href.split(/[?#]/)[0] === "app://desktop/settings.html") {
  contextBridge.exposeInMainWorld("lumenSettings", {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:set", { ...patch }),
    setPin: (current: string | null, next: string) => ipcRenderer.invoke("settings:set-pin", current, String(next)),
    removePin: (current: string) => ipcRenderer.invoke("settings:remove-pin", String(current)),
    lockNow: () => ipcRenderer.invoke("settings:lock-now"),
    changeServer: () => ipcRenderer.invoke("settings:change-server"),
    checkForUpdates: () => ipcRenderer.invoke("settings:check-updates"),
    installUpdate: () => ipcRenderer.invoke("settings:install-update"),
    openAccount: () => ipcRenderer.send("settings:open-account"),
    openAccountDelete: () => ipcRenderer.send("settings:open-account-delete"),
    onChanged: (cb: (view: unknown) => void) => {
      const l = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on("settings:changed", l);
      return () => ipcRenderer.off("settings:changed", l);
    },
  });
}
