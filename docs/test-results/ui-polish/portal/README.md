# UI polish: website, customer portal and operator console

Scope: `services/portal` (Django templates, `static/lumen/css/lumen.css`, `static/lumen/js/app.js`),
on the shared tokens in `design/tokens.css`. Same information architecture; no new features
beyond small UX improvements, plus the messaging the coordinator asked for (Lumen is new,
built on Matrix, WireGuard for private administration).

## How the screenshots were made

`tests/ui/portal-gallery.mjs` (Playwright, against the deployed dev stack at
`https://lumen.test` and `https://ops.lumen.test:8443`) captures **75 pages** — every public
page, sign-up / sign-in / two-step / password reset / email confirmation, the portal with a
brand-new and a busy account (TOTP, recovery codes, a workspace with a member and pending
invitations, support requests, security history), error pages 403 / 404 / 429 / 500 / CSRF,
and every console page including user detail, the Calls media self-test and a one-time
recovery link — at:

| Viewports (light) | Dark | Zoom |
|---|---|---|
| 360×740, 390×844, 768×1024, 1024×768, 1280×800, 1920×1080 | 390×844, 1280×800 | 1280×800 at 200 % (640×400 CSS px, device scale 2) |

Form-post results (sign-up errors, sign-in error, two-step prompt, re-authentication, recovery
link, Calls self-test) are captured at 360, 390, 1280 light and 1280 dark.

Every capture is also **audited in the page**: horizontal overflow, touch targets under 44×44 px
(viewports ≤ 1024 px; inline links in running text exempt), WCAG 2.2 AA text contrast
(computed against the real background), unlabeled controls, images without `alt`, heading
order, and a visible keyboard focus indicator for the first 14 Tab stops.

```
sudo NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt \
  node tests/ui/portal-gallery.mjs --set after --curate docs/test-results/ui-polish/portal/after
```

The full sets (≈650 PNGs each) stay in `tests/ui/output/gallery/<set>/` (git-ignored) with
`audit.json` and `audit.md`. The curated 40 per set, palette-quantised to stay small, are in
[`before/`](before/) and [`after/`](after/) with identical names: `<page>--<viewport>-<theme>.png`.

- **before**: the deployed portal at commit `898ed0a` (tokens before `0755f71`).
- **after**: the portal at `3890515` (deployed), with the shared tokens of `eefa6ab`
  (warmer feel and the AA-contrast token fix, both made by the coordinator).

Curated PNGs are palette-quantised (median cut, 128 colours; octree, 96 colours for the two
long 1,280 px home captures, about 300 KB each). Credentials are masked in the page before
capture (recovery codes, TOTP secrets and QR codes, one-time links, WireGuard profiles); the
test account's recovery codes visible in an early before image were redacted and replaced on
the test host.

## Automated audit, before → after

| Check (all captures) | Before (645 shots) | After (645 shots) |
|---|---|---|
| Text contrast below WCAG AA | 2,145 | 0 |
| Touch targets under 44×44 px (≤ 1024 px wide) | 6,632 | 0 |
| Horizontal overflow | 6 | 0 |
| Heading level skips / not exactly one h1 | 180 | 0 |
| Controls without a label, images without alt | 0 | 0 |
| Tab stops without a visible focus indicator | 0 | 0 |
| Console errors, CSP violations, 5xx (other than the error pages under test) | 0 | 0 |

Summaries: [`audit-before.txt`](audit-before.txt), [`audit-after.txt`](audit-after.txt).

## Issues and fixes

