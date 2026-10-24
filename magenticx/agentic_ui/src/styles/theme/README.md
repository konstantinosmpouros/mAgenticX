# Theme

Every color of the app is defined in this folder. Components use the semantic
tokens (`bg-background`, `text-primary`, `border-border`, ...) and never raw
colors, so changing a palette or adding a theme only touches these files.

| File | Holds |
|---|---|
| `palette.css` | The six palettes, four swatches each (`--daylight-1` ... `--citrus-4`), and the shared ink. |
| `light.css` | The tokens every light theme shares, written in terms of each theme's roles. |
| `daylight.css`, `aurora.css`, `sunset.css`, `sage.css`, `citrus.css` | One light theme each: only its roles (primary, glow, gradient, surface tint, orb halo). Daylight is also the default (`:root`). |
| `midnight.css` | The dark theme, in full; also the always-dark scope (`.dark`). |
| `themes.ts` | The list of themes (id, label, tagline, light or dark, picker colors, optional `logo`, `orb` and `mark`), `themeFor`, `logoFor`, `orbFor`, `markFor`. |

## Swatches and the primary color

A theme's swatches are for decoration (gradients, glows, the picker). Text,
links and buttons use `--theme-primary`: one of the swatches, deepened until
white text on it reaches 4.5:1 (on Midnight, lifted until it reads on navy).
Each theme file says which swatch it uses and why. The orb's halo uses
`--orb-glow-1..3` (`../orb.css`); sub-agent cards use `--subagent-active*`
(the primary and the glow).

## How a theme is applied

- The saved choice (localStorage `theme`) sets `data-theme="<id>"` on
  `<html>`; the theme's file sets its values under `:root[data-theme="<id>"]`.
  There is no System option: on a first visit (nothing stored, or a `system`
  stored before the option was removed) the device's preference picks Daylight
  or Midnight once, and that is stored as an explicit choice
  (`resolveStoredTheme` in `themes.ts`, mirrored in `theme-init.js`). Later
  changes to the device's preference do not change the theme.
- A dark theme also gets the `dark` class, which Tailwind's `dark:` variant
  uses, and `color-scheme: dark`. Surfaces that carry `dark` themselves take
  Midnight's tokens in every theme.
- `public/theme-init.js` applies the saved theme before the app renders (no
  flash of the default) and writes the migrated choice back once: a legacy
  `light` / `dark` becomes `daylight` / `midnight`, a missing or `system` value
  the theme the device prefers. `App.tsx` runs the same migration
  (`migrateStoredTheme`) before next-themes mounts and passes its result as
  `defaultTheme` (`enableSystem` is off), so the two always agree; next-themes
  (with `THEME_ATTRIBUTE_VALUES` as its `value` map) and `ThemeModeSync`
  (`src/shared/ui/theme-mode-sync.tsx`) keep it in step afterwards.
- Code that needs light vs dark asks `themeFor(resolvedTheme).mode`, never
  `resolvedTheme === "dark"`, so it keeps working for every theme.

## Adding a palette

1. Add its four swatches to `palette.css` (`--<id>-1` ... `--<id>-4`; the
   picker card reads them).
2. A light theme: copy `aurora.css` to `<id>.css` and set its roles and its
   `--orb-glow-*`. A dark theme: copy `midnight.css` and set its tokens.
3. Import it in `src/index.css`, with the other themes (before `midnight.css`).
4. Add it to `THEMES` in `themes.ts` (label, tagline, mode, preview colors,
   and its `orb` and `mark` artwork — see below).
   Settings → General lists it from there.
5. Add its id to `THEMES` in `public/theme-init.js`, and to `DARK_THEMES` there
   if it is dark.

## A per-theme logo, orb or brand mark

All three are optional fields of the theme's `THEMES` entry; without them a
theme gets the default (`DEFAULT_LOGOS[mode]`, `DEFAULT_ORB` (the Daylight
orb), `DEFAULT_MARK` (the Daylight mark)).
Every theme has its own orb today (`public/orbital-hub-<id>.webp`, Daylight's
is `orbital-hub-transparent.webp`) and its own mark
(`public/brand/logos/soft-node/<id>-mark.webp`); the logo is still the shared
one per mode.

- Logo: put the file in `public/` and set `logo: "/<file>"`. The sidebar and the
  theme's card in Settings → General use it (`logoFor`).
- Orb: put a square WebP (1254px, transparent background) in `public/` and set
  `orb: "/<file>.webp"`. Every orb uses it (`orbFor`, `src/shared/ui/orb.tsx`);
  only the active theme's file is fetched, and a theme change cross-fades it.
  Retune that theme's `--orb-glow-1..3` in its CSS file to the artwork's own
  colours, so the halo matches it.
- Brand mark (the "soft node": a rounded glass diamond with a wave): put a
  square WebP (512px, transparent background, ~30 KB) in
  `public/brand/logos/soft-node/<id>-mark.webp` and set
  `mark: "/brand/logos/soft-node/<id>-mark.webp"`. `BrandMark`
  (`src/shared/ui/brand-mark.tsx`, styled by `src/styles/brand-mark.css`) draws
  it at the size the caller gives, floating over a glow in the theme's
  `--primary`, still under reduced motion. It stands for the product where
  the orb would wrongly stand for the AI (the Schedules page); the orb stays
  the AI's. Export only the mark — the large PNG, card and lockup files stay
  in the brand source.
