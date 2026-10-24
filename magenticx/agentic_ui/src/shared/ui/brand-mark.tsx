import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { AnimatedLogo } from "@/shared/ui/logo/animated-logo";
import { MARK_MOTION } from "@/shared/ui/logo/motion";
import { markFor } from "@/styles/theme/themes";

/**
 * The "soft node" brand mark — a rounded glass knot — in the active theme's
 * colours (`mark` in styles/theme/themes.ts). Used where the page speaks for
 * the product rather than for the AI (the orb stays the AI's): the Schedules
 * page today.
 *
 * Decorative by default; pass `label` when it stands alone. It floats over the
 * orb's halo (styles/brand-mark.css), the liquid inside its glass flows and,
 * now and then, it turns a third of the way round (AnimatedLogo, a WebGL shader
 * on the artwork's own pixels). It holds still under reduced motion.
 */
type BrandMarkProps = {
  /** Rendered size in px (square). */
  size: number;
  /** Accessible name; omit when the mark is decoration next to a heading. */
  label?: string;
  className?: string;
};

export function BrandMark({ size, label, className }: BrandMarkProps) {
  const { resolvedTheme } = useTheme();
  return (
    <span
      className={cn("brand-mark", className)}
      style={{ width: size, height: size }}
      data-testid="brand-mark"
    >
      <span aria-hidden className="brand-mark-glow" />
      <span className="brand-mark-float">
        <AnimatedLogo
          src={markFor(resolvedTheme)}
          motion={MARK_MOTION}
          label={label}
          className="absolute inset-0 size-full"
        />
      </span>
    </span>
  );
}
