/**
 * Screenshot gallery and design audit of the public website, the customer portal and the
 * operator console of a running Lumen stack (TLS_MODE=internal test install).
 *
 *   sudo node tests/ui/portal-gallery.mjs --set before|after [--base lumen.test]
 *        [--only <regex>] [--quick] [--curate <dir>] [--curate-only] [--reset]
 *
 * Every page is captured at 360x740, 390x844, 768x1024, 1024x768, 1280x800 and 1920x1080 in the
 * light theme, at 390 and 1280 in the dark theme, and at 1280x800 with 200 % zoom (a 640x400 CSS
 * viewport at device scale 2). --quick keeps only 390 and 1280 (light) and 1280 (dark).
 *
 * Each capture is also audited: horizontal overflow, touch targets under 44x44 px (on touch-sized
 * viewports), WCAG AA text contrast, unlabeled form controls, images without alt, heading
 * structure and a visible keyboard focus indicator. Results: tests/ui/output/gallery/<set>/audit.{json,md}.
 *
 * Personas (created once, kept in tests/ui/output/gallery/state/ and re-used by later runs so
 * "before" and "after" show the same data): a brand-new account, a busy account (TOTP, recovery
 * codes, a workspace with a member and pending invitations, support requests, security events),
 * a workspace member, and an operator (needs root for `lumenctl create-operator`).
 * The portal allows 10 sign-ups per hour per IP; a fresh setup uses 3.
 *
 * --curate <dir> copies the curated set (CURATED below) to <dir>, palette-quantised to stay small;
 * with --curate-only it only does that, from the shots of an earlier run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fill, freshTotp, launchBrowser, measureOverflow, passReauth, submit, watch } from "./lib/portal-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const base = opt("--base", "lumen.test");
const set = opt("--set", "current");
const only = opt("--only", "") ? new RegExp(opt("--only", "")) : null;
const quick = args.includes("--quick");
const curateDir = opt("--curate", "");
const curateOnly = args.includes("--curate-only");
const site = `https://${base}`;
const ops = `https://ops.${base}:8443`;
const GALLERY = path.join(HERE, "output", "gallery");
const OUT = path.join(GALLERY, set);
const STATE_DIR = path.join(GALLERY, "state");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
if (args.includes("--reset")) fs.rmSync(path.join(STATE_DIR, "state.json"), { force: true });

const VIEWPORTS = {
  "360": { width: 360, height: 740 },
  "390": { width: 390, height: 844 },
  "768": { width: 768, height: 1024 },
  "1024": { width: 1024, height: 768 },
  "1280": { width: 1280, height: 800 },
  "1920": { width: 1920, height: 1080 },
  zoom200: { width: 640, height: 400, zoom: 2 },
};
const SHOTS = quick
  ? [["390", "light"], ["1280", "light"], ["1280", "dark"]]
  : [["360", "light"], ["390", "light"], ["768", "light"], ["1024", "light"], ["1280", "light"], ["1920", "light"], ["390", "dark"], ["1280", "dark"], ["zoom200", "light"]];

// --- curated set (docs/test-results/ui-polish/portal/<set>/) ------------------------------------
const CURATED = [
  "site-home--1280-light", "site-home--390-light", "site-home--1280-dark", "site-features--768-light",
  "site-security--390-dark", "site-pricing--1280-light", "site-docs-article--1024-light", "site-contact--1280-dark",
  "auth-signup--1280-light", "auth-signup-error--390-light", "auth-login--390-dark", "auth-mfa-prompt--1280-light",
  "auth-password-reset--1280-light", "auth-email-confirm--390-light", "portal-dashboard-new--1280-light",
  "portal-dashboard-busy--1280-light", "portal-dashboard-busy--390-light", "portal-dashboard-busy--1280-dark",
  "portal-dashboard-busy--zoom200-light", "portal-workspaces--1280-light", "portal-workspace-detail--1280-light",
  "portal-workspace-detail--390-dark", "portal-workspace-billing--1024-light", "portal-invitation--390-light",
  "portal-security--1280-light", "portal-sessions--1280-light", "portal-recovery-codes--768-light",
  "portal-profile--390-light", "portal-privacy--1280-dark", "portal-support--1280-light", "error-404--1280-light",
  "error-403--390-dark", "error-429--1280-light", "error-500--1280-dark", "ops-dashboard--1280-light",
  "ops-dashboard--390-dark", "ops-users--1280-light", "ops-user-detail--1280-light", "ops-calls-selftest--1280-light",
  "ops-wireguard--1280-light",
];

// --- state ------------------------------------------------------------------------------------
const statePath = path.join(STATE_DIR, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const storage = (who) => path.join(STATE_DIR, `${who}.json`);

const browser = curateOnly ? null : await launchBrowser(base);
const problems = [];
async function newContext(who, opts = {}) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
    ...(who && fs.existsSync(storage(who)) ? { storageState: storage(who) } : {}),
    ...opts,
  });
  ctx.on("page", (p) => watch(p, problems, base));
  return ctx;
}
const log = (...a) => console.log(...a);

// --- persona setup ----------------------------------------------------------------------------
async function signUp(page, { username, display, email, password }, next = "") {
  await page.goto(site + "/accounts/signup/" + (next ? `?next=${encodeURIComponent(next)}` : ""));
  await fill(page, "input[name=username]", username);
  if (display) await fill(page, "input[name=display_name]", display);
  await fill(page, "input[name=email]", email);
  await fill(page, "input[name=password1]", password);
  await fill(page, "input[name=password2]", password);
  await page.locator("input[name=accept_terms]").check();
  await submit(page);
  if (await page.getByRole("heading", { name: "Too many attempts" }).count())
    throw new Error("sign-up limit (10/hour/IP) used up: clear the allauth rate-limit cache on the test host");
}
async function signIn(page, origin, acct) {
  await page.goto(origin + "/accounts/login/");
  await fill(page, "input[name=login]", acct.username);
  await fill(page, "input[name=password]", acct.password);
  await submit(page);
  if (/\/accounts\/2fa\/authenticate\//.test(page.url())) {
    const t = await freshTotp(acct.totp, acct.lastWindow ?? -1);
    acct.lastWindow = t.window;
    await fill(page, "input[name=code]", t.code);
    await submit(page);
  }
}
async function enableTotp(page, acct, origin = site) {
  await page.goto(origin + "/accounts/2fa/totp/activate/");
  await passReauth(page, acct.password);
  acct.totp = await page.locator("#authenticator_secret").inputValue();
  const t = await freshTotp(acct.totp, acct.lastWindow ?? -1);
  acct.lastWindow = t.window;
  await fill(page, "input[name=code]", t.code);
  await submit(page);
}

async function setup() {
  const tag = randomBytes(2).toString("hex");
  const mk = (u, display) => ({ username: `${u}${tag}`, display, email: `${u}${tag}@example.org`, password: `Gallery-${randomBytes(9).toString("hex")}` });

  if (!state.owner) {
    log("setup: busy account");
    const owner = mk("avery", "Avery Quinn");
    const c = await newContext(null);
    const p = await c.newPage();
    await signUp(p, owner);
    await p.goto(site + "/portal/workspaces/");
    await fill(p, "input[name=name]", "Northwind Research");
    await submit(p, "form:has(input[name=name]) button[type=submit]");
    state.workspaceUrl = p.url();
    const invite = async (email, role) => {
      await p.goto(state.workspaceUrl);
      await fill(p, "input[name=email]", email);
      if (role && (await p.locator("select[name=role]").count())) await p.locator("select[name=role]").selectOption(role);
      await submit(p, "form:has(input[name=email]) button[type=submit]");
      return (await p.locator("#invite-link").innerText()).trim();
    };
    const member = mk("jun", "Jun Park");
    state.memberInvite = await invite(member.email, "member");
    state.pendingInvite = await invite(`sam${tag}@example.org`, "admin");
    await invite(`leo${tag}@partner.example`, "member");
    await enableTotp(p, owner);
    // A couple of support requests from the signed-in account.
    for (const [subject, message] of [["Invoice address for Northwind", "Could the next invoice show our new office address? Thanks!"], ["Adding a second domain", "We'd like colleagues on partner.example to join a shared room. Anything to configure?"]]) {
      await p.goto(site + "/contact/?topic=support");
      await fill(p, "input[name=subject]", subject);
      await fill(p, "textarea[name=message]", message);
      if (await p.locator("input[name=name]").count()) await fill(p, "input[name=name]", owner.display);
      if (await p.locator("input[name=email]").count()) await fill(p, "input[name=email]", owner.email);
      await submit(p, "main form button[type=submit]");
    }
    // Security history: sign out, one failed attempt, sign in with TOTP.
    await p.goto(site + "/accounts/logout/");
    await submit(p);
    await p.goto(site + "/accounts/login/");
    await fill(p, "input[name=login]", owner.username);
    await fill(p, "input[name=password]", "not-the-password");
    await submit(p);
    await signIn(p, site, owner);
    await c.storageState({ path: storage("owner") });
    await c.close();
    state.owner = owner;
    saveState();

    log("setup: workspace member");
    const mc = await newContext(null);
    const mp = await mc.newPage();
    const invPath = new URL(state.memberInvite).pathname;
    await signUp(mp, member, invPath);
    if (new URL(mp.url()).pathname !== invPath) await mp.goto(state.memberInvite);
    await submit(mp, "main form button[type=submit]");
    await mc.storageState({ path: storage("member") });
    await mc.close();
    state.member = member;
    saveState();
  }

  if (!state.fresh) {
    log("setup: new account");
    const fresh = mk("riley", "Riley");
    const c = await newContext(null);
    const p = await c.newPage();
    await signUp(p, fresh);
    await c.storageState({ path: storage("fresh") });
    await c.close();
    state.fresh = fresh;
    saveState();
  }

  if (!state.op) {
    log("setup: operator");
    const op = { username: `galleryops${tag}`, password: `Ops-Gallery-${randomBytes(10).toString("hex")}` };
    const out = execFileSync(path.join(REPO, "lumenctl"), ["create-operator", op.username, `${op.username}@example.org`, "owner"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const link = out.match(/https:\/\/\S+\/setup\/\S+/)?.[0];
    if (!link) throw new Error("no setup link from lumenctl create-operator");
    const c = await newContext(null);
    const p = await c.newPage();
    await p.goto(link);
    await fill(p, "input[name=new_password1]", op.password);
    await fill(p, "input[name=new_password2]", op.password);
    await submit(p);
    await fill(p, "input[name=login]", op.username);
    await fill(p, "input[name=password]", op.password);
    await submit(p);
    await enableTotp(p, op, ops);
    // Give the busy workspace a paid plan (manual assignment), so billing pages show real figures.
    await p.goto(ops + "/ops/workspaces/?q=Northwind");
    await p.locator("a:has-text('Northwind Research')").first().click();
    await p.waitForLoadState("domcontentloaded");
    state.opsWorkspaceUrl = p.url();
    const planSel = p.locator("select[name=plan]");
    const values = await planSel.locator("option").evaluateAll((os) => os.map((o) => o.value));
    const paid = values.find((v) => /team|business|pro/i.test(v)) || values[1];
    if (paid) {
      await planSel.selectOption(paid);
      await fill(p, "input[name=note]", "Gallery: manual plan");
      await submit(p, "form[action$='/plan/'] button[type=submit]");
      await passReauth(p, op.password);
    }
    await c.storageState({ path: storage("op") });
    await c.close();
    state.op = op;
    saveState();
  }
}

/** Opens a persona's context and makes sure its session is still signed in. */
async function persona(who) {
  const ctx = await newContext(who === "anon" ? null : who);
  const page = await ctx.newPage();
  if (who !== "anon") {
    const origin = who === "op" ? ops : site;
    const probe = who === "op" ? "/ops/dashboard/" : "/portal/dashboard/";
    await page.goto(origin + probe);
    if (/\/accounts\/login\//.test(page.url())) {
      await signIn(page, origin, state[who]);
      saveState();
    }
    await ctx.storageState({ path: storage(who) });
  }
  return { ctx, page };
}

