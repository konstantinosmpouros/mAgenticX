// Applies the saved theme before the app renders, so the page does not flash
// the default (Daylight) theme first. A file rather than an inline script: the
// CSP allows scripts from this origin only (nginx.conf.template). next-themes
// and ThemeModeSync keep <html> in step afterwards. Keep THEMES, DARK_THEMES
// and ALIASES in sync with src/styles/theme/themes.ts (resolveStoredTheme).
(function () {
  var THEMES = ["daylight", "midnight", "aurora", "sunset", "sage", "citrus"];
  var DARK_THEMES = ["midnight"];
  // What was stored before the palette themes existed.
  var ALIASES = { light: "daylight", dark: "midnight" };
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    // No matchMedia: light.
  }
  var theme = prefersDark ? "midnight" : "daylight";
  try {
    var storage = window.localStorage;
    var stored = storage.getItem("theme");
    // A theme id stays and a legacy name maps to its theme. Nothing stored,
    // "system" (the removed System option) or an unknown name becomes Daylight
    // or Midnight from the device's preference now, stored once as an explicit
    // choice before next-themes reads it.
    if (stored && THEMES.indexOf(stored) !== -1) theme = stored;
    else if (stored && ALIASES[stored]) theme = ALIASES[stored];
    if (stored !== theme) storage.setItem("theme", theme);
  } catch (e) {
    // No storage (private mode, blocked): the device's preference, this page only.
  }
  var isDark = DARK_THEMES.indexOf(theme) !== -1;
  var root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
})();
