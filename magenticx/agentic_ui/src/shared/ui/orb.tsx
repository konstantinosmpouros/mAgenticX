import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { useLiquid, type LiquidMotion } from "@/shared/ui/liquid";
import { orbFor } from "@/styles/theme/themes";

// The artwork is the active theme's (`orb` in styles/theme/themes.ts), at full
// size and shared by every orb on the page: one URL, so the browser fetches and
// decodes it once whatever the number of orbs or their sizes, and only the
// active theme's is ever fetched. The explicit size reserves its box and the
// decode stays off the main thread. Per-theme artwork keeps this square size.
const ORB_SIZE = 1254;
/** How long the old artwork takes to fade out over the new one (styles/orb.css). */
const ORB_SWAP_MS = 450;

/**
 * The artwork to show for `src`, and the one it replaces while that fades out.
 * A new theme's artwork is decoded before it is swapped in, so the orb never
 * blanks; the previous one then fades out on top of it.
 */
function useOrbArtwork(src: string): { current: string; leaving: string | null } {
  const [current, setCurrent] = useState(src);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    if (src === current) return;
    let cancelled = false;
    const next = new Image();
    next.decoding = "async";
    next.src = src;
    const swap = () => {
      if (cancelled) return;
      setLeaving(current);
      setCurrent(src);
    };
    next.decode().then(swap, swap);
    return () => {
      cancelled = true;
    };
  }, [src, current]);

  useEffect(() => {
    if (!leaving) return;
    // A timer, not animationend: under reduced motion there is no animation.
    const timer = window.setTimeout(() => setLeaving(null), ORB_SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return { current, leaving };
}

/**
 * What the orb is doing. `idle` floats and breathes; `listening` brightens and
 * pulses steadily; `thinking` turns its glow faster with a highlight orbiting
 * the sphere; `speaking` pulses in a speech-like rhythm; `asleep` (voice muted,
 * or the session dropped) dims and slows down.
 */
export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

/**
 * The ripple of the liquid inside the glass, per state (shared/ui/liquid.tsx):
 * calm when idle, livelier listening, a fast swirl thinking, in the speech
 * rhythm speaking, nearly still asleep. The light flowing inside is CSS
 * (.orb-flow in styles/orb.css).
 */
const ORB_LIQUID: Record<OrbState, LiquidMotion> = {
  idle: { speed: 1, amount: 0.05 },
  listening: { speed: 1.6, amount: 0.06 },
  thinking: { speed: 2.8, amount: 0.06 },
  speaking: { speed: 1.5, amount: 0.065, rhythm: true },
  asleep: { speed: 0.2, amount: 0.02 },
};

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
 * state (styles/orb.css). The artwork and the halo's colours follow the active
 * theme (`orb` in themes.ts, --orb-glow-* in its CSS). Every state change eases
 * over (the motion amplitudes are transitioned custom properties, the extra
 * layers cross-fade) and nothing but transform, opacity and filter moves; a
 * theme change cross-fades the artwork. Inside the glass the liquid moves too:
 * the artwork ripples (an SVG displacement that leaves the rim untouched) and
 * light in the theme's colours flows through it, masked to its shape. Under
 * reduced motion it holds still and the glow alone tells the states apart.
 */
export function Orb({ state = "idle", size, label, className }: OrbProps) {
  const { resolvedTheme } = useTheme();
  const artwork = useOrbArtwork(orbFor(resolvedTheme));
  const root = useRef<HTMLDivElement>(null);
  const liquid = useLiquid(root, ORB_LIQUID[state]);
  // The artwork doubles as the mask of the light flowing inside it.
  const style = {
    "--orb-art": `url("${artwork.current}")`,
    ...(size === undefined
      ? null
      : {
          width: typeof size === "number" ? `${size}px` : size,
          height: typeof size === "number" ? `${size}px` : size,
        }),
  } as CSSProperties;
  return (
    <div
      ref={root}
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
                src={artwork.current}
                alt=""
                width={ORB_SIZE}
                height={ORB_SIZE}
                decoding="async"
                draggable={false}
                className="orb-image"
                style={liquid.imageStyle}
              />
              {artwork.leaving ? (
                <img
                  key={artwork.leaving}
                  src={artwork.leaving}
                  alt=""
                  width={ORB_SIZE}
                  height={ORB_SIZE}
                  decoding="async"
                  draggable={false}
                  className="orb-image orb-image-leaving"
                />
              ) : null}
              <div className="orb-flow orb-flow-color">
                <div className="orb-flow-drift" />
                <div className="orb-flow-swirl" />
              </div>
              <div className="orb-flow orb-flow-light">
                <div className="orb-flow-caustic" />
                <div className="orb-flow-voice" />
              </div>
              <div className="orb-sheen" />
            </div>
          </div>
        </div>
      </div>
      {liquid.filter}
    </div>
  );
}
