import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * The liquid inside a glass artwork (the orb, the brand mark): a slow ripple
 * of the image itself. An SVG filter displaces the picture by a drifting
 * fractal noise, and only its core: the displaced copy is masked by the
 * artwork's own alpha shrunk inwards (eroded, then feathered), the untouched
 * original fills the rim band and everything is cut to the original alpha
 * again, so the silhouette and the glass edge never move.
 *
 * The noise drifts and breathes on a requestAnimationFrame loop whose tempo
 * and strength ease towards the caller's `motion` (~0.4s), so a state change
 * glides instead of jumping. The loop stops when the artwork is off screen,
 * under reduced motion, on a two-core device and below `minSize` (a 26px ball
 * gains nothing but cost); the filter is then not applied at all.
 */
export type LiquidMotion = {
  /** Tempo, 1 = the calm idle flow (one sway every ~9s). */
  speed: number;
  /** Ripple strength as a fraction of the artwork's edge (0.05 = 5%). */
  amount: number;
  /** Modulate the strength in a speech-like rhythm (the orb's speaking state). */
  rhythm?: boolean;
};

type LiquidOptions = {
  /** Below this edge length (px) the ripple is off. */
  minSize?: number;
  /** Width of the untouched rim band, as a fraction of the edge. */
  rim?: number;
};

type Liquid = {
  /** The hidden <svg> holding the filter; render it once next to the artwork. */
  filter: ReactNode;
  /** The style for the artwork <img>: the filter while it runs, else nothing. */
  imageStyle: CSSProperties | undefined;
};

/** Speech-like envelope over 1.4s (the orb-speak keyframes in styles/orb.css). */
const SPEECH = [0, 0.8, 0.25, 1, 0.35, 0.75, 0.15, 0];
const SPEECH_AT = [0, 0.12, 0.24, 0.38, 0.52, 0.64, 0.8, 1];
function speechEnvelope(t: number): number {
  const p = (t / 1.4) % 1;
  for (let i = 1; i < SPEECH_AT.length; i++) {
    if (p <= SPEECH_AT[i]) {
      const k = (p - SPEECH_AT[i - 1]) / (SPEECH_AT[i] - SPEECH_AT[i - 1]);
      const eased = k * k * (3 - 2 * k);
      return SPEECH[i - 1] + (SPEECH[i] - SPEECH[i - 1]) * eased;
    }
  }
  return 0;
}

const LOW_POWER = typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 2;

export function useLiquid(
  rootRef: RefObject<HTMLElement | null>,
  motion: LiquidMotion,
  { minSize = 48, rim = 0.07 }: LiquidOptions = {},
): Liquid {
  const id = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const reduced = useReducedMotion() ?? false;
  const [size, setSize] = useState(0);
  const target = useRef(motion);
  target.current = motion;

  const turbulence = useRef<SVGFETurbulenceElement>(null);
  const offset = useRef<SVGFEOffsetElement>(null);
  const displace = useRef<SVGFEDisplacementMapElement>(null);

  // The edge length in CSS px: the filter works in the element's own pixels.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize(Math.round(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef]);

  const active = !reduced && !LOW_POWER && size >= minSize;

  useEffect(() => {
    if (!active) return;
    const el = rootRef.current;
    let frame = 0;
    let visible = true;
    let last = 0;
    let phase = Math.random() * 100; // two orbs never ripple in step
    let clock = 0;
    let speed = target.current.speed;
    let amount = target.current.amount;
    let rhythm = target.current.rhythm ? 1 : 0;
    const baseFreq = 2.6 / size; // features about a third of the artwork across
    const travel = size * 0.09; // how far the noise drifts each way

    const tick = (now: number) => {
      frame = 0;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      // Ease tempo and strength towards the state's (time constant ~0.4s).
      const ease = 1 - Math.exp(-dt / 0.4);
      const goal = target.current;
      speed += (goal.speed - speed) * ease;
      amount += (goal.amount - amount) * ease;
      rhythm += ((goal.rhythm ? 1 : 0) - rhythm) * ease;
      phase += dt * speed * 0.7;
      clock += dt;

      const dx = Math.sin(phase) * travel;
      const dy = Math.cos(phase * 0.77 + 1.3) * travel;
      const fx = baseFreq * (1 + 0.08 * Math.sin(phase * 0.53));
      const fy = baseFreq * (1 + 0.08 * Math.cos(phase * 0.41 + 0.6));
      const pulse = 1 + rhythm * (speechEnvelope(clock) * 0.9 - 0.35);
      turbulence.current?.setAttribute("baseFrequency", `${fx.toFixed(5)} ${fy.toFixed(5)}`);
      offset.current?.setAttribute("dx", dx.toFixed(2));
      offset.current?.setAttribute("dy", dy.toFixed(2));
      displace.current?.setAttribute("scale", (amount * size * pulse).toFixed(2));
      if (visible) frame = requestAnimationFrame(tick);
    };

    const observer =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            if (visible && !frame) {
              last = 0;
              frame = requestAnimationFrame(tick);
            }
          })
        : null;
    if (el) observer?.observe(el);
    frame = requestAnimationFrame(tick);
    return () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, size, rootRef]);

  if (!active) return { filter: null, imageStyle: undefined };

  const margin = size * 0.1;
  const rimPx = Math.max(1, size * rim);
  const filter = (
    <svg aria-hidden width="0" height="0" focusable="false" style={{ position: "absolute", width: 0, height: 0 }}>
      <filter
        id={id}
        filterUnits="userSpaceOnUse"
        x={-margin}
        y={-margin}
        width={size + margin * 2}
        height={size + margin * 2}
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          ref={turbulence}
          type="fractalNoise"
          baseFrequency={2.6 / size}
          numOctaves={1}
          seed={7}
          result="noise"
        />
        <feOffset ref={offset} in="noise" dx="0" dy="0" result="drift" />
        <feDisplacementMap
          ref={displace}
          in="SourceGraphic"
          in2="drift"
          scale={motion.amount * size}
          xChannelSelector="R"
          yChannelSelector="G"
          result="shifted"
        />
        {/* The displacement samples nearest-neighbour: a hair of blur keeps the
            artwork's inner edges smooth instead of stair-stepped. */}
        <feGaussianBlur in="shifted" stdDeviation="0.6" result="flow" />
        <feMorphology in="SourceAlpha" operator="erode" radius={rimPx.toFixed(1)} result="core" />
        <feGaussianBlur in="core" stdDeviation={(rimPx * 0.45).toFixed(1)} result="coreSoft" />
        <feComposite in="flow" in2="coreSoft" operator="in" result="inner" />
        <feComposite in="SourceGraphic" in2="coreSoft" operator="out" result="rim" />
        <feComposite in="inner" in2="rim" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="mixed" />
        <feComposite in="mixed" in2="SourceAlpha" operator="in" />
      </filter>
    </svg>
  );
  return { filter, imageStyle: { filter: `url(#${id})` } };
}
