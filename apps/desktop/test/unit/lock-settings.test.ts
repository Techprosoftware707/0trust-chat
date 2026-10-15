import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, createPinVerifier, parsePinVerifier, PIN_ITERATIONS, pinProblem, verifyPin } from "../../src/core/pin.ts";
import { DEFAULT_SETTINGS, fitWindowState, parseSettings } from "../../src/core/settings.ts";

test("PIN verifier: PBKDF2-SHA-256 with 600 000 iterations and a random salt", async () => {
  assert.equal(PIN_ITERATIONS, 600_000);
  const a = await createPinVerifier("123456");
  const b = await createPinVerifier("123456");
  assert.equal(a.iterations, 600_000);
  assert.equal(a.alg, "PBKDF2-SHA-256");
  assert.notEqual(a.salt, b.salt, "random salt");
  assert.notEqual(a.hash, b.hash);
  assert.equal(Buffer.from(a.hash, "base64").length, 32);
  assert.equal(await verifyPin("123456", a), true);
  assert.equal(await verifyPin("123457", a), false);
  assert.equal(await verifyPin("", a), false);
  assert.ok(!JSON.stringify(a).includes("123456"), "the PIN itself is not stored");
});

test("PIN verifier: known-answer check against node:crypto pbkdf2Sync", async () => {
  const { pbkdf2Sync } = await import("node:crypto");
  const v = await createPinVerifier("correct horse", 100_000);
  const expect = pbkdf2Sync("correct horse", Buffer.from(v.salt, "base64"), 100_000, 32, "sha256").toString("base64");
  assert.equal(v.hash, expect);
});

test("PIN rules and verifier parsing", async () => {
  assert.match(pinProblem("12345") ?? "", /at least 6/);
  assert.equal(pinProblem("123456"), null);
  assert.match(pinProblem("x".repeat(65)) ?? "", /at most/);
  assert.match(pinProblem("123\n456") ?? "", /characters/);
  await assert.rejects(createPinVerifier("1"), /at least/);
  const v = await createPinVerifier("abcdef", 100_000);
  assert.deepEqual(parsePinVerifier(JSON.parse(JSON.stringify(v))), v);
  assert.equal(parsePinVerifier({ ...v, iterations: 1 }), null, "weakened iteration count is refused");
  assert.equal(parsePinVerifier({ ...v, alg: "MD5" }), null);
  assert.equal(parsePinVerifier({ ...v, hash: "AAAA" }), null);
  assert.equal(parsePinVerifier(null), null);
});

test("lock-screen back-off", () => {
  assert.deepEqual([0, 1, 4].map(backoffMs), [0, 0, 0]);
  assert.equal(backoffMs(5), 30_000);
  assert.equal(backoffMs(6), 60_000);
  assert.equal(backoffMs(50), 15 * 60_000);
});

test("settings: defaults and validation", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.openAtLogin, false, "open at login is off by default");
  const s = parseSettings({ closeToTray: false, autoLockMinutes: 7, openAtLogin: "yes", window: { x: 1, y: 2, width: 100, height: 100 }, pinFailures: -1 });
  assert.equal(s.closeToTray, false);
  assert.equal(s.autoLockMinutes, 5, "unknown choice falls back");
  assert.equal(s.openAtLogin, false);
  assert.equal(s.window, null, "too small");
  assert.equal(s.pinFailures, 0);
  assert.equal(parseSettings({ autoLockMinutes: 0 }).autoLockMinutes, 0);
  assert.equal(parseSettings({ autoLockMinutes: 15 }).autoLockMinutes, 15);
});

test("window state is only restored onto a visible display", () => {
  const w = { x: 100, y: 100, width: 1000, height: 700, maximized: false };
  assert.deepEqual(fitWindowState(w, [{ x: 0, y: 0, width: 1920, height: 1080 }]), w);
  assert.equal(fitWindowState({ ...w, x: 5000 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]), null);
});
