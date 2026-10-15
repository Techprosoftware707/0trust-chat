/**
 * 17: microphone/camera permission denied, and no capture device at all: the app must say
 * what's wrong in plain words and never present the microphone as live.
 *
 *   sudo NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt node tests/calls/permissions.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { leave } from "./lib/callui.mjs";
import { createDm, ensureLab, launchClient, makeReporter, openRoom, SHOTS, signIn, T } from "./lib/lab.mjs";

const rep = makeReporter("permissions");
const { log, step } = rep;
const shot = (c, name) => c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

ensureLab();
const B = await launchClient({ ns: "lab-b", label: "B", tone: 660 });
const clients = [B];
rep.failShots(() => clients);
let dm = "";

async function tryCall(X, kind) {
  await X.page.locator(".room-header").getByRole("button", { name: kind === "video" ? "Video call" : "Voice call" }).click();
  const lobby = X.page.getByRole("dialog");
  await lobby.getByRole("button", { name: /^Allow/ }).or(lobby.getByRole("alert").first()).first().waitFor({ timeout: T });
  if (await lobby.getByRole("button", { name: /^Allow/ }).count()) await lobby.getByRole("button", { name: /^Allow/ }).click();
  await lobby.getByRole("alert").first().waitFor({ timeout: T });
  return lobby;
}

try {
  await step("sign in B; DM with A", { always: true }, async () => {
    await signIn(B, "bob", "Bob Lumen");
  });

  await step("17a: permission denied → clear message in the lobby; joining listen-only never shows the mic as live", async () => {
    const X = await launchClient({ ns: "lab-a", label: "A-denied", tone: 440, permissions: [], fakeUi: false });
    clients.push(X);
    await signIn(X, "alice", "Alice Lumen");
    dm = await createDm(X, B);
    await openRoom(X, dm);
    const lobby = await tryCall(X, "video");
    await lobby.getByRole("button", { name: /Start call without microphone/ }).waitFor({ timeout: T });
    await lobby.getByRole("alert").nth(1).waitFor({ timeout: T });
    const alerts = (await lobby.getByRole("alert").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    log("lobby errors:", alerts);
    assert.ok(alerts.some((t) => /microphone is blocked/i.test(t)), "microphone permission message");
    assert.ok(alerts.some((t) => /camera is blocked/i.test(t)), "camera permission message");
    assert.equal(await lobby.getByRole("button", { name: "Microphone unavailable" }).count(), 1, "mic toggle shows unavailable");
    const start = lobby.getByRole("button", { name: /Start call without microphone/ });
    assert.equal(await start.count(), 1, "offers to start without microphone, explicitly");
    await shot(X, "desktop-light-permission-denied");
    await start.click();
    await X.page.locator('.call-screen[data-phase="connected"]').waitFor({ timeout: T });
    await X.page.locator(".call-banner", { hasText: "Others can't hear you" }).waitFor({ timeout: T });
    assert.equal(await X.page.getByRole("button", { name: "Mute microphone" }).count(), 0, "never offers 'mute' (i.e. never shows the mic as live)");
    assert.equal(await X.page.getByRole("button", { name: /Microphone unavailable/ }).count(), 1);
    const banner = await X.page.locator(".call-banner", { hasText: "Others can't hear you" }).innerText();
    log(`in-call banner: ${banner.replace(/\s+/g, " ")}`);
    await shot(X, "desktop-light-in-call-no-mic");
    // B (who joins normally) sees X with the microphone off, not "on"
    await B.page.locator(".incoming-call").getByRole("button", { name: "Accept" }).click({ timeout: T });
    await B.page.locator(`.call-tile[data-participant="${X.userId}"]`).waitFor({ timeout: T });
    assert.equal(await B.page.locator(`.call-tile[data-participant="${X.userId}"]`).getAttribute("data-mic"), "muted");
    log("B sees X's microphone as: muted (no track published)");
    await leave(X);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    await X.browser.close();
    clients.pop();
  });

  await step("17b: no capture devices at all → 'no microphone/camera found' messages", async () => {
    const X = await launchClient({ ns: "lab-a", label: "A-nodev", tone: 440, fakeDevices: false });
    clients.push(X);
    await signIn(X, "alice", "Alice Lumen");
    await openRoom(X, dm);
    const lobby = await tryCall(X, "video");
    await lobby.getByRole("alert").nth(1).waitFor({ timeout: T });
    const alerts = (await lobby.getByRole("alert").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    log("lobby errors:", alerts);
    assert.ok(alerts.some((t) => /No microphone was found/i.test(t)), "no-microphone message");
    assert.ok(alerts.some((t) => /No camera was found/i.test(t)), "no-camera message");
    await shot(X, "desktop-light-no-devices");
    await X.page.setViewportSize({ width: 390, height: 844 });
    await shot(X, "mobile-light-no-devices");
    await lobby.getByRole("button", { name: "Cancel" }).click();
    await X.browser.close();
    clients.pop();
  });
} finally {
  rep.finish();
  for (const c of clients) await c.browser.close().catch(() => undefined);
}
