/**
 * How an animated artwork moves (`AnimatedLogo`): amplitudes of the effects
 * `logo-renderer.ts` applies to its pixels, in texture units (1 = the artwork's
 * width) or radians. Every effect is a periodic function of the loop, zero at
 * its start, so the first frame is the image and the loop has no seam.
 */
export type MotionPreset = {
  /** Seconds per loop. */
  period: number;
  /** Interior flow: the inside drifts like a fluid while the outline stays. */
  flow: number;
  /** Interior swirl around the center (radians at the center). */
  swirl: number;
  /** A soft light passing over the glass, and its direction (radians, 0 = left to right). */
  sweep: number;
  sweepAngle: number;
  /** The sweep circles the artwork instead of crossing it. */
  sweepSpin: boolean;
  /** Floating up and down. */
  float: number;
  /** Breathing scale. */
  breath: number;
  /** Three one-third turns per loop (for three-fold symmetric marks). */
  turn: boolean;
  /** The artwork's size in the canvas, leaving room for the motion. */
  scale: number;
};

const STILL: MotionPreset = {
  period: 10,
  flow: 0,
  swirl: 0,
  sweep: 0,
  sweepAngle: 0.5,
  sweepSpin: false,
  float: 0,
  breath: 0,
  turn: false,
  scale: 0.9,
};

/** The AI orb: the liquid flows and swirls inside, a highlight circles the glass. */
export const ORB_MOTION: MotionPreset = {
  ...STILL,
  period: 10,
  flow: 0.022,
  swirl: 0.45,
  sweep: 0.3,
  sweepSpin: true,
  float: 0.012,
  breath: 0.012,
  scale: 0.95,
};

/** The soft-node brand mark: a calm flow, a light passing, a third of a turn now and then. */
export const MARK_MOTION: MotionPreset = { ...STILL, period: 15, flow: 0.014, sweep: 0.22, turn: true };

/** While the AI works (thinking, speaking): faster, livelier, a gentle pulse. */
export const ACTIVE_BOOST = { speed: 2.2, flow: 1.5, breath: 0.035 };
