/**
 * The themes the user can pick. One entry per theme; its colors live in
 * `<id>.css` in this folder, under `:root[data-theme="<id>"]` (see README.md).
 *
 * Read by the app (Settings → General, the sidebar logo, the orb, the brand
 * mark, toasts, anything that needs to know light from dark). `public/theme-init.js` runs
 * before the app loads and keeps its own copy of the ids, the dark ids, the
 * legacy aliases and the first-run choice (resolveStoredTheme): update it when
 * adding a theme.
 *
 * There is no "System" theme: a first visit (or a "system" stored before it was
 * removed) gets Daylight or Midnight from the device's preference at that
 * moment, stored as an explicit choice.
 */
export type ThemeMode = "light" | "dark";

export type ThemeDefinition = {
  /** Stored in localStorage and set as `data-theme` on <html>. */
  id: string;
  label: string;
  description: string;
  /** Dark themes also get the `dark` class, which Tailwind's `dark:` variant uses. */
  mode: ThemeMode;
  /** Colors for the theme's card in Settings → General: background, surface, accent. */
  preview: { background: string; surface: string; accent: string };
  /**
   * The sidebar logo drawn for this theme (a path under `public/`). Optional:
   * without one the theme gets the default logo for its mode (DEFAULT_LOGOS).
   */
  logo?: string;
  /**
   * The orb artwork for this theme (a square WebP under `public/`). Optional:
   * without one the theme gets DEFAULT_ORB. Retune the theme's --orb-glow-*
   * (its CSS file) to a new artwork's colours.
   */
  orb?: string;
  /**
   * The "soft node" brand mark for this theme (a square WebP under `public/`),
   * drawn by `BrandMark` (src/shared/ui/brand-mark.tsx). Optional: without one
   * the theme gets DEFAULT_MARK.
   */
  mark?: string;
};

/**
 * The mAgenticX logo: the ONE place its artwork is named. Every logo in the
 * app (the sidebar, the sign-in page, the share and report panels, the
 * settings rail, the shared-conversation header, the theme cards) draws it
 * through `BrandLogo` (src/shared/ui/brand-logo.tsx), which reads it here.
 *
 * - `mark`: the symbol on its own (square-ish; the sidebar, small badges).
 * - `full`: the symbol with the "mAgenticX" wordmark (headers, the sign-in page).
 *
 * Each comes in two inks: `light` is drawn for light backgrounds, `dark` for
 * dark ones. The new logo goes in `public/brand/logos/magenticx/`:
 *
 *   mark-on-light.svg  mark-on-dark.svg  full-on-light.svg  full-on-dark.svg
 *
 * (SVG preferred; otherwise transparent WebP/PNG at 2x: the mark 512x512, the
 * full logo about 1200x320.) Point the paths below at them; nothing else
 * changes. Until then both variants are the current "MAX" logo, which has no
 * wordmark of its own. The favicon is separate: index.html → /magenticx-favicon.svg.
 */
export type BrandLogoVariant = "mark" | "full";

export const BRAND_LOGOS: Record<BrandLogoVariant, Record<ThemeMode, string>> = {
  mark: { light: "/logo2.png", dark: "/logo2_white_magentaX.png" },
  full: { light: "/logo2.png", dark: "/logo2_white_magentaX.png" },
};

/** The logo a theme without its own `logo` gets: the mark, in the ink for its mode. */
export const DEFAULT_LOGOS: Record<ThemeMode, string> = BRAND_LOGOS.mark;

/** The orb a theme without its own `orb` gets (the Daylight artwork). */
export const DEFAULT_ORB = "/orbital-hub-transparent.webp";

/** The brand mark a theme without its own `mark` gets (the Daylight artwork). */
export const DEFAULT_MARK = "/brand/logos/soft-node/daylight-mark.webp";

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "daylight",
    label: "Daylight",
    description: "Clear. Modern. Open.",
    mode: "light",
    preview: { background: "#f1f8fd", surface: "#dcebf7", accent: "#0277cd" },
    orb: "/orbital-hub-transparent.webp",
    mark: "/brand/logos/soft-node/daylight-mark.webp",
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Sophisticated. Secure. Powerful.",
    mode: "dark",
    preview: { background: "#081028", surface: "#111a36", accent: "#a576fa" },
    orb: "/orbital-hub-midnight.webp",
    mark: "/brand/logos/soft-node/midnight-mark.webp",
  },
  {
    id: "aurora",
    label: "Aurora",
    description: "Bold. Dynamic. Inspiring.",
    mode: "light",
    preview: { background: "#f0f6fd", surface: "#dde9f8", accent: "#8a45f6" },
    orb: "/orbital-hub-aurora.webp",
    mark: "/brand/logos/soft-node/aurora-mark.webp",
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm. Creative. Optimistic.",
    mode: "light",
    preview: { background: "#faf7f8", surface: "#f1e6ea", accent: "#dd0374" },
    orb: "/orbital-hub-sunset.webp",
    mark: "/brand/logos/soft-node/sunset-mark.webp",
  },
  {
    id: "sage",
    label: "Sage",
    description: "Balanced. Natural. Sustainable.",
    mode: "light",
    preview: { background: "#f1f9f9", surface: "#dcefef", accent: "#024d58" },
    orb: "/orbital-hub-sage.webp",
    mark: "/brand/logos/soft-node/sage-mark.webp",
  },
  {
    id: "citrus",
    label: "Citrus",
    description: "Vibrant. Creative. Positive.",
    mode: "light",
    preview: { background: "#f9f8f7", surface: "#efebe6", accent: "#c74b05" },
    orb: "/orbital-hub-citrus.webp",
    mark: "/brand/logos/soft-node/citrus-mark.webp",
  },
];

