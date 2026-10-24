import { memo, useEffect, useRef } from "react";

/**
 * The sign-in page's sky (pages/Login.tsx; its gradient, drifting nebula glow
 * and horizon are CSS, styles/login.css). Two canvases:
 *
 * - The deep sky, drawn once per size and theme: the Milky Way crossing it
 *   diagonally (a very faint haze, a darker dust lane, fine star dust), one
 *   soft nebula high in a far corner, and two small dim galaxies near the
 *   edges (a tilted spiral, an elliptical): the middle stays clear dark sky.
 * - The live sky, drawn each frame: stars in three depths, each depth drifting
 *   west at its own pace and every star twinkling on its own; three or four
 *   bright stars near the edges with soft cross-shaped sparkles; and falling
 *   stars — one every two to four seconds, now and then two close together,
 *   most of them faint and thin, and every twenty to thirty seconds a bright
 *   one with a long glowing tail and a flare at its head.
 *
 * Every colour beyond white comes from the theme's orb hues (--orb-glow-1..3),
 * so each theme's night is its own. The layout is seeded: the same sky on
 * every visit. A frame is a few hundred dots and a handful of gradients — well
 * under a millisecond at 1440×900. The loop stops while the tab is hidden.
 * Reduced motion draws everything once, still, without falling stars.
 */

type Tint = [hue: number, saturation: number];

type Star = {
  /** Position, 0..1 of the canvas. */
  x: number;
  y: number;
  /** Radius in CSS px. */
  r: number;
  alpha: number;
  /** Twinkle: how deep, how fast (radians per second), where it starts. */
  depth: number;
  speed: number;
  phase: number;
  /** -1 for white, else the index of the theme hue it takes. */
  tint: number;
  layer: number;
};

type Sparkle = { x: number; y: number; size: number; speed: number; phase: number; tint: number };

type FallingStar = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Full tail length in px; it grows to it as the star gets going. */
  length: number;
  width: number;
  brightness: number;
  /** Lifetime and age, in seconds. */
  life: number;
  age: number;
  tint: number;
  /** The rare bright one: a longer, glowing tail and a flare at the head. */
  bright: boolean;
};

/** Per depth: stars per 10,000 px², radius range, brightness range, westward drift (px/s). */
const LAYERS = [
  { density: 1.6, r: [0.35, 0.75], alpha: [0.25, 0.6], drift: 1.2, twinkle: 0.35 },
  { density: 0.5, r: [0.7, 1.15], alpha: [0.45, 0.85], drift: 2.6, twinkle: 0.45 },
  { density: 0.07, r: [1.1, 1.7], alpha: [0.75, 1], drift: 4.5, twinkle: 0.55 },
] as const;
/** Bright stars with a cross-shaped sparkle: three, a fourth on big screens. */
const SPARKLES = [3, 4] as const;
const MAX_FALLING = 3;
/** Seconds between falling stars; now and then a second follows close behind. */
const NEXT_FALL = [2, 4] as const;
const IN_BURST = [0.25, 0.6] as const;
const BURST_CHANCE = 0.12;
/** Most are faint and thin; a bright one comes on its own clock. */
const FAINT_CHANCE = 0.7;
const NEXT_BRIGHT = [20, 30] as const;
/** The falling stars share a radiant: they all come down at about this angle (degrees, y down). */
const RAIN_ANGLE = 126;
/** The deep sky is soft: drawn at up to 1.5x, the live sky (fine dots) at up to 2x. */
const DEEP_RATIO = 1.5;
const LIVE_RATIO = 2;
/** With nothing falling, a paint at most every 30 ms (30 a second on a 60 Hz screen). */
const IDLE_FRAME_MS = 30;

const TAU = Math.PI * 2;

/** A small seeded generator (mulberry32): the same sky on every visit. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const between = (random: Random, range: readonly [number, number]) =>
  range[0] + random() * (range[1] - range[0]);
/** Roughly normal, mean 0, spread about 1. */
const gaussian = (random: Random) => (random() + random() + random() - 1.5) * 1.4;

