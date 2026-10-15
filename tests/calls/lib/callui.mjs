/** Driving the call UI of the real app (shared by the call test files). */
import assert from "node:assert/strict";
import { T } from "./lab.mjs";

/** Opens the lobby from the room header and starts (or joins) the call. */
export async function startFromHeader(client, kind = "audio", { join = false } = {}) {
  const page = client.page;
  if (join) await page.locator(".room-header").getByRole("button", { name: /Join the call/ }).click({ timeout: T });
  else await page.locator(".room-header").getByRole("button", { name: kind === "video" ? "Video call" : "Voice call" }).click({ timeout: T });
  const lobby = page.getByRole("dialog");
  await lobby.waitFor({ timeout: T });
  const allow = lobby.getByRole("button", { name: /^Allow/ });
  const start = lobby.getByRole("button", { name: /(Start|Join) call/ });
  await allow.or(start).first().waitFor({ timeout: T });
  if (await allow.count()) await allow.click();
  // wait until the devices are running (or failed), then start
  await page.waitForFunction(() => !document.querySelector("dialog .spinner"), null, { timeout: T });
  if (join && kind === "video" && !(await lobby.locator("video").count())) await lobby.getByRole("button", { name: "Turn camera on" }).click();
  if (kind === "video") await lobby.locator("video").waitFor({ timeout: T }).catch(() => undefined);
  await start.click();
  await page.locator(".call-screen").waitFor({ timeout: T });
}

/** Accepts the incoming-call card ("Accept"/"Join" = voice, "Video"/"Join with video"). */
export async function acceptIncoming(client, kind = "audio") {
  const card = client.page.locator(".incoming-call").first();
  await card.waitFor({ timeout: T });
  const name = kind === "video" ? /^(Video|Join with video)$/ : /^(Accept|Join)$/;
  await card.getByRole("button", { name }).click();
  await client.page.locator(".call-screen").waitFor({ timeout: T });
}

export async function waitPhase(client, phase, timeout = T) {
  await client.page.locator(`.call-screen[data-phase="${phase}"]`).waitFor({ timeout });
}

/** Waits for the green "End-to-end encrypted" badge (all remote media decrypting). */
export async function waitE2EE(client, timeout = 45_000) {
  await client.page.locator('[data-testid="call-e2ee"]').waitFor({ timeout });
}

/** Remote tiles currently connected (not pending), by Matrix user id. */
export async function remoteTiles(client) {
  return client.page.$$eval(".call-screen .call-tile:not(.pending)", (els) =>
    els.map((e) => ({ user: e.dataset.participant, enc: e.dataset.encryption, key: e.dataset.keyIndex, mic: e.dataset.mic, label: e.getAttribute("aria-label") })),
  );
}

export async function waitRemoteCount(client, n, timeout = T) {
  await client.page.waitForFunction(
    (n) => document.querySelectorAll(".call-screen audio[data-call-audio][data-source=microphone]").length >= n,
    n,
    { timeout },
  );
}

export async function leave(client) {
  const btn = client.page.getByRole("button", { name: "Leave call" });
  if (await btn.count()) await btn.click();
  await client.page
    .locator(".call-screen")
    .waitFor({ state: "detached", timeout: T })
    .catch(() => undefined);
}

export async function openPanel(client, name) {
  const btn = client.page.locator(".call-top").getByRole("button", { name });
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
}

/** The app's own diagnostics values (data-k attributes), for cross-checking with raw getStats. */
export async function diagnostics(client) {
  await openPanel(client, "Call diagnostics");
  return client.page.$$eval(".diag [data-k]", (els) => els.map((e) => ({ k: e.dataset.k, v: e.textContent.trim(), dir: e.closest(".diag-stream")?.dataset.dir ?? null, kind: e.closest(".diag-stream")?.dataset.kind ?? null })));
}

export function expectTone(heard, userId, hz, label) {
  const row = heard.find((h) => h.participant === userId);
  assert.ok(row, `${label}: no audio element for ${userId} (got ${JSON.stringify(heard)})`);
  assert.ok(row.medianPeakHz !== null && Math.abs(row.medianPeakHz - hz) <= 15, `${label}: expected ~${hz} Hz from ${userId}, measured ${row.medianPeakHz} Hz (${JSON.stringify(row)})`);
  assert.ok(row.audibleFraction >= 0.6, `${label}: tone audible only ${row.audibleFraction * 100}% of the time`);
  return row;
}
