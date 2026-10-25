import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import {
  BRAND_LOGO_LAYERS,
  brandLogoFor,
  brandLogoLayersFor,
  type BrandLogoVariant,
  type ThemeMode,
} from "@/styles/theme/themes";

/** How much the animated logo moves (styles/brand-logo.css). */
export type BrandLogoMotion = "gentle" | "lively";

/**
 * The mAgenticX logo — the product's own, as opposed to the soft-node brand
 * mark (brand-mark.tsx) and the AI's orb. Its artwork lives in ONE place, the
 * theme registry (`BRAND_LOGOS` and each theme's `logo` in
 * styles/theme/themes.ts): swapping in a new logo is changing the paths there.
 *
 * By default it takes the active theme's artwork. Pass `on` when it sits on a
 * surface that keeps its own colour whatever the theme (the always-dark
 * panels, the sign-in page's night sky), or `theme` to draw it as another
 * theme would (the theme cards in Settings). Decorative unless given a `label`.
 *
 * `animated` brings the cubes to life (styles/brand-logo.css): the cluster
 * floats and the three small cubes drift loose and settle back, each on its
 * own rhythm. `"gentle"` is the small, slow drift for the logo in the app's
 * chrome (the sidebar, the panels); `"lively"` is the sign-in page's, where the
 * cubes wander further. It stacks the logo's four parts (`brandLogoLayersFor`),
 * which at rest are the logo exactly; a theme without them, or reduced motion,
 * shows the still logo. Size it with width AND height (the stack is square).
 */

type BrandLogoProps = {
  variant?: BrandLogoVariant;
  /** The background it sits on, when that is not the active theme's. */
  on?: ThemeMode;
  /** Draw it as this theme would (defaults to the active theme). */
  theme?: string;
  /** Accessible name; omit when it is decoration next to the product's name. */
  label?: string;
  /** Let the cubes move, and how much. */
  animated?: BrandLogoMotion;
  className?: string;
};

export function BrandLogo({
  variant = "mark",
  on,
  theme,
  label,
  animated,
  className,
}: BrandLogoProps) {
  const { resolvedTheme } = useTheme();
  const name = theme ?? resolvedTheme;
  const layers = animated ? brandLogoLayersFor(name) : null;

  if (layers) {
    return (
      <span
        className={cn(
          "brand-logo-animated relative inline-block",
          `brand-logo-${animated}`,
          className,
        )}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        {layers.map((src, index) => (
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            className={`brand-logo-layer brand-logo-${BRAND_LOGO_LAYERS[index]}`}
          />
        ))}
      </span>
    );
  }

  return (
    <img
      src={brandLogoFor(variant, name, on)}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={cn("object-contain", className)}
    />
  );
}
