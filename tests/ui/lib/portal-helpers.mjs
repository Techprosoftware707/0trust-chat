/**
 * Shared helpers for the browser tests and the screenshot gallery of the public website,
 * the customer portal and the operator console (tests/ui/portal.e2e.mjs, tests/ui/portal-gallery.mjs).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { importChatDep } from "../../chat/lib/deps.mjs";

// --- TOTP (RFC 6238) ------------------------------------------------------------------------
export function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** A code from a 30 s window that has not been used yet (allauth rejects code reuse). */
export async function freshTotp(secret, lastWindow) {
  let w = Math.floor(Date.now() / 30000);
  if (w === lastWindow) {
    await new Promise((r) => setTimeout(r, (w + 1) * 30000 - Date.now() + 500));
    w = Math.floor(Date.now() / 30000);
  }
  return { code: totp(secret), window: w };
}

// --- browser ----------------------------------------------------------------------------------
/** Launches Chromium with every name under `base` resolved to this host. */
export async function launchBrowser(base) {
  const pw = await importChatDep("playwright");
  const chromium = pw.chromium ?? pw.default.chromium;
  const noProxy = [process.env.no_proxy || process.env.NO_PROXY, base, `.${base}`, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  return chromium.launch({
    args: [`--host-resolver-rules=MAP ${base} 127.0.0.1, MAP *.${base} 127.0.0.1`],
    env: { ...process.env, no_proxy: noProxy, NO_PROXY: noProxy },
  });
}

/** Records console errors, CSP violations, uncaught errors and 5xx responses of `base` hosts. */
export function watch(p, problems, base) {
  p.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  p.on("response", (r) => {
    const u = new URL(r.url());
    if (u.hostname.endsWith(base) && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
}

/** Returns { sw, cw, culprit } for the page's horizontal overflow (content in scroll boxes is fine). */
export async function measureOverflow(page) {
  return page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(a).overflowX)) return true;
      return false;
    };
    let culprit = "";
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > cw + 1 && getComputedStyle(el).position !== "fixed" && !clipped(el)) {
        culprit = `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} right=${Math.round(r.right)}`;
        break;
      }
    }
    return { sw: document.documentElement.scrollWidth, cw, culprit };
  });
}
export async function noOverflow(page) {
  const { sw, cw, culprit } = await measureOverflow(page);
  assert.ok(sw <= cw + 1, `horizontal overflow ${sw}px > ${cw}px (${culprit})`);
}

export async function fill(page, sel, value) {
  await page.locator(sel).fill(value);
}
export async function submit(page, sel = "main form button[type=submit]") {
  await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator(sel).first().click()]);
  await page.waitForLoadState("domcontentloaded");
}
/** Completes allauth's step-up (re-authentication) prompt if it is shown. */
export async function passReauth(page, password) {
  if (!/\/accounts\/reauthenticate\//.test(page.url())) return false;
  await fill(page, "input[name=password]", password);
  await submit(page);
  return true;
}