/** The theme's three glow hues ("H S% L%" triplets), as hue and saturation. */
function readTints(element: Element): Tint[] {
  const style = getComputedStyle(element);
  return [1, 2, 3].map((n) => {
    const [h, s] = style.getPropertyValue(`--orb-glow-${n}`).trim().split(/\s+/);
    return [Number.parseFloat(h) || 230, Number.parseFloat(s) || 80];
  });
}

const hsla = ([h, s]: Tint, lightness: number, alpha: number) =>
  `hsla(${h}, ${Math.min(s, 95)}%, ${lightness}%, ${alpha})`;
const hsl = (tint: Tint, lightness: number) => hsla(tint, lightness, 1);

/**
 * Soft glows are drawn from one sprite per colour: a full-strength radial
 * gradient, drawn scaled with a low `globalAlpha`. Faint gradients drawn
 * directly dither, and stacked they add their dither up into a visible grid;
 * a full-strength sprite faded down does not. Cached across draws.
 */
const SPRITE_SIZE = 128;
const sprites = new Map<string, HTMLCanvasElement>();

function glowSprite(colour: string): HTMLCanvasElement | null {
  const cached = sprites.get(colour);
  if (cached) return cached;
  const sprite = document.createElement("canvas");
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;
  const ctx = sprite.getContext("2d");
  if (!ctx) return null;
  const half = SPRITE_SIZE / 2;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  // A gentle, bell-like falloff.
  glow.addColorStop(0, colour);
  glow.addColorStop(0.25, colour.replace(/, 1\)$/, ", 0.78)"));
  glow.addColorStop(0.5, colour.replace(/, 1\)$/, ", 0.38)"));
  glow.addColorStop(0.75, colour.replace(/, 1\)$/, ", 0.1)"));
  glow.addColorStop(1, colour.replace(/, 1\)$/, ", 0)"));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  sprites.set(colour, sprite);
  return sprite;
}

const WHITE = "rgba(255, 255, 255, 1)";
const WARM = "rgba(255, 240, 222, 1)";
const BLUE_WHITE = "rgba(220, 228, 255, 1)";
const BLACK = "rgba(0, 0, 0, 1)";

/** A soft round glow (`colour` opaque, ending ", 1)"), optionally squashed and turned. */
function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  colour: string,
  alpha: number,
  stretch = 1,
  squash = 1,
  angle = 0,
) {
  const sprite = glowSprite(colour);
  if (!sprite) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(stretch, squash);
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, -radius, -radius, radius * 2, radius * 2);
  ctx.restore();
}

/**
 * The deep sky is drawn in two passes: the soft glows on `haze`, a canvas at a
 * quarter of the resolution that is scaled up smoothly underneath (they are
 * soft anyway, and it is four times cheaper), and the fine detail — star dust,
 * spiral arms, cores — on `crisp`, at full resolution.
 */
type DeepLayers = { haze: CanvasRenderingContext2D; crisp: CanvasRenderingContext2D };
const HAZE_SCALE = 0.25;

/** Applies the same transform steps to both layers. */
function onBoth(layers: DeepLayers, step: (ctx: CanvasRenderingContext2D) => void) {
  step(layers.haze);
  step(layers.crisp);
}

