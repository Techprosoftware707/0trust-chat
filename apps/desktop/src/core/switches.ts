/**
 * Command-line switches a packaged (released) build refuses to start with. They would let
 * another local program drive or weaken the app: attach a debugger to the renderer (which can
 * read the store key through the preload API, sidestepping the Keychain/DPAPI protection),
 * accept invalid certificates, turn off web security or grant camera/microphone without the
 * app's permission handler. Node's own --inspect flags are additionally disabled by the
 * Electron fuses. Unpackaged development runs (the test harness) are not affected.
 */
export const FORBIDDEN_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "ignore-urlfetcher-cert-requests",
  "disable-web-security",
  "allow-running-insecure-content",
  "unsafely-treat-insecure-origin-as-secure",
  "use-fake-ui-for-media-stream",
  "use-fake-device-for-media-stream",
  "auto-select-desktop-capture-source",
  "auto-accept-camera-and-microphone-capture",
  "js-flags",
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-seccomp-filter-sandbox",
  "load-extension",
] as const;

/** Returns the forbidden switches present in argv (`--name` or `--name=value`, case-insensitive). */
export function forbiddenSwitchesIn(argv: readonly string[]): string[] {
  const found = new Set<string>();
  for (const a of argv) {
    if (typeof a !== "string" || !a.startsWith("--")) continue;
    const name = a.slice(2).split("=")[0]!.toLowerCase();
    if ((FORBIDDEN_SWITCHES as readonly string[]).includes(name)) found.add(name);
  }
  return [...found];
}