// --- server-rendered templates for pages that cannot be triggered safely ------------------------
function renderTemplates() {
  const code = `
import json
from django.test import RequestFactory
from django.contrib.auth.models import AnonymousUser
from django.template.loader import render_to_string
from django.core.exceptions import PermissionDenied
r = RequestFactory().get('/portal/', HTTP_HOST='${base}', secure=True)
r.user = AnonymousUser()
out = {
  '429': render_to_string('429.html', request=r),
  '403': render_to_string('403.html', {'exception': PermissionDenied('Only workspace owners and admins can do that.')}, request=r),
  'csrf': render_to_string('site/csrf_failure.html', request=r),
}
print('@@JSON@@' + json.dumps(out))
`;
  const raw = execFileSync(path.join(REPO, "lumenctl"), ["compose", "exec", "-T", "portal", "python", "manage.py", "shell", "-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const rendered = JSON.parse(raw.slice(raw.indexOf("@@JSON@@") + 8));
  rendered["500"] = fs.readFileSync(path.join(REPO, "services/portal/templates/500.html"), "utf8");
  return rendered;
}

// --- page list --------------------------------------------------------------------------------
function pages() {
  const ws = state.workspaceUrl ? new URL(state.workspaceUrl).pathname : "";
  return [
    // public website
    ["site-home", "anon", site + "/"], ["site-features", "anon", site + "/features/"], ["site-security", "anon", site + "/security/"],
    ["site-zero-trust", "anon", site + "/zero-trust/"], ["site-federation", "anon", site + "/federation/"], ["site-pricing", "anon", site + "/pricing/"],
    ["site-docs", "anon", site + "/docs/"], ["site-docs-article", "anon", site + "/docs/getting-started/"], ["site-docs-self-hosting", "anon", site + "/docs/self-hosting/"],
    ["site-download", "anon", site + "/download/"], ["site-status", "anon", site + "/status/"], ["site-contact", "anon", site + "/contact/"],
    ["site-privacy", "anon", site + "/privacy/"], ["site-terms", "anon", site + "/terms/"], ["site-disclosure", "anon", site + "/security/disclosure/"],
    // entrance
    ["auth-signup", "anon", site + "/accounts/signup/"], ["auth-login", "anon", site + "/accounts/login/"],
    ["auth-password-reset", "anon", site + "/accounts/password/reset/"], ["auth-email-confirm", "anon", site + "/accounts/confirm-email/abc/"],
    ["auth-verification-sent", "anon", site + "/accounts/confirm-email/"],
    ["portal-invitation", "anon", state.pendingInvite], ["portal-invitation-invalid", "anon", site + "/invite/no-longer-valid-invitation-token/"],
    ["ops-login", "anon", ops + "/accounts/login/"],
    // errors
    ["error-404", "anon", site + "/this-page-does-not-exist/"], ["error-403", "member", ws ? site + ws + "settings/" : null],
    ["error-403-template", "anon", site + "/__gallery__/403"], ["error-429", "anon", site + "/__gallery__/429"],
    ["error-500", "anon", site + "/__gallery__/500"], ["error-csrf", "anon", site + "/__gallery__/csrf"],
    // new account
    ["portal-dashboard-new", "fresh", site + "/portal/dashboard/"], ["portal-workspaces-empty", "fresh", site + "/portal/workspaces/"],
    ["portal-security-new", "fresh", site + "/portal/security/"], ["portal-support-empty", "fresh", site + "/portal/support/"],
    ["portal-totp-activate", "fresh", site + "/accounts/2fa/totp/activate/"],
    // busy account
    ["portal-dashboard-busy", "owner", site + "/portal/dashboard/"], ["portal-workspaces", "owner", site + "/portal/workspaces/"],
    ["portal-workspace-detail", "owner", ws && site + ws], ["portal-workspace-settings", "owner", ws && site + ws + "settings/"],
    ["portal-workspace-billing", "owner", ws && site + ws + "billing/"], ["portal-workspace-member-view", "member", ws && site + ws],
    ["portal-security", "owner", site + "/portal/security/"], ["portal-sessions", "owner", site + "/accounts/sessions/"],
    ["portal-mfa", "owner", site + "/accounts/2fa/"], ["portal-recovery-codes", "owner", site + "/accounts/2fa/recovery-codes/"],
    ["portal-profile", "owner", site + "/portal/profile/"], ["portal-email", "owner", site + "/accounts/email/"],
    ["portal-password", "owner", site + "/accounts/password/change/"], ["portal-privacy", "owner", site + "/portal/privacy/"],
    ["portal-support", "owner", site + "/portal/support/"],
    // operator console
    ["ops-dashboard", "op", ops + "/ops/dashboard/"], ["ops-users", "op", ops + "/ops/users/"], ["ops-user-detail", "op", "user-detail"],
    ["ops-workspaces", "op", ops + "/ops/workspaces/"], ["ops-workspace-detail", "op", state.opsWorkspaceUrl],
    ["ops-plans", "op", ops + "/ops/plans/"], ["ops-plan-edit", "op", "plan-edit"], ["ops-subscriptions", "op", ops + "/ops/subscriptions/"],
    ["ops-webhooks", "op", ops + "/ops/webhooks/"], ["ops-health", "op", ops + "/ops/health/"], ["ops-federation", "op", ops + "/ops/federation/"],
    ["ops-calls", "op", ops + "/ops/calls/"], ["ops-backups", "op", ops + "/ops/backups/"], ["ops-wireguard", "op", ops + "/ops/wireguard/"],
    ["ops-maintenance", "op", ops + "/ops/maintenance/"], ["ops-security", "op", ops + "/ops/security/"], ["ops-audit", "op", ops + "/ops/audit/"],
    ["ops-config", "op", ops + "/ops/config/"], ["ops-support", "op", ops + "/ops/support/"], ["ops-ticket", "op", "ticket"],
  ].filter(([name, , url]) => url && (!only || only.test(name)));
}

// --- audit (runs in the page) -----------------------------------------------------------------
async function audit(page, touch) {
  return page.evaluate((touch) => {
    const out = { smallTargets: [], contrast: [], unlabeled: [], noAlt: [], headings: [] };
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[aria-hidden=true], .visually-hidden");
    };
    const desc = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 32);
      return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
    };
    // Touch targets (WCAG 2.5.5 / platform guidance: 44x44). Inline links inside running text are exempt.
    if (touch) {
      for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]")) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (el.tagName === "A" && cs.display === "inline" && el.parentElement && el.parentElement.innerText.trim().length > el.innerText.trim().length + 2) continue;
        if (["checkbox", "radio"].includes(el.type) && el.closest("label")) {
          const lr = el.closest("label").getBoundingClientRect();
          if (lr.height >= 44 || lr.width >= 44 && lr.height >= 24) continue;
        }
        if (r.width < 44 - 0.5 || r.height < 44 - 0.5) out.smallTargets.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    // Text contrast (WCAG 1.4.3 AA).
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const bgOf = (el) => {
      const layers = [];
      for (let a = el; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.backgroundImage && cs.backgroundImage !== "none" && !/^url/.test(cs.backgroundImage)) return null; // gradient: not measurable
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const l of layers.reverse()) bg = blend(l, bg);
      return bg;
    };
    const seen = new Set();
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el) || el.closest("svg, .gradient-text, [disabled], [aria-disabled=true]")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || fg.a === 0) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const f = fg.a < 1 ? blend(fg, bg) : fg;
      const opacity = [...(function* () { for (let a = el; a; a = a.parentElement) yield Number(getComputedStyle(a).opacity); })()].reduce((x, y) => x * y, 1);
      const L1 = lum(f), L2 = lum(bg);
      let ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (opacity < 1) ratio = 1 + (ratio - 1) * opacity;
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need - 0.05) {
        const key = `${desc(el)}|${cs.color}`;
        if (!seen.has(key)) { seen.add(key); out.contrast.push(`${desc(el)} ${ratio.toFixed(2)}:1 (needs ${need})`); }
      }
    }
    // Labels and alt text.
    for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=submit]), select, textarea")) {
      if (!vis(el) && !el.closest(".checkbox")) continue;
      const labelled = el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title;
      if (!labelled) out.unlabeled.push(desc(el));
    }
    for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) out.noAlt.push(img.src.split("/").pop());
    // Headings.
    const hs = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(vis);
    const h1 = hs.filter((h) => h.tagName === "H1").length;
    if (h1 !== 1) out.headings.push(`${h1} visible h1`);
    for (let i = 1; i < hs.length; i++) {
      const a = Number(hs[i - 1].tagName[1]), b = Number(hs[i].tagName[1]);
      if (b > a + 1) out.headings.push(`h${a} → h${b} ("${hs[i].innerText.trim().slice(0, 30)}")`);
    }
    return out;
  }, touch);
}