/** The Milky Way: a very faint band corner to corner, a dust lane, and fine star dust. */
function drawMilkyWay(layers: DeepLayers, w: number, h: number, tints: Tint[]) {
  const { haze, crisp } = layers;
  const random = seeded(11);
  const length = Math.hypot(w, h) * 1.15;
  const band = Math.min(w, h) * 0.14 + 50;
  onBoth(layers, (ctx) => {
    ctx.save();
    ctx.translate(w * 0.5, h * 0.72); // low: under the brand column, not through it
    ctx.rotate(-Math.atan2(h, w) * 0.85);
  });

  haze.globalCompositeOperation = "lighter";
  for (let i = 0; i < 18; i++) {
    const x = (random() - 0.5) * length;
    const colour = i % 3 === 0 ? BLUE_WHITE : hsl(tints[i % 3], 72);
    const radius = band * between(random, [1, 1.8]);
    blob(
      haze,
      x,
      gaussian(random) * band * 0.25,
      radius,
      colour,
      i % 3 === 0 ? 0.032 : 0.028,
      2.4,
      0.5,
    );
  }
  // The dust lane: darker streaks a little off the band's middle.
  haze.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 9; i++) {
    const x = (random() - 0.5) * length * 0.9;
    blob(haze, x, band * 0.1 + gaussian(random) * band * 0.06, band * 0.55, BLACK, 0.3, 3.2, 0.22);
  }
  // Star dust, thickest along the middle.
  crisp.globalCompositeOperation = "lighter";
  const count = Math.round(length * band * 0.0035);
  for (let i = 0; i < count; i++) {
    const x = (random() - 0.5) * length;
    const y = gaussian(random) * band * 0.42;
    const fade = Math.max(0, 1 - Math.abs(y) / (band * 1.1));
    const alpha = between(random, [0.08, 0.38]) * fade;
    if (alpha < 0.02) continue;
    const tinted = random() < 0.18;
    crisp.fillStyle = tinted ? hsla(tints[i % 3], 85, alpha) : `rgba(235, 240, 255, ${alpha})`;
    const size = between(random, [0.5, 1.1]);
    crisp.fillRect(x, y, size, size);
  }
  onBoth(layers, (ctx) => ctx.restore());
}

/** A nebula: layered soft clouds in the theme's hues, a few wisps, young stars. */
function drawNebula(
  layers: DeepLayers,
  cx: number,
  cy: number,
  size: number,
  tints: Tint[],
  seed: number,
) {
  const { haze, crisp } = layers;
  const random = seeded(seed);
  onBoth(layers, (ctx) => {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
  });
  for (let i = 0; i < 14; i++) {
    const tint = tints[Math.floor(random() * 3)];
    blob(
      haze,
      cx + gaussian(random) * size * 0.28,
      cy + gaussian(random) * size * 0.2,
      size * between(random, [0.18, 0.42]),
      hsl(tint, Math.round(between(random, [55, 70]))),
      between(random, [0.05, 0.1]),
      between(random, [1, 1.8]),
      between(random, [0.5, 1]),
      random() * TAU,
    );
  }
  // Wisps: a few soft filaments.
  for (let i = 0; i < 3; i++) {
    blob(
      haze,
      cx + gaussian(random) * size * 0.25,
      cy + gaussian(random) * size * 0.18,
      size * 0.35,
      hsl(tints[i % 3], 78),
      0.06,
      2.2,
      0.34,
      random() * TAU,
    );
  }
  // Dark knots, for shape.
  haze.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 4; i++) {
    blob(
      haze,
      cx + gaussian(random) * size * 0.2,
      cy + gaussian(random) * size * 0.14,
      size * between(random, [0.06, 0.12]),
      BLACK,
      0.4,
      between(random, [1, 2]),
      0.6,
      random() * TAU,
    );
  }
  // Young stars inside.
  for (let i = 0; i < 5; i++) {
    const x = cx + gaussian(random) * size * 0.2;
    const y = cy + gaussian(random) * size * 0.15;
    blob(crisp, x, y, between(random, [2, 3.5]), WHITE, 0.45);
    crisp.fillStyle = "rgba(255, 255, 255, 0.75)";
    crisp.fillRect(x - 0.5, y - 0.5, 1, 1);
  }
  onBoth(layers, (ctx) => ctx.restore());
}

