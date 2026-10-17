/**
 * Browser helpers shared by the UI test (ui.test.mjs) and the screenshot gallery
 * (ui-gallery.mjs): test images, password sign-in through "another Matrix server",
 * secure-backup set-up, and message locators.
 */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

export const T = 30_000;

/** A small valid PNG, built with zlib — just test data. `fill(x, y)` returns [r, g, b]. */
export function makePng(w, h, fill) {
  const colour = typeof fill === "function" ? fill : () => fill;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(colour(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Signs `user` in on `page` through "Sign in to another Matrix server" with a password. */
export async function passwordSignIn(page, origin, user) {
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Sign in to another Matrix server" }).click();
  await page.getByLabel("Server name or URL").fill(origin);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Completes the secure-backup set-up dialog (already open); `onStep(name)` runs at each step
 * (the gallery takes screenshots there). Returns the recovery key.
 */
export async function setUpBackup(page, onStep = async () => undefined) {
  await onStep("intro");
  await page.getByRole("button", { name: "Continue" }).click();
  const key = (await page.locator(".recovery-key").textContent()).trim();
  assert.match(key, /^([A-Za-z0-9]{4} ){11}[A-Za-z0-9]{4}$/, "recovery key is shown in groups");
  await onStep("key");
  await page.getByLabel("I've saved my recovery key somewhere safe").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Recovery key").fill(key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"));
  await page.getByRole("button", { name: "Finish set-up" }).click();
  await page.getByText("That doesn't match the key shown").waitFor();
  await onStep("mismatch");
  await page.getByLabel("Recovery key").fill(key);
  await page.getByRole("button", { name: "Finish set-up" }).click();
  await page.getByText("Secure backup is set up").waitFor({ timeout: T });
  await onStep("done");
  await page.getByRole("button", { name: "Done" }).click();
  return key;
}

/** The message tile whose body contains `text`. */
export const msg = (page, text) => page.locator("article.msg", { has: page.locator(".msg-body", { hasText: text }) });

/** Hovers the message with `text` and clicks one of its actions (React, Reply, Edit, Delete). */
export async function hoverAction(page, text, action) {
  const m = msg(page, text).last();
  await m.hover();
  await m.getByRole("button", { name: action, exact: true }).click();
}
