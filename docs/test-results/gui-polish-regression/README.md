# Regression after the GUI polish and WireGuard auto-configuration (2026-10-17)

The full suite was run against the dev stack, which was redeployed from commit `01c7773` (portal image rebuilt, web chat rebuilt, host agent restarted). Each file is the raw output of one suite. `run-log.txt` lists the start time, end time and exit code of each suite.

| Suite | Result |
|---|---|
| Portal pytest | see `portal-unit.txt` (all passed) |
| Chat unit (vitest) | 107 passed |
| Chat typecheck + lint | clean |
| Chat E2EE (`test:e2ee`) | 5 passed, 0 failed |
| Chat UI (`test:ui`, production CSP) | 23 passed, 0 failed |
| Deployed E2EE (portal sign-up → SSO → encrypted DM → backup) | 7 passed, 0 failed |
| Portal / website / console UI | 75 passed, 0 failed |
| Calls: permissions / core / security / network | 3/3 · 18/18 · 5/5 · 7/7 |
| Desktop unit / Electron e2e | 34/34 · 11/11 |
| Federation (connect + denied) | 10/10 + 2/2 |
| WireGuard tunnel e2e | 8/8 |
| Mobile-app call widget harness | 12 passed, 0 failed (re-run after rebuilding the harness) |
| Security scan | 122 passed, 1 failed |

The single security-scan failure is "unexpected listeners: 127.0.0.1:8710". That port is a development server of the separate Nexus test branch, running on the same machine; it is not part of the Lumen stack. Re-run with the Nexus test containers stopped (same deployment): **123 passed, 0 failed** (`security-scan-rerun.txt`).

The mobile-app call widget harness (`tests/apps/widget-call.test.mjs`) could not run in the first pass, because its Rust binary had been removed from the build directory during disk clean-up. The binary was rebuilt (`cargo build --release --locked`, 16 min) and the test re-run on the same deployment: **12 passed, 0 failed** (`widget-call.txt`). That run covers native SSO, the capability allow-list, MatrixRTC through the Rust SDK, E2EE media keys, media in both directions, and hang-up.
