import { useEffect, useState, type CSSProperties } from "react";
import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
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
 * theme change cross-fades the artwork. Under reduced motion it holds still
 * and the glow alone tells the states apart.
 */
export function Orb({ state = "idle", size, label, className }: OrbProps) {
  const { resolvedTheme } = useTheme();
  const artwork = useOrbArtwork(orbFor(resolvedTheme));
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
                src={artwork.current}
                alt=""
                width={ORB_SIZE}
                height={ORB_SIZE}
                decoding="async"
                draggable={false}
                className="orb-image"
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
              <div className="orb-sheen" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
