# Lumen apps — Windows, macOS, Android, iOS/iPadOS

| Document | Contents |
|---|---|
| [ADR 0003](../adr/0003-client-apps.md) | Why the apps are built the way they are: Electron desktop shipping the web client; native Compose / SwiftUI on the Matrix Rust SDK; calls through Lumen's call widget; push via Sygnal; per-OS secret storage |
| [integration.md](integration.md) | The server contract every app implements: discovery, SSO, E2EE, calls and widget bridge, push, deep links |
| [feature-matrix.md](feature-matrix.md) | Per-platform status of every feature: implemented, tested where, or not available |
| [release.md](release.md) | CI/CD, versions, signing secrets, release and verification |
| [release-desktop.md](release-desktop.md) · [release-android.md](release-android.md) · [release-ios.md](release-ios.md) | Store and distribution steps per platform |

Source:

| Path | App |
|---|---|
| `apps/desktop/` | Windows and macOS (Electron); also builds for Linux (AppImage, deb) |
| `apps/android/` | Android (Kotlin, Jetpack Compose) |
| `apps/ios/` | iPhone and iPad (Swift, SwiftUI) |
| `apps/shared/` | test vectors every app must pass |
| `services/chat/` | the web client, also shipped inside the desktop app; its call module is also built as the mobile call widget |
| `design/` | tokens (CSS source and generated Kotlin/Swift), fonts, icons |
