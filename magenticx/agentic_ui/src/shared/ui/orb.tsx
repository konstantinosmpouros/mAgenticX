import type { CSSProperties } from "react";
import { cn } from "@/shared/lib/utils";

// The artwork at full size (1254px square, ~700 KB), shared by every orb on the
// page: one URL, so the browser fetches and decodes it once whatever the number
// of orbs or their sizes. The explicit size reserves its box and the decode stays
// off the main thread. Swap this (or pick it per theme) to change the logo.
const ORB_SRC = "/orbital-hub-transparent.webp";
const ORB_SIZE = 1254;

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
 * The AI orb: the artwork over a soft halo of its own colours, animated per
 * state (styles/orb.css). One component, so a different (or per-theme) logo
 * replaces just this. Every state change eases over (the motion amplitudes are
 * transitioned custom properties, the extra layers cross-fade) and nothing but
 * transform, opacity and filter moves. Under reduced motion it holds still and
 * the glow alone tells the states apart.
 */
export function Orb({ state = "idle", size, label, className }: OrbProps) {
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
              <img
                src={ORB_SRC}
                alt=""
                width={ORB_SIZE}
                height={ORB_SIZE}
                decoding="async"
                draggable={false}
                className="orb-image"
              />
              <div className="orb-sheen" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
