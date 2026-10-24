import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";

import { LogoRenderer } from "./logo-renderer";
import { ACTIVE_BOOST, type MotionPreset } from "./motion";

type AnimatedLogoProps = {
  /** The artwork (the active theme's, from the theme registry). */
  src: string;
  motion: MotionPreset;
  /** While the AI works: faster flow and a gentle pulse. */
  active?: boolean;
  /** Size it with width and height classes; the artwork fills the square. */
  className?: string;
  /** Accessible name; leave out for a decorative artwork. */
  label?: string;
};

const TAU = Math.PI * 2;
/** Seconds over which the motion grows from the still image. */
const RAMP_SECONDS = 1.2;
const MAX_CANVAS_PX = 1024;

/**
 * An artwork, animated: its own pixels moved by a WebGL shader (see
 * `logo-renderer.ts`) — the liquid inside flows while the outline stays. A
 * new `src` (a theme change) crossfades in. Paused while off screen or in a
 * hidden tab. Reduced motion, or no WebGL, shows the still image.
 */
export function AnimatedLogo({ src, motion, active = false, className, label }: AnimatedLogoProps) {
  const reduceMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LogoRenderer | null>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [mode, setMode] = useState<"loading" | "live" | "still">(reduceMotion ? "still" : "loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (reduceMotion || !canvas) {
      setMode("still");
      return;
    }
    const renderer = LogoRenderer.create(canvas);
    if (!renderer) {
      setMode("still");
      return;
    }
    rendererRef.current = renderer;
    renderer.setMotion(motion);
    setMode("loading");

    loadedSrcRef.current = srcRef.current;
    renderer.setImage(srcRef.current).then(
      () => renderer.ready && setMode((prev) => (prev === "still" ? prev : "live")),
      () => setMode("still"),
    );

    const size = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const side = Math.min(MAX_CANVAS_PX, Math.round(canvas.clientWidth * ratio));
      if (side > 0) renderer.resize(side, side);
    };
    size();
    const resizeObserver = new ResizeObserver(size);
    resizeObserver.observe(canvas);

    // The loop: phase advances with the (eased) speed; amplitude ramps up from
    // zero once, so the first frame is the still image.
    let phase = 0;
    let ramp = 0;
    let liveliness = 0;
    let last = 0;
    let frame = 0;
    let onScreen = true;
    let contextLost = false;
    const tick = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const target = activeRef.current ? 1 : 0;
      liveliness += (target - liveliness) * Math.min(1, dt * 2.5);
      const speed = 1 + (ACTIVE_BOOST.speed - 1) * liveliness;
      phase = (phase + (dt * speed * TAU) / motion.period) % TAU;
      ramp = Math.min(1, ramp + dt / RAMP_SECONDS);
      renderer.setLiveliness(
        motion.flow * (1 + (ACTIVE_BOOST.flow - 1) * liveliness),
        motion.breath + ACTIVE_BOOST.breath * liveliness,
      );
      renderer.draw(phase, ramp * ramp * (3 - 2 * ramp));
      frame = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      if (onScreen && !contextLost && !document.hidden) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const intersection = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      run();
    });
    intersection.observe(canvas);
    document.addEventListener("visibilitychange", run);
    // Browsers drop the oldest contexts when too many are open: show the still image.
    const lost = () => {
      contextLost = true;
      cancelAnimationFrame(frame);
      setMode("still");
    };
    canvas.addEventListener("webglcontextlost", lost);
    run();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", run);
      canvas.removeEventListener("webglcontextlost", lost);
      renderer.dispose();
      rendererRef.current = null;
      loadedSrcRef.current = null;
    };
  }, [motion, reduceMotion]);

  // A theme switch: the new artwork crossfades in.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || loadedSrcRef.current === src) return;
    loadedSrcRef.current = src;
    renderer.setImage(src).catch(() => setMode("still"));
  }, [src]);

  // The still image, placed where the canvas draws the artwork, so the swap is seamless.
  const stillStyle = { transform: `scale(${motion.scale})` };

  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {mode !== "live" && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full select-none object-contain"
          style={stillStyle}
        />
      )}
      {mode !== "still" && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ opacity: mode === "live" ? 1 : 0 }}
        />
      )}
    </span>
  );
}