| # | Issue (before) | Fix | Screenshots |
|---|---|---|---|
| 1 | Portal/console sidebar background stopped partway down the page (sticky `100vh` box in a taller grid row); in the console, the account footer was pushed off-screen. | The sidebar is a full-height grid column; its content is a sticky panel in which only the navigation scrolls (with a fade), between a fixed brand and account footer. | `portal-dashboard-busy--1280-light`, `ops-dashboard--1280-light`, `ops-user-detail--1280-light` |
| 2 | Card headings inconsistent ("Your encryption keys" and "Help" at 28 px, other cards 18 px); allauth pages used card-in-card with 28 px panel titles. | One app heading scale (17 px / 650 for cards, 15 px for sub-sections), icon chips for section identity; manage pages drop the outer card. | `portal-dashboard-busy--1280-light`, `portal-privacy--1280-dark` |
| 3 | Workspaces and Recent activity cards had large empty areas (equal-height grid rows). | Dashboard is two independent columns (main / side), no forced equal heights; below 1,100 px one column in a sensible order. Workspace rows show an initial mark, role, plan and a seat meter. | `portal-dashboard-busy--1280-light`, `portal-dashboard-busy--390-light`, `portal-dashboard-new--1280-light` |
| 4 | Help links underlined, unlike other UI links. | Help is a link list: whole-row targets with icon and chevron. Underlines are kept only for links inside running text (WCAG 1.4.1); UI links underline on hover. | `portal-dashboard-busy--1280-light` |
| 5 | Mobile home very long (8,777 px at 390 px) with a loose rhythm. | Tighter section rhythm, hero illustration hidden on phones, features as compact icon rows, compact pricing (details on the pricing page), shorter terminal block. The page is 8,688 px at 390 px although it gained the Matrix and WireGuard sections. | `site-home--390-light` |
| 6 | Text contrast below AA in light mode: accent links/eyebrows 3.54–3.77:1, white on primary buttons 3.77:1, subtle text 4.42:1, status badges 3.87–4.39:1; dark mode solid danger buttons 2.45:1. | Measured, sent to the coordinator as a token proposal; tokens fixed in `eefa6ab` (cyan-700 accent, darker subtle and status colours, `--danger-contrast`). The component layer only uses tokens. | all; e.g. `site-home--1280-light`, `auth-signup--1280-light` |
| 7 | Touch targets under 44 px on phones and tablets: icon buttons 38 px, small buttons 34 px, nav, footer and docs links, standalone text links, FAQ rows. | At ≤ 1,024 px or with a coarse pointer every control is at least 44×44 px; inline links in sentences stay inline. | `site-home--390-light`, `portal-workspace-detail--390-dark` |
| 8 | Horizontal overflow: Calls self-test output, docs navigation at 360 px, Calls component summaries at 360 px; console search forms at 390 px. | `min-width: 0` on flex/grid children, wrapping rows, scrolling `pre`, docs navigation becomes scrollable pills on small screens, wrapping toolbar forms. | `ops-calls-selftest--1280-light` |
| 9 | Heading order skipped levels (footer `h4`, card `h3` straight after `h1`). | Footer titles are `h2.footer-title`; card titles `h2.card-title`; new section headings. | — (audit) |
| 10 | Inputs without a `type` attribute (WireGuard and plan forms) were unstyled browser inputs. | Styled like every other text input. | `ops-wireguard--1280-light` |
| 11 | Mobile navigation: the drawer had no backdrop, no Escape, no focus handling; on phones the public site had no "Sign in" anywhere. | Backdrop and close button, Escape closes and returns focus, focus moves into the drawer, page scroll locked; the site menu adds "Sign in" / "Your account"; the menu icon becomes a close icon. | `site-home--390-light`, `portal-dashboard-busy--390-light` |
| 12 | Forms: no password feedback; Django's `aria-describedby` pointed at ids that didn't exist; raw error bullets; no busy state. | Show/hide password, a strength hint for new passwords and a "passwords match" hint; help and error elements carry the ids inputs reference; calmer error list; buttons show a spinner while a form is sent; one-time-code autocomplete for 2FA codes. | `auth-signup--1280-light`, `auth-signup-error--390-light`, `auth-mfa-prompt--1280-light` |
| 13 | Tables on small screens only scrolled sideways. | Portal tables (security activity, support, invoices, sessions) become labelled rows on phones; console tables scroll inside a keyboard-focusable, labelled region. | `portal-security--1280-light`, `portal-sessions--1280-light` |
| 14 | Empty states were a grey line of text. | One friendly sentence, one action, an icon on the soft brand wash (`--brand-wash`): workspaces, invitations, invoices, support, WireGuard devices, activity, backups. | `portal-dashboard-new--1280-light`, `portal-support--1280-light`, `portal-workspace-billing--1024-light` |
| 15 | Error pages were a bare heading at the top of an empty page; 500 had no theme or brand. | One calm layout for 403 / 404 / 429 / 500 / CSRF: brand, error code, what happened, what to do next; never blames the user; 500 loads the theme and brand statically. | `error-404--1280-light`, `error-403--390-dark`, `error-429--1280-light`, `error-500--1280-dark` |
| 16 | Service status shown by colour only (dots). | Text alternatives for screen readers; badges carry words. | `ops-dashboard--1280-light` |
| 17 | Raw ISO timestamps in the console (last backup, restore check, WireGuard key) and "10,240 MB". | Formatted dates (`isodate` filter), sizes in GB (`megabytes` filter), handshake ages (`seconds_ago`). | `ops-dashboard--1280-light`, `portal-dashboard-busy--1280-light` |
| 18 | Copy: "attempt(s)", title-case allauth headings, terse notices. | Warm, plain copy: "Welcome back", "One more step", "Create your account", workspace creation celebrated, notices that say what to do. | `portal-dashboard-busy--1280-light`, `auth-login--390-dark` |
| 19 | Outdated or unfounded claims: the features page said group calls were not available (MatrixRTC group calls ship, ADR 0002); the home page called Lumen "open-source software" (no licence chosen yet, README); "Most popular" plan label without data; zero-trust page listed only 80/443 as open. | Calls described as they are (MatrixRTC, per-frame E2EE, SFU forwards ciphertext, the 443-only limitation stated); "open source" removed (tests guard it); "Recommended"; ports sentence includes call media and WireGuard ports. | `site-features--768-light` |
| 20 | Bug: the console plan editor's "Marketing bullet points" textarea showed a literal `{{ plan.features|join:" " }}` (a template tag split over two lines), so saving a plan would have overwritten the bullets with that text. | `join_lines` filter; unit test. | — |
| 21 | Theme toggle always showed a moon. | Moon in light, sun in dark (also when following the system); `aria-pressed` and a title. | all |
| 22 | Metadata: no `robots` hints for private pages, one theme colour, no Open Graph tags. | `noindex` for portal, console and error pages; light/dark `theme-color`; `og:*` and `twitter:card`; `mask-icon`. | — |
| 23 | Portal sessions (allauth) header row one column short; destructive allauth buttons solid red; manage forms had no primary action. | Sessions page rewritten (labelled columns, stacked on phones); destructive actions outlined unless prominent; first action in manage forms is primary; readable disabled inputs (TOTP secret in mono). | `portal-sessions--1280-light`, `portal-recovery-codes--768-light` |

