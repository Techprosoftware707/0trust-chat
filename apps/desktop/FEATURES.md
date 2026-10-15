# Desktop feature status

Legend:

- **Verified (Linux)**: exercised by `npm run test:e2e` against the dev stack, or by
  `npm run test:smoke` / the unit tests on the Linux build host. Linux runs the same main-process,
  preload and web-client code as Windows and macOS. It is evidence for the shared code, not for
  OS-specific behaviour.
- **CI (packaged)**: checked on the packaged app by `npm run test:smoke` on the GitHub runners
  (`windows-2025`, `macos-15` arm64, `ubuntu-24.04`). That covers fuses, bundle contents,
  refused debug switches and the in-app `--self-check`. No server is reachable from CI.
- **Expected**: implemented; the OS-specific part has not been run on that OS. It needs a device
  or a signed build.
- **Not available**: not supported on that OS, and the app says so.

Updated: 2026-10-15. "CI (packaged)" refers to run
[38704824180](https://github.com/Techprosoftware707/0trust-chat/actions/runs/38704824180), where
all three jobs are green: Windows 43/43, macOS 42/42, Linux 42/42 smoke checks; details in
[docs/apps/release-desktop.md](../../docs/apps/release-desktop.md#7-ci-evidence).

| Feature | Shared code (Linux evidence) | Windows | macOS |
|---|---|---|---|
| Bundled web client served from `app://lumen` (not from a server) | Verified (Linux): e2e (a); smoke: bundle contents | CI (packaged): self-check loads it from the asar | CI (packaged) |
| CSP header + enforcement | Verified (Linux): e2e checks the header, no CSP violations in any step; self-check: inline script blocked | CI (packaged) self-check | CI (packaged) self-check |
| Sandbox, context isolation, no Node in the renderer | Verified (Linux): self-check JS-level on the build host (root, so no OS sandbox there); CI (packaged, Linux): seccomp-bpf active in the renderer (`Seccomp: 2`) | CI (packaged): `app.getAppMetrics().sandboxed === true` | CI (packaged): `sandboxed === true` |
| Electron fuses | Verified (Linux): smoke reads them from the packaged binary | CI (packaged) | CI (packaged) |
| Asar integrity | Linux: no integrity check in Electron. The Windows exe's integrity resource was checked on Linux: it matches the asar header hash | CI (packaged): fuse on, app starts | CI (packaged): fuse on, app starts |
| Refuses debug / insecure switches in released builds | Verified (Linux): packaged binary exits 1 for `--remote-debugging-port`, `--inspect`, `--no-sandbox` | CI (packaged) | CI (packaged) |
| Navigation lock, window.open policy, external links https:/mailto: only | Verified (Linux): self-check (blocked navigation, denied window.open); unit tests (URL policy) | CI (packaged) self-check | CI (packaged) self-check |
| Permission policy (camera/mic/notifications only for the app origin) | Verified (Linux): e2e (call gets camera/mic through the handler, notifications permission granted); self-check (denied to other origins); unit tests | CI (packaged) self-check (denials) | CI (packaged) self-check (denials). The macOS TCC camera/mic prompt (`askForMediaAccess`) is **expected**: needs a device |
| Server picker + discovery (`io.lumen.app`, `/versions`, `/login`, `/rtc/transports`) | Verified (Linux): e2e (a) against lumen.test; unit tests with shared vectors | CI (packaged): picker renders | CI (packaged): picker renders |
| Build-time default server (`LUMEN_DEFAULT_SERVER`) | Verified (Linux): unit tests (parsing); not built with a default in e2e | Expected | Expected |
| Change server… (confirm, sign out on server, wipe, picker) | Verified (Linux): e2e (i); the native confirmation is answered by the test | Expected | Expected |
| SSO in the system browser with nonce; stray/replayed callbacks ignored | Verified (Linux): e2e (b), fresh portal login; the callback is delivered as a second launch (the Windows/Linux mechanism) | Expected: the NSIS installer registers `io.lumen.secure` in HKCU; not run | Expected: `CFBundleURLTypes` + `open-url`; not run |
| Encrypted DM both ways with web users | Verified (Linux): e2e (c), server sees only `m.room.encrypted` | Expected (same code) | Expected (same code) |
| Calls desktop↔web, E2EE label, media flowing | Verified (Linux): e2e (d), connected + "End-to-end encrypted" on both sides, inbound audio+video bytes > 0 | Expected | Expected |
| Screen share with the app's own source picker | Verified (Linux, X11/Xvfb): e2e (d), web peer receives the second video stream | Expected (desktopCapturer; system audio "loopback" only here) | Expected: needs the Screen Recording permission (the picker links to System Settings); not run |
| Store key in `safeStorage`, session sealed with it, no plaintext secrets on disk | Verified (Linux): e2e (h), scan of `userData` incl. decompressed LevelDB blocks, positive control. **Linux here = `basic_text` (no keyring): obfuscation only, warning shown** | CI (packaged): safeStorage available with DPAPI; the store-key round trip is **expected** (not run with a session on Windows) | Expected: Keychain (not touched by CI self-check to avoid a blocking prompt) |
| Keyring warning (Linux `basic_text`) | Verified (Linux): e2e (a) | Not available (DPAPI always present) | Not available |
| Sign-out wipes the store key + browser storage; token revoked | Verified (Linux): e2e (g) | Expected | Expected |
| OS notifications, previews hidden by default, click opens room | Verified (Linux): e2e (e), through D-Bus to a notification daemon, click via `ActionInvoked` | Expected (AppUserModelID `io.lumen.secure`, Start-menu shortcut from NSIS) | Expected (notification permission prompt on first use) |
| Do not disturb | Verified (Linux): e2e (e2) | Expected | Expected |
| Tray / menu-bar icon (Open, DND, Lock now, Settings, Quit); close keeps running; first-time hint | Verified (Linux): close→hidden and the hint notification (e); tray icon itself not visible under Xvfb | Expected | Expected (template image) |
| Application menu, shortcuts | Verified (Linux): menu items used by e2e (Settings, Change server) | Expected | Expected (app menu) |
| Unread badge | Linux: `setBadgeCount` only on Unity-style launchers (logged in e2e, not asserted) | Expected (taskbar overlay dot) | Expected (Dock badge) |
| Open at login (off by default) | Not available on Linux (the toggle says so) | Expected | Expected |
| Window state persistence | Verified (Linux): e2e (h) checks `settings.json` | Expected | Expected |
| Downloads with save dialog | Implemented (`will-download` + `setSaveDialogOptions`); not exercised (native dialog) | Expected | Expected |
| Spellcheck | Off on Linux: Chromium would fetch Hunspell dictionaries from Google | Expected (OS spellchecker) | Expected (OS spellchecker) |
| App lock: PIN, auto-lock, OS lock/suspend, content hidden | Verified (Linux): e2e (f), PIN set, lock, wrong PIN refused, unlock, `lock-screen` event, content `visibility:hidden` + `inert`, verifier not plaintext; unit tests (PBKDF2 600k, back-off) | Expected | Expected |
| Touch ID unlock | Not available | Not available | Expected: needs a Mac with Touch ID |
| Auto-update (signed builds only) | Not available on Linux (documented) | Expected: needs a signed build + feed. Unsigned CI builds show "Updates are disabled in unsigned builds." | Expected: needs a Developer ID build + feed |
| NSIS per-user installer, shortcuts, "Also delete my local data" on uninstall | The NSIS scripts incl. the custom page compile on Linux (Wine needed for the last step) | CI builds the installer (unsigned, 121.6 MB); **install/uninstall not run on a real machine** | Not available |
| DMG/ZIP arm64 + x64, hardened runtime, entitlements, notarization | — | Not available | CI builds DMG + ZIP for arm64 and x64, ad-hoc signed (no hardened runtime without a Developer ID); signing/notarization **not verified** (no Apple credentials) |
| MSIX/AppX | Config only (`npm run dist:win:appx`) | Not built yet (needs the Windows SDK) | Not available |

Known limitations (also in the release doc):

- Calls hosted on another homeserver's SFU (federated focus) are outside the app's CSP and fail
  in the desktop app.
- The OS-level renderer sandbox could not run on the Linux build host (root in a container). CI
  runs the packaged self-check unprivileged.
- Incoming-call OS notifications in the web client depend on the Page Visibility API. Hiding the
  window to the tray hides the page on Windows/macOS (expected). Under Xvfb without a window
  manager the page stays "visible", so this path is not exercised on Linux.
