import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";

// Canvas-2D constellation field: drifting nodes linked by lines that fade with
// distance, plus a gentle cursor attraction. Transparent — the caller paints
// the backdrop behind it. The field reads black-and-white (white nodes + white
// links); a small `accentRatio` of nodes use `accentColor` (the brand magenta
// `--primary` by default) and the cursor links glow in that accent, so colour
// concentrates where the user interacts. Colours resolve to rgb once at mount,
// so nothing is a hardcoded hex downstream.

type Particle = { x: number; y: number; vx: number; vy: number; accent: boolean };

interface ParticleNetworkProps {
  density?: number;
  maxDistance?: number;
  speed?: number;
  color?: string;
  accentColor?: string;
  lineColor?: string;
  accentRatio?: number;
  interactive?: boolean;
  maxParticles?: number;
  className?: string;
}

const FALLBACK_RGB: [number, number, number] = [208, 176, 255];

function resolveRgb(input?: string): [number, number, number] {
  let css = input;
  if (!css) {
    let triplet = "293 89% 74%";
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
      if (v) triplet = v;
    } catch {
      /* ignore — fall back to literal magenta */
    }
    css = `hsl(${triplet})`;
  }
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return FALLBACK_RGB;
  try {
    probe.fillStyle = "#000";
    probe.fillStyle = css;
  } catch {
    return FALLBACK_RGB;
  }
  const resolved = String(probe.fillStyle);
  if (resolved.startsWith("#")) {
    const hex = resolved.length === 4
      ? resolved.slice(1).split("").map((c) => c + c).join("")
      : resolved.slice(1);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = resolved.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : FALLBACK_RGB;
}

export default function ParticleNetwork({
  density = 1,
  maxDistance = 130,
  speed = 1,
  color = "#ffffff",
  accentColor,
  lineColor = "#ffffff",
  accentRatio = 0.18,
  interactive = true,
  maxParticles = 110,
  className,
}: ParticleNetworkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const [br, bg, bb] = resolveRgb(color);
    const [ar, ag, ab] = resolveRgb(accentColor);
    const [lr, lg, lb] = resolveRgb(lineColor);

    let width = 0;
    let height = 0;
    let raf = 0;
    const particles: Particle[] = [];
    const pointer = { x: -9999, y: -9999, active: false };

    const targetCount = () => {
      const area = width * height;
      return Math.min(maxParticles, Math.max(24, Math.round((area / 18000) * density)));
    };

    const seed = (n: number) => {
      while (particles.length < n) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.5 * speed,
          vy: (Math.random() - 0.5) * 0.5 * speed,
          accent: Math.random() < accentRatio,
        });
      }
      if (particles.length > n) particles.length = n;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed(targetCount());
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const cursorReach = maxDistance * 1.6;
      for (let i = 0; i < particles.length; i += 1) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j += 1) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < maxDistance) {
            ctx.strokeStyle = `rgba(${lr},${lg},${lb},${(1 - dist / maxDistance) * 0.32})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        if (interactive && pointer.active) {
          const dx = a.x - pointer.x;
          const dy = a.y - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < cursorReach) {
            ctx.strokeStyle = `rgba(${ar},${ag},${ab},${(1 - dist / cursorReach) * 0.6})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(pointer.x, pointer.y);
            ctx.stroke();
          }
        }
      }
      for (const p of particles) {
        if (p.accent) {
          ctx.fillStyle = `rgba(${ar},${ag},${ab},0.9)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = `rgba(${br},${bg},${bb},0.55)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const step = () => {
      const cursorReach = maxDistance * 1.6;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x <= 0 || p.x >= width) p.vx *= -1;
        if (p.y <= 0 || p.y >= height) p.vy *= -1;
        p.x = Math.max(0, Math.min(width, p.x));
        p.y = Math.max(0, Math.min(height, p.y));
        if (interactive && pointer.active) {
          const dx = pointer.x - p.x;
          const dy = pointer.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist < cursorReach && dist > 0.01) {
            const pull = (1 - dist / cursorReach) * 0.4 * speed;
            p.x += (dx / dist) * pull;
            p.y += (dy / dist) * pull;
          }
        }
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    };
    const onPointerOut = () => {
      pointer.active = false;
      pointer.x = -9999;
      pointer.y = -9999;
    };

    resize();
    window.addEventListener("resize", resize);

    if (reduceMotion) {
      // Static field: draw once, no loop, no cursor reaction.
      draw();
      return () => {
        window.removeEventListener("resize", resize);
      };
    }

    if (interactive) {
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("blur", onPointerOut);
      document.addEventListener("pointerleave", onPointerOut);
    }
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onPointerOut);
      document.removeEventListener("pointerleave", onPointerOut);
    };
  }, [reduceMotion, density, maxDistance, speed, color, accentColor, lineColor, accentRatio, interactive, maxParticles]);

  return <canvas ref={canvasRef} className={cn("h-full w-full", className)} aria-hidden="true" />;
}