### Messaging: new, built on Matrix, WireGuard (facts only)

- **Home**: a "New · Secure messaging built on Matrix" pill; Matrix in the lead; a trust strip
  (Built on Matrix · End-to-end encrypted · WireGuard admin access · Hybrid post-quantum TLS ·
  Self-hostable), each item linking to its explanation; a **Built on Matrix** section (open
  standard, federation, other Matrix apps such as Element, your own server) with a federation
  illustration; a **Private administration with WireGuard** section for teams and self-hosters
  (console off the public internet; WireGuard on by default with a preshared key per device;
  managed in the console or with `lumenctl wireguard add-peer`; "it doesn't carry your
  chats"); FAQ entries "What is Matrix?" and "Do my messages go through WireGuard?" (No).
  Copy that depends on the server follows its settings (federation mode, calls on/off).
- **Features, security, zero trust, Matrix (federation), apps, docs/self-hosting**: consistent
  sections and cross-links (operator access section on the security page; WireGuard card on the
  zero-trust page; "Why Matrix" on the Matrix page; console access steps in the self-hosting doc).
- **Dashboard**: "Your account runs on Matrix" card with this server's name and how to use
  another Matrix app.
- **Console WireGuard page**: tunnel status, "Devices dial" endpoint with the provider-firewall
  note, preshared-key badges ("On", never key material), the installer's first device, and the
  off / unavailable states (four states covered by unit tests).

Screens: `site-home--1280-light`, `site-home--1280-dark`, `site-home--390-light`,
`ops-wireguard--1280-light`, `portal-dashboard-busy--1280-light`.

## Tests

Results observed after the final deploy:

- `pytest` (services/portal): **139 passed** (118 before this work; 21 new in `tests/test_ui_pages.py`).
- UI suite `node tests/ui/portal.e2e.mjs`: **75 passed, 0 failed** (selectors unchanged; the shared helpers moved to `tests/ui/lib/portal-helpers.mjs`).
- Security scan `bash tests/security/scan.sh`: **122 passed; 1 known failure** caused by a non-Lumen dev container on this shared host (`nexus-pg`, 127.0.0.1:55433, another agent's test database). Every CSP, header, TLS and application check passes. Raw output: [`test-results.txt`](test-results.txt).

New unit tests in `services/portal/tests/test_ui_pages.py`: home messaging present; no
"open source", "VPN for users" or "messages over WireGuard" claims on the public pages; calls
copy follows `CALLS_ENABLED`; calm error pages with `noindex`; dashboard Matrix card and
greeting; no inline scripts, styles or handlers on the touched pages; the console WireGuard page
needs an operator session and renders the four states without key material; template filters;
the plan editor's bullets.

## Not covered / notes

- **HTML emails**: there are none. allauth sends plain-text mail, and SMTP is disabled on this
  test host, so there was nothing to render.
- **App icon**: brand assets are SVG and live in `branding/` (outside this area); browsers that
  need a PNG `apple-touch-icon` fall back to a screenshot.
- allauth pages reached only from email links (confirm-email) keep allauth's own wording.
