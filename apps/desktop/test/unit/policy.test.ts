import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveAppPath, mimeFor } from "../../src/core/app-path.ts";
import { buildDesktopPageCsp, buildWebClientCsp, connectSources } from "../../src/core/csp.ts";
import { allowDisplayMediaRequest, allowPermissionCheck, allowPermissionRequest } from "../../src/core/permissions.ts";
import { forbiddenSwitchesIn } from "../../src/core/switches.ts";
import { isSafeExternalUrl, isValidServerName, validateLinkUrl, validateLivekitUrl } from "../../src/core/url.ts";

test("web client CSP: script-src self + wasm, no unsafe-inline/eval, connect-src limited to configured origins", () => {
  const csp = buildWebClientCsp({
    homeserverUrl: "https://matrix.example.com",
    livekitUrls: ["wss://rtc.example.com", "wss://rtc.example.com/x"],
    portalUrl: "https://example.com/accounts/signup/",
  });
  assert.equal(
    csp,
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; " +
      "connect-src 'self' https://matrix.example.com wss://rtc.example.com https://rtc.example.com https://example.com blob:; " +
      "worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  );
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|\*|https: |wss: /);
  // before a server is configured
  assert.deepEqual(connectSources({ homeserverUrl: null, livekitUrls: [], portalUrl: null }), ["'self'", "blob:"]);
});

test("desktop pages CSP has no network access", () => {
  const csp = buildDesktopPageCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'self';/);
});

const APP = { origin: "app://lumen", fromAppWindow: true, isMainFrame: true };

test("permission requests: media/notifications only for the app origin's top frame", () => {
  assert.equal(allowPermissionRequest({ ...APP, permission: "media", mediaTypes: ["audio", "video"] }), true);
  assert.equal(allowPermissionRequest({ ...APP, permission: "notifications" }), true);
  assert.equal(allowPermissionRequest({ ...APP, permission: "clipboard-sanitized-write" }), true);
  for (const p of ["geolocation", "clipboard-read", "midi", "midiSysex", "hid", "usb", "serial", "idle-detection", "openExternal", "pointerLock", "keyboardLock", "window-management", "storage-access", "display-capture", "unknown", "mediaKeySystem"]) {
    assert.equal(allowPermissionRequest({ ...APP, permission: p }), false, p);
  }
  assert.equal(allowPermissionRequest({ ...APP, permission: "media", mediaTypes: ["audio", "screen"] }), false);
  assert.equal(allowPermissionRequest({ ...APP, origin: "app://desktop", permission: "media", mediaTypes: ["audio"] }), false);
  assert.equal(allowPermissionRequest({ ...APP, origin: "https://matrix.example.com", permission: "notifications" }), false);
  assert.equal(allowPermissionRequest({ ...APP, origin: "app://lumen.evil", permission: "notifications" }), false);
  assert.equal(allowPermissionRequest({ ...APP, isMainFrame: false, permission: "media", mediaTypes: ["audio"] }), false);
  assert.equal(allowPermissionRequest({ ...APP, fromAppWindow: false, permission: "media", mediaTypes: ["audio"] }), false);
  assert.equal(allowPermissionRequest({ ...APP, origin: null, permission: "media", mediaTypes: ["audio"] }), false);
});

test("permission checks and display media", () => {
  assert.equal(allowPermissionCheck({ ...APP, permission: "media" }), true);
  assert.equal(allowPermissionCheck({ ...APP, permission: "geolocation" }), false);
  assert.equal(allowPermissionCheck({ ...APP, origin: "app://desktop", permission: "notifications" }), false);
  assert.equal(allowDisplayMediaRequest({ ...APP, userGesture: true }), true);
  assert.equal(allowDisplayMediaRequest({ ...APP, userGesture: false }), false);
  assert.equal(allowDisplayMediaRequest({ ...APP, origin: "app://desktop", userGesture: true }), false);
  assert.equal(allowDisplayMediaRequest({ ...APP, isMainFrame: false, userGesture: true }), false);
});

test("app:// path resolution refuses traversal", () => {
  const root = path.resolve("/srv/web");
  assert.equal(resolveAppPath(root, "/"), path.join(root, "index.html"));
  assert.equal(resolveAppPath(root, "/assets/index-AbC_1.js"), path.join(root, "assets/index-AbC_1.js"));
  assert.equal(resolveAppPath(root, "/brand/logo.svg"), path.join(root, "brand/logo.svg"));
  for (const bad of [
    "/../etc/passwd",
    "/assets/../../etc/passwd.txt",
    "/%2e%2e/%2e%2e/etc/passwd.txt",
    "/assets/%2e%2e%2f%2e%2e%2fsecret.json",
    "/assets%2f..%2f..%2fx.js",
    "/assets/..%5c..%5cwin.ini.txt",
    "/assets\\..\\x.js",
    "/C:/Windows/win.ini.txt",
    "//server/share/x.js",
    "/x.js%00.png",
    "/.env.json",
    "/assets/.hidden.js",
    "/index.exe",
    "/no-extension",
    "relative.js",
    "/%E0%A4%A.js",
  ]) {
    assert.equal(resolveAppPath(root, bad), null, bad);
  }
  assert.equal(mimeFor("a.wasm"), "application/wasm");
  assert.equal(mimeFor("a.exe"), null);
});

test("URL helpers", () => {
  assert.equal(isSafeExternalUrl("https://example.com/x"), true);
  assert.equal(isSafeExternalUrl("mailto:a@example.com"), true);
  for (const bad of ["http://example.com", "file:///etc/passwd", "smb://host/share", "javascript:alert(1)", "ms-settings:", "io.lumen.secure:/x", "https://u:p@x.com", "notaurl"]) {
    assert.equal(isSafeExternalUrl(bad), false, bad);
  }
  assert.equal(validateLivekitUrl("wss://rtc.example.com/", { debug: false }), "wss://rtc.example.com");
  assert.equal(validateLivekitUrl("https://rtc.example.com", { debug: false }), null);
  assert.equal(validateLivekitUrl("ws://localhost:7880", { debug: false }), null);
  assert.equal(validateLinkUrl("https://example.com/docs/?a=1", { debug: false }), "https://example.com/docs/?a=1");
  assert.equal(isValidServerName("lumen.test"), true);
  assert.equal(isValidServerName("[::1]:8448"), true);
  assert.equal(isValidServerName("a_b.com"), false);
});

test("packaged builds refuse debugging / insecure switches", () => {
  assert.deepEqual(forbiddenSwitchesIn(["/app/lumen", "--remote-debugging-port=9222", "--inspect", "--foo", "io.lumen.secure:/x"]).sort(), ["inspect", "remote-debugging-port"]);
  assert.deepEqual(forbiddenSwitchesIn(["--IGNORE-CERTIFICATE-ERRORS"]), ["ignore-certificate-errors"]);
  assert.deepEqual(forbiddenSwitchesIn(["--use-fake-ui-for-media-stream", "--no-sandbox"]).sort(), ["no-sandbox", "use-fake-ui-for-media-stream"]);
  assert.deepEqual(forbiddenSwitchesIn(["--ozone-platform=wayland", "--enable-features=WaylandWindowDecorations", "--lang=de"]), []);
});
