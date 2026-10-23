# Theme

Every color of the app is defined in this folder. Components use the semantic
tokens (`bg-background`, `text-primary`, `border-border`, ...) and never raw
colors, so changing a palette or adding a theme only touches these files.

| File | Holds |
|---|---|
| `light.css` | The Light theme, which is also the default: every token, on `:root`. |
| `dark.css` | The Dark theme, in full, under `:root[data-theme="dark"]`; also the always-dark scope (`.dark`). |
| `themes.ts` | The list of themes: id, label, light or dark, sidebar logo, settings swatch. |

## How a theme is applied

- The saved choice (localStorage `theme`, or the system preference, which
  resolves to `light` or `dark`) sets `data-theme="<id>"` on `<html>`; the
  theme's file sets its values under `:root[data-theme="<id>"]`.
- A dark theme also gets the `dark` class, which Tailwind's `dark:` variant
  uses, and `color-scheme: dark`.
- `public/theme-init.js` applies the saved theme before the app renders (no
  flash of the default); next-themes and `ThemeModeSync`
  (`src/shared/ui/theme-mode-sync.tsx`) keep it in step afterwards.
- Code that needs light vs dark asks `themeFor(resolvedTheme).mode`, never
  `resolvedTheme === "dark"`, so it keeps working for every theme.

## Adding a theme

1. Copy `light.css` (a light theme) or `dark.css` (a dark one) to `<id>.css`,
   put its tokens under `:root[data-theme="<id>"]` (a light theme only needs
   the tokens that differ from Light) and set its colors.
2. Import it in `src/index.css`, after `dark.css`.
3. Add it to `THEMES` in `themes.ts` (label, mode, logo, swatch). Settings →
   General lists it from there.
4. If it is dark, add its id to `DARK_THEMES` in `public/theme-init.js`.
