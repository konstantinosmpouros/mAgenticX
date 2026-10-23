/**
 * The themes the user can pick. One entry per theme; its colors live in
 * `<id>.css` in this folder (see README.md there).
 *
 * Read by the app (Settings → General, the sidebar logo, toasts, anything that
 * needs to know light from dark). `public/theme-init.js` runs before the app
 * loads and keeps its own copy of the dark ids: update it when adding a dark
 * theme.
 */
export type ThemeMode = "light" | "dark";

export type ThemeDefinition = {
  /** Stored in localStorage and set as `data-theme` on <html>. */
  id: string;
  label: string;
  /** Dark themes also get the `dark` class, which Tailwind's `dark:` variant uses. */
  mode: ThemeMode;
  /** The sidebar logo, drawn to read on this theme's background. */
  logo: string;
  /** The theme's swatch in Settings → General (a CSS background). */
  preview: string;
};

// The ids are next-themes' own "light" and "dark", the names the system
// preference resolves to, so a stored choice from before themes existed keeps
// working.
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "light",
    label: "Light",
    mode: "light",
    logo: "/logo2.png",
    preview:
      "linear-gradient(135deg, hsl(0 0% 100%) 0%, hsl(240 4.8% 95.9%) 52%, hsl(216 50% 92%) 100%)",
  },
  {
    id: "dark",
    label: "Dark",
    mode: "dark",
    logo: "/logo2_white_magentaX.png",
    preview:
      "linear-gradient(135deg, hsl(240 6% 6%) 0%, hsl(240 8% 10%) 55%, hsl(216 100% 8%) 100%)",
  },
];

export const THEME_IDS: string[] = THEMES.map((theme) => theme.id);

/**
 * The theme definition for a resolved name (next-themes' `resolvedTheme`).
 * Anything unknown, including an unresolved "system", falls back to Light.
 */
export function themeFor(name: string | undefined | null): ThemeDefinition {
  return THEMES.find((theme) => theme.id === name) ?? THEMES[0];
}
