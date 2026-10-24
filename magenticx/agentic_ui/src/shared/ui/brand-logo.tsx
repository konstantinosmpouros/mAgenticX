import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { brandLogoFor, type BrandLogoVariant, type ThemeMode } from "@/styles/theme/themes";

/**
 * The mAgenticX logo — the product's own, as opposed to the soft-node brand
 * mark (brand-mark.tsx) and the AI's orb. Its artwork lives in ONE place, the
 * theme registry (`BRAND_LOGOS` in styles/theme/themes.ts): swapping in a new
 * logo is changing the paths there.
 *
 * By default it takes the ink for the active theme. Pass `on` when it sits on
 * a surface that keeps its own colour whatever the theme (the always-dark
 * panels, the sign-in page's night sky), or `theme` to draw it as another
 * theme would (the theme cards in Settings). Decorative unless given a `label`.
 */
type BrandLogoProps = {
  variant?: BrandLogoVariant;
  /** The background it sits on, when that is not the active theme's. */
  on?: ThemeMode;
  /** Draw it as this theme would (defaults to the active theme). */
  theme?: string;
  /** Accessible name; omit when it is decoration next to the product's name. */
  label?: string;
  className?: string;
};

export function BrandLogo({ variant = "mark", on, theme, label, className }: BrandLogoProps) {
  const { resolvedTheme } = useTheme();
  return (
    <img
      src={brandLogoFor(variant, theme ?? resolvedTheme, on)}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={cn("object-contain", className)}
    />
  );
}
