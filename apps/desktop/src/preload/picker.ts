/** Preload of the screen-share source picker (app://desktop/picker.html). */
import { contextBridge, ipcRenderer } from "electron";

if (window.location.href.split(/[?#]/)[0] === "app://desktop/picker.html") {
  contextBridge.exposeInMainWorld("lumenPicker", {
    sources: () => ipcRenderer.invoke("picker:sources"),
    choose: (id: string | null, audio: boolean) => ipcRenderer.send("picker:choose", id === null ? null : String(id), audio === true),
    openPrivacySettings: () => ipcRenderer.send("picker:open-privacy-settings"),
  });
}
