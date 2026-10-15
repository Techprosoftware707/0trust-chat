/** Preload of the lock screen (app://desktop/lock.html): unlock with PIN or Touch ID only. */
import { contextBridge, ipcRenderer } from "electron";

if (window.location.href.split(/[?#]/)[0] === "app://desktop/lock.html") {
  contextBridge.exposeInMainWorld("lumenLock", {
    state: () => ipcRenderer.invoke("lock:state"),
    unlock: (pin: string) => ipcRenderer.invoke("lock:unlock", String(pin)),
    touchId: () => ipcRenderer.invoke("lock:touch-id"),
  });
}