/** Tabs through the first focusable elements and reports any without a visible focus indicator. */
async function auditFocus(page) {
  const missing = [];
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
      const label = `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24)}"`;
      return { ring, label };
    });
    if (r && !r.ring) missing.push(r.label);
  }
  return missing;
}

// --- capture ----------------------------------------------------------------------------------
const results = [];
async function settle(page) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(120);
}
/** Masks credentials before a screenshot: recovery codes, TOTP secrets and QR codes, one-time
 *  links and WireGuard profiles. The layout stays; the secret never reaches a PNG. */
async function redact(page) {
  await page.evaluate(() => {
    const mask = (t) => t.replace(/[A-Za-z0-9+/=_-]/g, "•");
    for (const el of document.querySelectorAll("textarea[readonly], textarea[disabled], #authenticator_secret, .recovery-codes")) {
      if ("value" in el && el.value) el.value = mask(el.value);
      else el.textContent = mask(el.textContent);
    }
    for (const el of document.querySelectorAll(".codebox, .wg-config, main pre.small")) el.textContent = mask(el.textContent);
    for (const el of document.querySelectorAll(".qr, img[src^='data:image']")) el.style.filter = "blur(9px)";
  });
}
async function captureAll(page, name, label = name, { focus = true, shots = SHOTS } = {}) {
  const entry = { page: label, url: page.url(), status: page.__status ?? null, shots: [], focus: [] };
  for (const [vp, theme] of shots) {
    const v = VIEWPORTS[vp];
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await settle(page);
    await redact(page);
    const file = `${label}--${vp}-${theme}.png`;
    if (v.zoom) {
      // 200 % zoom: the same CSS layout at device scale 2 (what a 1280 px window shows at 200 %).
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.zoom, mobile: false });
      await settle(page);
      await page.screenshot({ path: path.join(OUT, file), fullPage: true });
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await cdp.detach();
    } else {
      await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    }
    const ov = await measureOverflow(page);
    const a = await audit(page, v.width <= 1024 && !v.zoom);
    entry.shots.push({ vp, theme, file, overflow: ov.sw > ov.cw + 1 ? `${ov.sw}px > ${ov.cw}px (${ov.culprit})` : "", ...a });
  }
  if (focus) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    entry.focus = await auditFocus(page);
  }
  results.push(entry);
  log(`  ${label}: ${entry.shots.length} shots`);
}