/** A distant galaxy: a tilted spiral (two arms of star dust) or an elliptical smudge. */
function drawGalaxy(
  layers: DeepLayers,
  cx: number,
  cy: number,
  radius: number,
  tilt: number,
  angle: number,
  tint: Tint,
  spiral: boolean,
  seed: number,
) {
  const { haze, crisp } = layers;
  const random = seeded(seed);
  onBoth(layers, (ctx) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(1, tilt);
    ctx.globalCompositeOperation = "lighter";
  });
  blob(haze, 0, 0, radius, hsl(tint, 70), spiral ? 0.14 : 0.18);
  if (spiral) {
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 160; i++) {
        const t = i / 160;
        const theta = t * Math.PI * 3.2 + arm * Math.PI;
        const r = radius * (0.12 + 0.85 * t);
        const x = Math.cos(theta) * r + gaussian(random) * radius * 0.05;
        const y = Math.sin(theta) * r + gaussian(random) * radius * 0.05;
        const alpha = (1 - t) * 0.38 + 0.05;
        crisp.fillStyle = t > 0.45 ? hsla(tint, 85, alpha) : `rgba(255, 238, 220, ${alpha})`;
        const size = between(random, [0.6, 1.3]);
        crisp.fillRect(x, y, size, size);
      }
    }
  }
  blob(crisp, 0, 0, radius * (spiral ? 0.32 : 0.6), WARM, 0.5);
  blob(crisp, 0, 0, Math.max(1.5, radius * 0.1), WHITE, 0.8);
  onBoth(layers, (ctx) => ctx.restore());
}

