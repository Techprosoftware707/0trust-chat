/** Application menu with the standard Edit/View/Window roles and keyboard shortcuts. */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { brandOf } from "../core/discovery.ts";
import { ctx } from "./context.ts";
import { getServerProfile } from "./store.ts";
import { openExternalSafe, openSettingsWindow } from "./windows.ts";

export interface MenuActions {
  changeServer(): void;
  lockNow(): void;
  lockAvailable(): boolean;
  quit(): void;
}

export function buildMenu(a: MenuActions): void {
  const mac = process.platform === "darwin";
  const p = getServerProfile();
  const brand = brandOf(p).name;
  const dev = !app.isPackaged;
  const desktopItems: MenuItemConstructorOptions[] = [
    { label: mac ? "Settings…" : "Desktop settings…", accelerator: "CmdOrCtrl+,", click: () => openSettingsWindow() },
    { label: "Lock now", accelerator: "CmdOrCtrl+Shift+L", enabled: a.lockAvailable() && !ctx.locked, click: () => a.lockNow() },
    { label: "Change server…", enabled: !!p, click: () => a.changeServer() },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: brand,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              ...desktopItems,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { label: `Quit ${brand}`, accelerator: "Cmd+Q", click: () => a.quit() },
            ],
          },
        ]
      : [
          {
            label: "&File",
            submenu: [...desktopItems, { type: "separator" as const }, { role: "close" as const }, { label: "Quit", accelerator: "Ctrl+Q", click: () => a.quit() }],
          },
        ]),
    { role: "editMenu" },
    {
      label: "&View",
      submenu: [
        { role: "reload" },
        ...(dev ? [{ role: "forceReload" as const }, { role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(p?.lumen?.help_url ? [{ label: "Help center", click: () => void openExternalSafe(p.lumen!.help_url!) }] : []),
        ...(p?.lumen?.privacy_url ? [{ label: "Privacy", click: () => void openExternalSafe(p.lumen!.privacy_url!) }] : []),
        ...(mac ? [] : [{ type: "separator" as const }, { role: "about" as const, label: `About ${brand}` }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({ applicationName: brand, applicationVersion: app.getVersion(), copyright: "AGPL-3.0-or-later" });
}
