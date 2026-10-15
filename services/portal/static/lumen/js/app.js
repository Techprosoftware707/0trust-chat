/*
 * Progressive enhancement for Lumen pages. No inline handlers (strict CSP):
 * behaviour is attached through data attributes.
 */
(function () {
  "use strict";

  function currentTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateThemeButtons() {
    var dark = currentTheme() === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
    });
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-theme-toggle]");
    if (t) {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("lumen-theme", next); } catch (e) { /* ignore */ }
      updateThemeButtons();
      return;
    }
    var menu = ev.target.closest("[data-menu-toggle]");
    if (menu) {
      var header = menu.closest(".site-header");
      var open = header.getAttribute("data-menu-open") === "true";
      header.setAttribute("data-menu-open", open ? "false" : "true");
      menu.setAttribute("aria-expanded", open ? "false" : "true");
      return;
    }
    var nav = ev.target.closest("[data-nav-toggle]");
    if (nav) {
      var shell = document.querySelector(".app-shell");
      var o = shell.getAttribute("data-nav-open") === "true";
      shell.setAttribute("data-nav-open", o ? "false" : "true");
      nav.setAttribute("aria-expanded", o ? "false" : "true");
      return;
    }
    var copy = ev.target.closest("[data-copy]");
    if (copy) {
      var src = document.getElementById(copy.getAttribute("data-copy"));
      if (src && navigator.clipboard) {
        navigator.clipboard.writeText(src.textContent.trim()).then(function () {
          var label = copy.textContent;
          copy.textContent = "Copied";
          setTimeout(function () { copy.textContent = label; }, 1600);
        });
      }
    }
  });

  // Confirmation for destructive forms: <form data-confirm="Message">.
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var msg = form.getAttribute && form.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) {
      ev.preventDefault();
      return;
    }
    var btn = form.querySelector("button[type=submit]");
    if (btn && !form.hasAttribute("data-no-disable")) {
      setTimeout(function () { btn.setAttribute("aria-disabled", "true"); }, 0);
    }
  });

  // Auto-submit selects marked with data-autosubmit.
  document.addEventListener("change", function (ev) {
    if (ev.target.matches && ev.target.matches("[data-autosubmit]")) ev.target.form.submit();
  });

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", updateThemeButtons);
  }
  updateThemeButtons();
})();