async function gotoPage(page, url) {
  const r = await page.goto(url);
  page.__status = r ? r.status() : null;
  return r;
}

if (!curateOnly) {
await setup();
const rendered = renderTemplates();

const contexts = {};
async function pageFor(who) {
  if (!contexts[who]) contexts[who] = await persona(who);
  return contexts[who].page;
}
for (const who of ["anon", "fresh", "owner", "member", "op"]) {
  const p = await pageFor(who);
  if (who === "anon")
    await p.route(`${site}/__gallery__/*`, (route) => {
      const key = route.request().url().split("/").pop();
      route.fulfill({ status: key === "csrf" ? 403 : Number(key), contentType: "text/html; charset=utf-8", body: rendered[key] });
    });
}

for (const [name, who, target] of pages()) {
  const page = await pageFor(who);
  let url = target;
  if (target === "user-detail") {
    await page.goto(`${ops}/ops/users/?q=${state.owner.username}`);
    url = await page.locator(`a:has-text("${state.owner.username}")`).first().evaluate((a) => a.href);
  } else if (target === "plan-edit") {
    await page.goto(`${ops}/ops/plans/`);
    url = await page.locator("a[href*='/ops/plans/']:has-text('Edit')").nth(1).evaluate((a) => a.href);
  } else if (target === "ticket") {
    await page.goto(`${ops}/ops/support/`);
    url = await page.locator("a[href*='/ops/support/']").first().evaluate((a) => a.href);
  }
  try {
    await gotoPage(page, url);
    if (who !== "anon" && /\/accounts\/login\//.test(page.url())) {
      // The console ends sessions after 30 idle minutes; sign in again and retry.
      await signIn(page, who === "op" ? ops : site, state[who]);
      saveState();
      await gotoPage(page, url);
    }
    if (/\/accounts\/reauthenticate\//.test(page.url())) {
      await passReauth(page, state[who].password);
      await gotoPage(page, url);
    }
    await captureAll(page, name);
  } catch (err) {
    log(`  ${name}: FAILED ${String(err.message).split("\n")[0]}`);
    results.push({ page: name, url, error: String(err.message).split("\n")[0], shots: [] });
  }
}

// --- pages that are the result of a form post ---------------------------------------------------
const POST_SHOTS = quick ? SHOTS : [["390", "light"], ["1280", "light"], ["1280", "dark"], ["360", "light"]];
async function special(name, fn) {
  if (only && !only.test(name)) return;
  try {
    const page = await fn();
    await captureAll(page, name, name, { shots: POST_SHOTS, focus: false });
  } catch (err) {
    const where = contexts.op ? contexts.op.page.url() : "";
    log(`  ${name}: FAILED ${String(err.message).split("\n")[0]} (console page at ${where})`);
    if (contexts.op) await contexts.op.page.screenshot({ path: path.join(OUT, `${name}--FAILED.png`) }).catch(() => {});
    results.push({ page: name, error: String(err.message).split("\n")[0], shots: [] });
  }
}
await special("auth-signup-error", async () => {
  const c = await newContext(null);
  const p = await c.newPage();
  await p.goto(site + "/accounts/signup/");
  await fill(p, "input[name=username]", "a");
  await fill(p, "input[name=email]", "not-an-email");
  await fill(p, "input[name=password1]", "password");
  await fill(p, "input[name=password2]", "passw0rd");
  await p.evaluate(() => document.querySelectorAll("form").forEach((f) => (f.noValidate = true)));
  await submit(p);
  return p;
});
await special("auth-login-error", async () => {
  const c = await newContext(null);
  const p = await c.newPage();
  await p.goto(site + "/accounts/login/");
  await fill(p, "input[name=login]", "someone");
  await fill(p, "input[name=password]", "wrong-password");
  await submit(p);
  return p;
});
await special("auth-mfa-prompt", async () => {
  const c = await newContext(null);
  const p = await c.newPage();
  await p.goto(site + "/accounts/login/");
  await fill(p, "input[name=login]", state.owner.username);
  await fill(p, "input[name=password]", state.owner.password);
  await submit(p);
  return p;
});
await special("auth-reauthenticate", async () => {
  const c = await newContext("fresh");
  const p = await c.newPage();
  await p.goto(site + "/accounts/reauthenticate/?next=/portal/security/");
  return p;
});
await special("ops-recovery-link", async () => {
  const page = await pageFor("op");
  const openUser = async () => {
    await page.goto(`${ops}/ops/users/?q=${state.member.username}`);
    if (/\/accounts\/login\//.test(page.url())) {
      await signIn(page, ops, state.op);
      await page.goto(`${ops}/ops/users/?q=${state.member.username}`);
    }
    await page.locator(`main a:has-text("${state.member.username}")`).first().click();
    await page.waitForLoadState("domcontentloaded");
  };
  const issue = async () => {
    page.once("dialog", (d) => d.accept());
    await submit(page, "form[action$='/recovery-link/'] button[type=submit]");
  };
  await openUser();
  await issue();
  // Sensitive actions need a recent sign-in (5 min): confirm the password, then issue again.
  if (await passReauth(page, state.op.password)) {
    await openUser();
    await issue();
  }
  return page;
});
await special("ops-calls-selftest", async () => {
  const page = await pageFor("op");
  const run = async () => {
    await page.goto(ops + "/ops/calls/");
    if (/\/accounts\/login\//.test(page.url())) {
      await signIn(page, ops, state.op);
      await page.goto(ops + "/ops/calls/");
    }
    await submit(page, 'main form button:has-text("Run media self-test")');
  };
  await run();
  if (await passReauth(page, state.op.password)) await run();
  await page.locator(".alert").first().waitFor({ timeout: 120000 });
  return page;
});

await browser.close();

// --- report -----------------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify({ set, base, problems, results }, null, 2));
const lines = [`# Gallery audit: ${set}`, "", `${results.reduce((n, r) => n + r.shots.length, 0)} screenshots of ${results.length} pages.`, ""];
const totals = { overflow: 0, smallTargets: 0, contrast: 0, unlabeled: 0, noAlt: 0, headings: 0, focus: 0 };
for (const r of results) {
  const rows = [];
  if (r.error) rows.push(`- capture failed: ${r.error}`);
  if (r.status && r.status >= 400) rows.push(`- HTTP ${r.status}`);
  for (const s of r.shots) {
    if (s.overflow) { totals.overflow++; rows.push(`- ${s.vp}/${s.theme}: horizontal overflow ${s.overflow}`); }
    for (const k of ["smallTargets", "contrast", "unlabeled", "noAlt", "headings"]) {
      if (s[k].length) { totals[k] += s[k].length; rows.push(`- ${s.vp}/${s.theme}: ${k} (${s[k].length}): ${s[k].slice(0, 6).join("; ")}${s[k].length > 6 ? " …" : ""}`); }
    }
  }
  if (r.focus?.length) { totals.focus += r.focus.length; rows.push(`- no visible focus: ${r.focus.join("; ")}`); }
  if (rows.length) lines.push(`## ${r.page}`, "", ...rows, "");
}
// The error pages under test (403/404/429/500) answer with those statuses on purpose.
const expected = (p) => /status of (403|404|429|500)\b|__gallery__\/500$/.test(p);
const real = [...new Set(problems.filter((p) => !expected(p)))];
const expectedCount = problems.filter(expected).length;
lines.splice(3, 0, `Totals: ${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "", real.length ? `Console/CSP/HTTP problems: ${real.length}\n\n${real.map((p) => `- ${p}`).join("\n")}\n` : "Console/CSP/HTTP problems: none", `(${expectedCount} expected error statuses from the 403/404/429/500 pages themselves are not counted.)`, "");
fs.writeFileSync(path.join(OUT, "audit.md"), lines.join("\n"));
log(`\n${lines.slice(0, 6).join("\n")}`);
}

// --- curated copies -----------------------------------------------------------------------------
if (curateDir) {
  fs.mkdirSync(curateDir, { recursive: true });
  const list = CURATED.map((n) => [path.join(OUT, `${n}.png`), path.join(curateDir, `${n}.png`)]).filter(([src]) => fs.existsSync(src));
  const py = `
import sys, os
from PIL import Image
for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
    im = Image.open(src).convert("RGB")
    limit = 300 * 1024
    scale = 1.0
    while True:
        cur = im if scale == 1.0 else im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
        q = cur.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        q.save(dst, optimize=True)
        if os.path.getsize(dst) <= limit or scale < 0.35:
            break
        scale *= 0.8
    print(f"{os.path.basename(dst)} {os.path.getsize(dst)//1024} KB scale={scale:.2f}")
`;
  const outp = execFileSync("python3", ["-I", "-c", py, ...list.flat()], { encoding: "utf8" });
  log(outp);
  const missing = CURATED.filter((n) => !fs.existsSync(path.join(OUT, `${n}.png`)));
  if (missing.length) log(`curated shots missing: ${missing.join(", ")}`);
}
