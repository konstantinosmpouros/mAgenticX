import type { CSSProperties } from "react";
import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { AnimatedLogo } from "@/shared/ui/logo/animated-logo";
import { ORB_MOTION } from "@/shared/ui/logo/motion";
import { orbFor } from "@/styles/theme/themes";

/**
 * What the orb is doing. `idle` floats and breathes; `listening` brightens and
 * pulses steadily; `thinking` turns its glow faster with a highlight orbiting
 * the sphere; `speaking` pulses in a speech-like rhythm; `asleep` (voice muted,
 * or the session dropped) dims and slows down.
 */
export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

type OrbProps = {
  state?: OrbState;
  /** Edge length in px (or any CSS length). Omit to size it with `className`. */
  size?: number | string;
  /** Read out as an image when set; otherwise the orb is decorative. */
  label?: string;
  className?: string;
};

/**
 * The AI orb: the active theme's artwork (`orb` in themes.ts) over a soft halo
 * of its colours (--orb-glow-* in its CSS), animated per state
 * (styles/orb.css). Inside the glass the liquid flows and swirls while the
 * outline stays (AnimatedLogo, a WebGL shader on the artwork's own pixels),
 * livelier while the AI thinks or speaks; a theme change crossfades the
 * artwork. Every state change eases over (the motion amplitudes are
 * transitioned custom properties, the extra layers cross-fade). Under reduced
 * motion it holds still and the glow alone tells the states apart.
 */
export function Orb({ state = "idle", size, label, className }: OrbProps) {
  const { resolvedTheme } = useTheme();
  const style: CSSProperties | undefined =
    size === undefined
      ? undefined
      : {
          width: typeof size === "number" ? `${size}px` : size,
          height: typeof size === "number" ? `${size}px` : size,
        };
  return (
    <div
      className={cn("orb", className)}
      data-state={state}
      style={style}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <div className="orb-aura">
        <div className="orb-aura-breathe">
          <div className="orb-aura-spin" />
        </div>
        <div className="orb-aura-swirl" />
        <div className="orb-aura-pulse" />
        <div className="orb-aura-voice" />
      </div>
      <div className="orb-orbit" />
      <div className="orb-body">
        <div className="orb-float">
          <div className="orb-listen">
            <div className="orb-speak">
              <AnimatedLogo
                src={orbFor(resolvedTheme)}
                motion={ORB_MOTION}
                active={state === "thinking" || state === "speaking"}
                className="absolute inset-0 size-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
