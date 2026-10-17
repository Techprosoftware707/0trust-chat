/*
 * Progressive enhancement for Lumen pages. No inline handlers (strict CSP):
 * behaviour is attached through data attributes. Every page works without it.
 */
(function () {
  "use strict";

  var root = document.documentElement;

  // ---- Theme -------------------------------------------------------------------------------
  function currentTheme() {
    var explicit = root.getAttribute("data-theme");
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function updateThemeButtons() {
    var dark = currentTheme() === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.setAttribute("title", dark ? "Light theme" : "Dark theme");
    });
  }

  // ---- Site menu and app navigation drawer ----------------------------------------------------
  function setSiteMenu(header, open, focusToggle) {
    if (!header) return;
    header.setAttribute("data-menu-open", open ? "true" : "false");
    var btn = header.querySelector("[data-menu-toggle]");
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
      if (!open && focusToggle) btn.focus();
    }
    if (open) {
      var first = header.querySelector(".nav a");
      if (first) first.focus();
    }
  }
  function setNav(open, focusToggle) {
    var shell = document.querySelector(".app-shell");
    if (!shell) return;
    shell.setAttribute("data-nav-open", open ? "true" : "false");
    root.classList.toggle("nav-locked", open);
    var toggles = document.querySelectorAll("[data-nav-toggle]");
    toggles.forEach(function (t) { t.setAttribute("aria-expanded", open ? "true" : "false"); });
    if (open) {
      var current = shell.querySelector(".sidebar nav a[aria-current=page]") || shell.querySelector(".sidebar nav a");
      if (current) setTimeout(function () { current.focus(); }, 30);
    } else if (focusToggle && toggles[0]) {
      toggles[0].focus();
    }
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-theme-toggle]");
    if (t) {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("lumen-theme", next); } catch (e) { /* storage disabled */ }
      updateThemeButtons();
      return;
    }
    var menu = ev.target.closest("[data-menu-toggle]");
    if (menu) {
      var header = menu.closest(".site-header");
      setSiteMenu(header, header.getAttribute("data-menu-open") !== "true", false);
      return;
    }
    var openHeader = document.querySelector('.site-header[data-menu-open="true"]');
    if (openHeader && (!openHeader.contains(ev.target) || ev.target.closest(".nav a"))) setSiteMenu(openHeader, false, false);

    var nav = ev.target.closest("[data-nav-toggle]");
    if (nav) {
      var shell = document.querySelector(".app-shell");
      setNav(shell && shell.getAttribute("data-nav-open") !== "true", false);
      return;
    }
    if (ev.target.closest("[data-nav-close]")) {
      setNav(false, true);
      return;
    }
    var copy = ev.target.closest("[data-copy]");
    if (copy) copyFrom(copy);
    // Clicking outside an open row menu closes it.
    document.querySelectorAll("details.row-menu[open]").forEach(function (d) {
      if (!d.contains(ev.target)) d.removeAttribute("open");
    });
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var openHeader = document.querySelector('.site-header[data-menu-open="true"]');
    if (openHeader) setSiteMenu(openHeader, false, true);
    var shell = document.querySelector('.app-shell[data-nav-open="true"]');
    if (shell) setNav(false, true);
    document.querySelectorAll("details.row-menu[open]").forEach(function (d) {
      d.removeAttribute("open");
      var s = d.querySelector("summary");
      if (s) s.focus();
    });
  });

  // Leaving the small-screen layout closes the drawer.
  if (window.matchMedia) {
    var wide = window.matchMedia("(min-width: 901px)");
    var onWide = function () { if (wide.matches) setNav(false, false); };
    if (wide.addEventListener) wide.addEventListener("change", onWide);
  }

  // ---- Copy to clipboard ------------------------------------------------------------------------
  function copyFrom(btn) {
    var src = document.getElementById(btn.getAttribute("data-copy"));
    if (!src || !navigator.clipboard) return;
    var text = (src.value || src.textContent || "").trim();
    navigator.clipboard.writeText(text).then(function () {
      var label = btn.querySelector("[data-copy-label]");
      var old = label ? label.textContent : null;
      if (label) label.textContent = "Copied";
      btn.classList.add("is-copied");
      var live = document.getElementById("copy-status");
      if (live) live.textContent = "Copied to the clipboard";
      setTimeout(function () {
        if (label) label.textContent = old;
        btn.classList.remove("is-copied");
        if (live) live.textContent = "";
      }, 1600);
    });
  }

  // ---- Forms ----------------------------------------------------------------------------------------
  // Confirmation for destructive forms: <form data-confirm="Message">.
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var msg = form.getAttribute && form.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) {
      ev.preventDefault();
      return;
    }
    var btn = ev.submitter || form.querySelector("button[type=submit]");
    if (btn && !form.hasAttribute("data-no-disable") && btn.classList.contains("btn")) {
      setTimeout(function () {
        btn.setAttribute("aria-disabled", "true");
        btn.setAttribute("aria-busy", "true");
      }, 0);
      // Pages restored from the back/forward cache get their buttons back.
      window.addEventListener("pageshow", function () {
        btn.removeAttribute("aria-disabled");
        btn.removeAttribute("aria-busy");
      }, { once: true });
    }
  });

  // Auto-submit selects marked with data-autosubmit.
  document.addEventListener("change", function (ev) {
    if (ev.target.matches && ev.target.matches("[data-autosubmit]")) ev.target.form.submit();
  });

  // Show / hide password, and a strength hint for new passwords.
  var COMMON = /^(password|passw0rd|qwerty|letmein|welcome|iloveyou|admin|monkey|dragon|football|baseball|abc123|111111|123123|1234567890?)/i;
  function scorePassword(pw) {
    if (!pw) return 0;
    if (pw.length < 12) return 1;
    var classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(pw); }).length;
    var unique = new Set(pw.split("")).size;
    var score = 2;
    if (pw.length >= 14 && classes >= 2) score = 3;
    if ((pw.length >= 16 && classes >= 3) || pw.length >= 20) score = 4;
    if (unique < 6 || COMMON.test(pw) || /^\d+$/.test(pw)) score = Math.min(score, 1);
    return score;
  }
  var LABELS = ["", "Too short or too easy to guess — use at least 12 characters", "Okay — longer is stronger", "Good password", "Strong password"];

  function enhancePasswords() {
    document.querySelectorAll('input[type="password"]').forEach(function (input) {
      if (input.dataset.enhanced) return;
      input.dataset.enhanced = "1";
      var wrap = document.createElement("span");
      wrap.className = "input-wrap";
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "input-reveal";
      btn.textContent = "Show";
      btn.setAttribute("aria-label", "Show password");
      btn.setAttribute("aria-pressed", "false");
      if (input.id) btn.setAttribute("aria-controls", input.id);
      wrap.appendChild(btn);
      btn.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.setAttribute("aria-pressed", show ? "true" : "false");
      });

      var isNew = /^(password1|new_password1)$/.test(input.name) || (input.autocomplete === "new-password" && !/2$/.test(input.name));
      if (isNew) {
        var meter = document.createElement("div");
        meter.className = "pw-meter";
        meter.setAttribute("data-score", "0");
        meter.innerHTML = '<div class="pw-bars" aria-hidden="true"><span></span><span></span><span></span><span></span></div><p class="pw-label" aria-live="polite"></p>';
        wrap.insertAdjacentElement("afterend", meter);
        var label = meter.querySelector(".pw-label");
        input.addEventListener("input", function () {
          var s = scorePassword(input.value);
          meter.setAttribute("data-score", String(s));
          label.textContent = input.value ? LABELS[s] : "";
        });
      }
      var confirmOf = { password2: "password1", new_password2: "new_password1" }[input.name];
      if (confirmOf && input.form) {
        var first = input.form.querySelector('input[name="' + confirmOf + '"]');
        if (first) {
          var hint = document.createElement("p");
          hint.className = "pw-match";
          hint.setAttribute("aria-live", "polite");
          wrap.insertAdjacentElement("afterend", hint);
          var check = function () {
            if (!input.value) { hint.textContent = ""; hint.removeAttribute("data-state"); return; }
            var ok = input.value === first.value;
            hint.textContent = ok ? "Passwords match" : "Passwords don't match yet";
            hint.setAttribute("data-state", ok ? "ok" : "no");
          };
          input.addEventListener("input", check);
          first.addEventListener("input", check);
        }
      }
    });
  }

  // One-time codes: let phones offer the code from an SMS/app autofill (letters stay allowed
  // because recovery codes contain them).
  document.querySelectorAll('input[name="code"]').forEach(function (i) {
    if (!i.getAttribute("autocomplete")) i.setAttribute("autocomplete", "one-time-code");
    i.setAttribute("spellcheck", "false");
  });

  // Wide tables scroll inside their frame; make that frame reachable by keyboard.
  function enhanceTables() {
    document.querySelectorAll(".table-wrap").forEach(function (w) {
      if (w.scrollWidth > w.clientWidth + 1) {
        w.setAttribute("tabindex", "0");
        w.setAttribute("role", "region");
        if (!w.hasAttribute("aria-label")) {
          var card = w.closest("section, .card");
          var h = card && card.querySelector("h2, h3");
          w.setAttribute("aria-label", (h ? h.textContent.trim() + " — " : "") + "table, scrolls sideways");
        }
      } else if (w.getAttribute("role") === "region") {
        w.removeAttribute("tabindex");
        w.removeAttribute("role");
      }
    });
  }

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", updateThemeButtons);
  }
  updateThemeButtons();
  enhancePasswords();
  enhanceTables();
  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(enhanceTables, 150);
  });
})();