export const DEFAULT_LIGHT_THEME = "daylight";
export const DEFAULT_DARK_THEME = "midnight";

export const THEME_IDS: string[] = THEMES.map((theme) => theme.id);

/**
 * Names stored before the palette themes existed, with the theme each one
 * means. `public/theme-init.js` rewrites a stored legacy name once; this map
 * covers the rest.
 */
export const LEGACY_THEME_ALIASES: Record<string, string> = {
  light: DEFAULT_LIGHT_THEME,
  dark: DEFAULT_DARK_THEME,
};

/**
 * next-themes' `value` map (the `data-theme` written for each name): every
 * theme id to itself, plus the legacy names.
 */
export const THEME_ATTRIBUTE_VALUES: Record<string, string> = {
  ...Object.fromEntries(THEME_IDS.map((id) => [id, id])),
  ...LEGACY_THEME_ALIASES,
};

/**
 * The theme definition for a stored or resolved name (next-themes'
 * `resolvedTheme`), legacy names included. Anything unknown falls back to
 * Daylight.
 */
export function themeFor(name: string | undefined | null): ThemeDefinition {
  const id = THEME_ATTRIBUTE_VALUES[name ?? ""] ?? DEFAULT_LIGHT_THEME;
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

/** The sidebar logo for a theme name: its own, or the default for its mode. */
export function logoFor(name: string | undefined | null): string {
  const theme = themeFor(name);
  return theme.logo ?? DEFAULT_LOGOS[theme.mode];
}

/**
 * The mAgenticX logo to draw: a theme's own `logo` (it only overrides the
 * mark), else the registry's artwork for the variant, in the ink for `on` —
 * the background it sits on — or, without one, for the theme's mode.
 */
export function brandLogoFor(
  variant: BrandLogoVariant,
  name: string | undefined | null,
  on?: ThemeMode,
): string {
  const theme = themeFor(name);
  if (variant === "mark" && theme.logo && (on === undefined || on === theme.mode)) {
    return theme.logo;
  }
  return BRAND_LOGOS[variant][on ?? theme.mode];
}

/** The orb artwork for a theme name: its own, or the default. */
export function orbFor(name: string | undefined | null): string {
  return themeFor(name).orb ?? DEFAULT_ORB;
}

/** The soft-node brand mark for a theme name: its own, or the default. */
export function markFor(name: string | undefined | null): string {
  return themeFor(name).mark ?? DEFAULT_MARK;
}

/**
 * The theme to store for what localStorage holds. A theme id stays; a legacy
 * "light" / "dark" becomes Daylight / Midnight; nothing stored, "system" (the
 * removed System option) or an unknown name becomes Daylight or Midnight from
 * the device's preference now. `public/theme-init.js` does the same before the
 * first paint; keep the two in step.
 */
export function resolveStoredTheme(stored: string | null | undefined, prefersDark: boolean): string {
  if (stored && THEME_IDS.includes(stored)) return stored;
  if (stored && LEGACY_THEME_ALIASES[stored]) return LEGACY_THEME_ALIASES[stored];
  return prefersDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

function prefersDarkScheme(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * The stored theme, migrated and written back as an explicit choice (a no-op
 * when theme-init.js already did it). Called once before next-themes mounts;
 * its result is next-themes' `defaultTheme`, so with storage blocked the app
 * still starts on the theme theme-init.js painted.
 */
export function migrateStoredTheme(storageKey = "theme"): string {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(storageKey);
  } catch {
    // No storage (private mode, blocked).
  }
  const theme = resolveStoredTheme(stored, prefersDarkScheme());
  if (stored !== theme) {
    try {
      window.localStorage.setItem(storageKey, theme);
    } catch {
      // No storage: the choice lasts for this page only.
    }
  }
  return theme;
}