/** Draws the deep sky onto `ctx` (w × h CSS px): the detail, then the haze slid under it. */
function drawDeepSky(ctx: CanvasRenderingContext2D, w: number, h: number, tints: Tint[]) {
  const hazeCanvas = document.createElement("canvas");
  hazeCanvas.width = Math.max(1, Math.round(w * HAZE_SCALE));
  hazeCanvas.height = Math.max(1, Math.round(h * HAZE_SCALE));
  const haze = hazeCanvas.getContext("2d");
  if (!haze) return;
  haze.setTransform(HAZE_SCALE, 0, 0, HAZE_SCALE, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const layers = { haze, crisp: ctx };

  drawMilkyWay(layers, w, h, tints);
  const big = Math.max(w, h);
  // One soft cloud, high in the far corner: the content keeps clear dark sky.
  drawNebula(layers, w * 0.9, h * 0.1, big * 0.2, tints, 21);
  // Two small, dim galaxies near the edges, scaled with the screen within limits.
  const scale = Math.min(1, Math.max(0.6, Math.min(w, h) / 900));
  drawGalaxy(layers, w * 0.95, h * 0.84, 30 * scale, 0.38, 0.45, tints[1], true, 5);
  drawGalaxy(layers, w * 0.04, h * 0.1, 16 * scale, 0.6, -0.3, tints[0], false, 6);

  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(hazeCanvas, 0, 0, w, h);
  ctx.restore();
}

function makeStars(width: number, height: number): Star[] {
  const random = seeded(3);
  const area = (width * height) / 10_000;
  const stars: Star[] = [];
  LAYERS.forEach((layer, index) => {
    const count = Math.round(area * layer.density);
    for (let i = 0; i < count; i++) {
      stars.push({
        x: random(),
        y: random(),
        r: between(random, layer.r),
        alpha: between(random, layer.alpha),
        depth: layer.twinkle * (0.5 + random() * 0.5),
        speed: 0.6 + random() * 2.2,
        phase: random() * TAU,
        // One in five takes a theme hue; the rest are white.
        tint: random() < 0.2 ? Math.floor(random() * 3) : -1,
        layer: index,
      });
    }
  });
  return stars;
}

/** A point in the outer band of the sky, clear of the content in the middle. */
function edgePoint(random: Random): [number, number] {
  for (;;) {
    const x = random();
    const y = random();
    if (x < 0.1 || x > 0.9 || y < 0.14 || y > 0.86) return [x, y];
  }
}

function makeSparkles(width: number, height: number): Sparkle[] {
  const random = seeded(9);
  const count = width * height > 900_000 ? SPARKLES[1] : SPARKLES[0];
  const sparkles: Sparkle[] = [];
  while (sparkles.length < count) {
    const [x, y] = edgePoint(random);
    // Well apart from each other: a few bright stars, not a cluster.
    if (sparkles.some((other) => Math.hypot(other.x - x, other.y - y) < 0.25)) continue;
    sparkles.push({
      x,
      y,
      size: between(random, [7, 12]),
      speed: between(random, [0.6, 1.6]),
      phase: random() * TAU,
      tint: random() < 0.5 ? Math.floor(random() * 3) : -1,
    });
  }
  return sparkles;
}

/** A cross-shaped sparkle: a glow, a long cross, a shorter diagonal one. */
function drawSparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  alpha: number,
  colour: (alpha: number) => string,
) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 0.45);
  glow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
  glow.addColorStop(0.3, colour(alpha * 0.45));
  glow.addColorStop(1, colour(0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - size, y - size, size * 2, size * 2);
  const spike = (length: number, angle: number, strength: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const ray = ctx.createLinearGradient(-length, 0, length, 0);
    ray.addColorStop(0, colour(0));
    ray.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * strength})`);
    ray.addColorStop(1, colour(0));
    ctx.fillStyle = ray;
    ctx.fillRect(-length, -0.6, length * 2, 1.2);
    ctx.restore();
  };
  spike(size, 0, 1);
  spike(size, Math.PI / 2, 1);
  spike(size * 0.45, Math.PI / 4, 0.5);
  spike(size * 0.45, -Math.PI / 4, 0.5);
}

/**
 * The live sky's stars as sprites, one set per colour (white, then the three
 * theme hues): a dot, a dot with a halo (four times its radius), a sparkle.
 * Drawn with drawImage and globalAlpha, a frame builds no gradients and parses
 * no colours.
 */
type StarSprites = { dot: HTMLCanvasElement; halo: HTMLCanvasElement; sparkle: HTMLCanvasElement };
const SPRITE_PX = 64;

function makeStarSprites(colour: (alpha: number) => string): StarSprites | null {
  const canvas = () => {
    const sprite = document.createElement("canvas");
    sprite.width = SPRITE_PX;
    sprite.height = SPRITE_PX;
    return sprite;
  };
  const [dot, halo, sparkle] = [canvas(), canvas(), canvas()];
  const d = dot.getContext("2d");
  const h = halo.getContext("2d");
  const s = sparkle.getContext("2d");
  if (!d || !h || !s) return null;
  const mid = SPRITE_PX / 2;
  d.fillStyle = colour(1);
  d.beginPath();
  d.arc(mid, mid, mid - 1, 0, TAU);
  d.fill();
  const glow = h.createRadialGradient(mid, mid, 0, mid, mid, mid);
  glow.addColorStop(0, colour(0.35));
  glow.addColorStop(1, colour(0));
  h.fillStyle = glow;
  h.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  h.fillStyle = colour(1);
  h.beginPath();
  h.arc(mid, mid, mid / 4, 0, TAU);
  h.fill();
  drawSparkle(s, mid, mid, mid, 1, colour);
  return { dot, halo, sparkle };
}

function NightSkyCanvas({ className }: { className?: string }) {
  const deepRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const deepCanvas = deepRef.current;
    const canvas = liveRef.current;
    const deep = deepCanvas?.getContext("2d");
    const ctx = canvas?.getContext("2d");
    if (!deepCanvas || !canvas || !deep || !ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let deepWidth = 0;
    let deepHeight = 0;
    let stars: Star[] = [];
    let sparkles: Sparkle[] = [];
    let tints = readTints(canvas);
    const falling: FallingStar[] = [];
    let burstLeft = 0;
    let nextFall = 1.2; // the first one soon after arriving
    let nextBright = between(Math.random, [6, 12]);
    let clock = 0;
    let last = 0;
    let frame = 0;

    const tinted = (tint: number) => (alpha: number) =>
      tint < 0 ? `rgba(236, 241, 255, ${alpha})` : hsla(tints[tint], 86, alpha);
    // Index 0 is white, 1..3 the theme hues (a star's `tint` + 1).
    let starSprites: (StarSprites | null)[] = [];
    const makeSprites = () => {
      starSprites = [-1, 0, 1, 2].map((tint) => makeStarSprites(tinted(tint)));
    };
    makeSprites();

    const paintDeep = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, DEEP_RATIO);
      deepWidth = width;
      deepHeight = height;
      deepCanvas.width = Math.round(width * ratio);
      deepCanvas.height = Math.round(height * ratio);
      deep.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawDeepSky(deep, width, height, tints);
    };

    const drawStars = (time: number) => {
      for (const star of stars) {
        const layer = LAYERS[star.layer];
        const x = (((star.x * width - time * layer.drift) % width) + width) % width;
        const y = star.y * height;
        const twinkle = reduceMotion
          ? 1
          : 1 - star.depth * (0.5 + 0.5 * Math.sin(time * star.speed + star.phase));
        const sprites = starSprites[star.tint + 1];
        if (!sprites) continue;
        ctx.globalAlpha = star.alpha * twinkle;
        if (star.layer === 2) {
          // The nearest stars carry a small halo.
          const r = star.r * 4;
          ctx.drawImage(sprites.halo, x - r, y - r, r * 2, r * 2);
        } else {
          ctx.drawImage(sprites.dot, x - star.r, y - star.r, star.r * 2, star.r * 2);
        }
      }
      for (const sparkle of sparkles) {
        const sprites = starSprites[sparkle.tint + 1];
        if (!sprites) continue;
        const pulse = reduceMotion ? 1 : 0.7 + 0.3 * Math.sin(time * sparkle.speed + sparkle.phase);
        const size = sparkle.size * pulse;
        ctx.globalAlpha = 0.85 * pulse;
        ctx.drawImage(
          sprites.sparkle,
          sparkle.x * width - size,
          sparkle.y * height - size,
          size * 2,
          size * 2,
        );
      }
      ctx.globalAlpha = 1;
    };

    const launch = (bright: boolean) => {
      const faint = !bright && Math.random() < FAINT_CHANCE;
      // Down and to the left, steeply: rain, not a comet.
      const angle = ((RAIN_ANGLE + (Math.random() - 0.5) * 16) * Math.PI) / 180;
      const speed = bright
        ? between(Math.random, [900, 1200])
        : faint
          ? between(Math.random, [480, 760])
          : between(Math.random, [720, 1050]);
      falling.push({
        x: between(Math.random, [0.15, 1.1]) * width,
        y: between(Math.random, [-0.08, 0.45]) * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        length: bright
          ? between(Math.random, [320, 480])
          : faint
            ? between(Math.random, [60, 140])
            : between(Math.random, [140, 260]),
        width: bright ? 2.2 : faint ? 1 : 1.5,
        brightness: bright
          ? 1
          : faint
            ? between(Math.random, [0.3, 0.55])
            : between(Math.random, [0.75, 1]),
        life: bright ? between(Math.random, [1.6, 2.1]) : between(Math.random, [0.8, 1.4]),
        age: 0,
        tint: Math.floor(Math.random() * 3),
        bright,
      });
    };

    const drawFalling = (dt: number) => {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      for (let i = falling.length - 1; i >= 0; i--) {
        const star = falling[i];
        star.age += dt;
        star.x += star.vx * dt;
        star.y += star.vy * dt;
        const t = star.age / star.life;
        if (t >= 1) {
          falling.splice(i, 1);
          continue;
        }
        // In quickly, out slowly; the tail grows over the first fifth.
        const alpha = (t < 0.15 ? t / 0.15 : t > 0.6 ? (1 - t) / 0.4 : 1) * star.brightness;
        const tail = star.length * Math.min(1, t / 0.2);
        const speed = Math.hypot(star.vx, star.vy);
        const tailX = star.x - (star.vx / speed) * tail;
        const tailY = star.y - (star.vy / speed) * tail;
        const tint = tints[star.tint];

        if (star.bright) {
          // A wide, soft glow under the bright one's tail.
          const haze = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
          haze.addColorStop(0, hsla(tint, 85, alpha * 0.35));
          haze.addColorStop(1, hsla(tint, 80, 0));
          ctx.strokeStyle = haze;
          ctx.lineWidth = 7;
          ctx.beginPath();
          ctx.moveTo(star.x, star.y);
          ctx.lineTo(tailX, tailY);
          ctx.stroke();
        }

        const streak = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
        streak.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        streak.addColorStop(0.25, hsla(tint, 82, alpha * 0.55));
        streak.addColorStop(1, hsla(tint, 70, 0));
        ctx.strokeStyle = streak;
        ctx.lineWidth = star.width;
        ctx.beginPath();
        ctx.moveTo(star.x, star.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();

        if (star.bright) {
          drawSparkle(ctx, star.x, star.y, 22, alpha, (a) => hsla(tint, 85, a));
        } else {
          const r = star.width * 4;
          const head = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, r);
          head.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.9})`);
          head.addColorStop(0.4, hsla(tint, 80, alpha * 0.35));
          head.addColorStop(1, hsla(tint, 80, 0));
          ctx.fillStyle = head;
          ctx.fillRect(star.x - r, star.y - r, r * 2, r * 2);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    };

    const paint = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      drawStars(clock);
      if (reduceMotion) return;
      nextFall -= dt;
      nextBright -= dt;
      if (nextBright <= 0 && falling.length < MAX_FALLING) {
        launch(true);
        nextBright = between(Math.random, NEXT_BRIGHT);
        nextFall = Math.max(nextFall, 1.5); // the bright one falls alone
      }
      if (nextFall <= 0) {
        if (falling.length < MAX_FALLING) launch(false);
        if (burstLeft > 0) {
          burstLeft -= 1;
          nextFall = between(Math.random, NEXT_FALL);
        } else if (Math.random() < BURST_CHANCE) {
          burstLeft = 1;
          nextFall = between(Math.random, IN_BURST);
        } else {
          nextFall = between(Math.random, NEXT_FALL);
        }
      }
      drawFalling(dt);
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // With nothing falling, the twinkle and drift need only 30 frames a second.
      if (!falling.length && last && now - last < IDLE_FRAME_MS) return;
      // Capped, so a long frame (or a return from a hidden tab) doesn't jump.
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      clock += dt;
      paint(dt);
    };

    const start = () => {
      if (reduceMotion || frame || document.hidden) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, LIVE_RATIO);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      // Positions are fractions of the canvas, so a small resize (a phone's
      // address bar) keeps the same sky — the deep sky is just stretched a
      // little; a real change of size draws it again.
      if (
        !deepWidth ||
        Math.abs(width - deepWidth) > deepWidth * 0.15 ||
        Math.abs(height - deepHeight) > deepHeight * 0.25
      ) {
        stars = makeStars(width, height);
        sparkles = makeSparkles(width, height);
        paintDeep();
      }
      paint(0);
    };

    const onVisibility = () => (document.hidden ? stop() : start());
    // A theme change re-tints the sky.
    const themeObserver = new MutationObserver(() => {
      tints = readTints(canvas);
      makeSprites();
      paintDeep();
      if (reduceMotion) paint(0);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className={className} aria-hidden="true">
      <canvas ref={deepRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={liveRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

/** Memoized: the page's state changes never touch the sky. */
export const NightSky = memo(NightSkyCanvas);
