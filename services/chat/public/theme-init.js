/* Applies the saved colour theme before first paint (same key as the website). */
(function () {
  try {
    var t = localStorage.getItem("lumen-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage disabled */
  }
})();
