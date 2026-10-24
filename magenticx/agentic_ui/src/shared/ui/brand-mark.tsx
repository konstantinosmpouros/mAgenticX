import { useRef, type CSSProperties } from "react";
import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { useLiquid, type LiquidMotion } from "@/shared/ui/liquid";
import { markFor } from "@/styles/theme/themes";

/**
 * The "soft node" brand mark — a rounded glass diamond with a wave — in the
 * active theme's colours (`mark` in styles/theme/themes.ts). Used where the
 * page speaks for the product rather than for the AI (the orb stays the AI's):
 * the Schedules page today.
 *
 * Decorative by default (empty alt); pass `label` when it stands alone. It
 * floats and glows gently, the liquid inside its glass ripples calmly
 * (shared/ui/liquid.tsx) with the theme's colours drifting through it, and it
 * holds still under reduced motion (styles/brand-mark.css).
 */
type BrandMarkProps = {
  /** Rendered size in px (square). */
  size: number;
  /** Accessible name; omit when the mark is decoration next to a heading. */
  label?: string;
  className?: string;
};

/** The artwork's intrinsic size (every theme's mark is a 512px square WebP). */
const MARK_SIZE = 512;

/** A calm, idle-only flow: slower and gentler than the orb's. */
const MARK_LIQUID: LiquidMotion = { speed: 0.8, amount: 0.045 };

export function BrandMark({ size, label, className }: BrandMarkProps) {
  const { resolvedTheme } = useTheme();
  const art = markFor(resolvedTheme);
  const root = useRef<HTMLSpanElement>(null);
  const liquid = useLiquid(root, MARK_LIQUID, { rim: 0.06 });
  return (
    <span
      ref={root}
      className={cn("brand-mark", className)}
      style={{ width: size, height: size, "--mark-art": `url("${art}")` } as CSSProperties}
      data-testid="brand-mark"
    >
      <span aria-hidden className="brand-mark-glow" />
      <span className="brand-mark-float">
        <img
          src={art}
          width={MARK_SIZE}
          height={MARK_SIZE}
          alt={label ?? ""}
          aria-hidden={label ? undefined : true}
          decoding="async"
          draggable={false}
          style={liquid.imageStyle}
        />
        <span aria-hidden className="brand-mark-flow brand-mark-flow-color">
          <span className="brand-mark-drift" />
        </span>
        <span aria-hidden className="brand-mark-flow brand-mark-flow-light">
          <span className="brand-mark-caustic" />
        </span>
      </span>
      {liquid.filter}
    </span>
  );
}
