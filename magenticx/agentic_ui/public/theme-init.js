// Applies the saved theme before the app renders, so the page does not flash
// the default (light) theme first. A file rather than an inline script: the CSP
// allows scripts from this origin only (nginx.conf.template). next-themes and
// ThemeModeSync keep <html> in step afterwards. Keep DARK_THEMES in sync with
// src/styles/theme/themes.ts.
(function () {
  var DARK_THEMES = ["dark"];
  try {
    var theme = window.localStorage.getItem("theme") || "system";
    if (theme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var isDark = DARK_THEMES.indexOf(theme) !== -1;
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.classList.toggle("dark", isDark);
    root.style.colorScheme = isDark ? "dark" : "light";
  } catch (e) {
    // No storage (private mode, blocked): the default theme stays.
  }
})();
