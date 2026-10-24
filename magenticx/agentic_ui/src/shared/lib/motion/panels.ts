import { useReducedMotion } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";

/**
 * How every panel in the app appears and disappears — one place, three presets.
 *
 * - `panel`   dialogs and large panels (Settings, Share, Report, the agent map,
 *             attachment preview, search, the lightbox): the card fades in while
 *             it settles from a slight scale and drop; the backdrop fades.
 * - `sheet`   side and bottom sheets (run side panels, the mobile sidebar, the
 *             phone task form, the agent map on a phone): slide from their edge.
 * - `popover` menus, selects, hover cards, tooltips: a quick fade and scale
 *             from the trigger's side.
 *
 * Plus `dock`, the composer's in-place bars (chat bar, voice bar, HITL
 * takeover): a short rise into place, the same curve; and `swap`, one view
 * handing over to the next inside a panel (Settings sections).
 *
 * Every preset has a reduced-motion form that only fades.
 *
 * Two renderers share these numbers:
 * - Radix primitives (Dialog, Sheet, DropdownMenu, Select, HoverCard, Tooltip)
 *   animate with CSS on their `data-state`, using the classes in `RADIX_MOTION`
 *   (keyframes in `src/styles/motion.css`). Radix keeps the node mounted until
 *   the closing animation ends, so exits play and focus return, Escape and
 *   click-outside stay Radix's.
 * - Our own overlays animate with framer-motion inside `AnimatePresence`
 *   (`usePanelMotion()` or the plain functions below).
 *
 * `src/styles/motion.css` declares the same durations and curves as CSS custom
 * properties; `tests/agentic_ui/panel-motion.test.ts` keeps the two in step.
 */

/** Enter: a soft, critically damped settle (expo-out). */
export const EASE_ENTER = [0.22, 1, 0.36, 1] as const;
/** Exit: accelerate away. */
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

/** Seconds. Mirrored in motion.css as --mx-<kind>-in / --mx-<kind>-out (ms). */
export const PANEL_TIMING = {
  panel: { enter: 0.28, exit: 0.18 },
  sheet: { enter: 0.34, exit: 0.22 },
  popover: { enter: 0.16, exit: 0.12 },
  /** Reduced motion: fades only. */
  fade: { enter: 0.16, exit: 0.12 },
} as const;

type Kind = keyof typeof PANEL_TIMING;

export type MotionPreset = {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
};

export type PanelPresets = {
  /** The dimming layer behind a panel or sheet. */
  backdrop: MotionPreset;
  /** The panel itself. */
  content: MotionPreset;
};

export type SheetSide = "top" | "right" | "bottom" | "left";

function enter(kind: Kind): Transition {
  return { duration: PANEL_TIMING[kind].enter, ease: EASE_ENTER };
}

function leave(kind: Kind): Transition {
  return { duration: PANEL_TIMING[kind].exit, ease: EASE_EXIT };
}

const FADE: MotionPreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: enter("fade") },
  exit: { opacity: 0, transition: leave("fade") },
};

function backdrop(kind: Kind, reduce: boolean): MotionPreset {
  if (reduce) return FADE;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: enter(kind) },
    exit: { opacity: 0, transition: leave(kind) },
  };
}

/** Dialogs and large panels. */
export function panelMotion(reduce: boolean): PanelPresets {
  return {
    backdrop: backdrop("panel", reduce),
    content: reduce
      ? FADE
      : {
          initial: { opacity: 0, scale: 0.965, y: 10 },
          animate: { opacity: 1, scale: 1, y: 0, transition: enter("panel") },
          exit: { opacity: 0, scale: 0.975, y: 6, transition: leave("panel") },
        },
  };
}

const SHEET_OFFSET: Record<SheetSide, TargetAndTransition> = {
  top: { y: "-100%" },
  right: { x: "100%" },
  bottom: { y: "100%" },
  left: { x: "-100%" },
};

/** Side and bottom sheets. */
export function sheetMotion(side: SheetSide, reduce: boolean): PanelPresets {
  return {
    backdrop: backdrop("sheet", reduce),
    content: reduce
      ? FADE
      : {
          initial: SHEET_OFFSET[side],
          animate: { x: 0, y: 0, transition: enter("sheet") },
          exit: { ...SHEET_OFFSET[side], transition: leave("sheet") },
        },
  };
}

/** Menus and other small floating surfaces. */
export function popoverMotion(reduce: boolean): MotionPreset {
  if (reduce) return FADE;
  return {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: enter("popover") },
    exit: { opacity: 0, scale: 0.97, transition: leave("popover") },
  };
}

/** The composer's in-place bars (chat, voice, HITL takeover). */
export function dockMotion(reduce: boolean): MotionPreset {
  if (reduce) return FADE;
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: enter("panel") },
    exit: { opacity: 0, y: 5, transition: leave("panel") },
  };
}

/** One view handing over to the next inside a panel (Settings sections, their titles). */
export function swapMotion(reduce: boolean): MotionPreset {
  if (reduce) return FADE;
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: enter("panel") },
    exit: { opacity: 0, y: -6, transition: leave("popover") },
  };
}

/**
 * Class names for Radix content and overlays (their `data-state` drives the
 * keyframes in motion.css; reduced motion swaps them for a fade there).
 */
export const RADIX_MOTION = {
  /** The dimming overlay of a dialog or sheet. */
  backdrop: "mx-backdrop",
  /** Dialog content. */
  panel: "mx-panel",
  /** Sheet content, by the edge it slides from. */
  sheet: {
    top: "mx-sheet mx-sheet-top",
    right: "mx-sheet mx-sheet-right",
    bottom: "mx-sheet mx-sheet-bottom",
    left: "mx-sheet mx-sheet-left",
  } satisfies Record<SheetSide, string>,
  /** A bottom sheet on phones, a centred panel from 640px (sm) up. */
  sheetToPanel: "mx-sheet mx-sheet-bottom mx-sheet-panel",
  /** Dropdowns, selects, hover cards, tooltips. */
  popover: "mx-popover",
} as const;

/** The presets for the viewer's motion preference (framer-motion's `useReducedMotion`). */
export function usePanelMotion() {
  const reduce = useReducedMotion() ?? false;
  return {
    reduce,
    panel: panelMotion(reduce),
    sheet: (side: SheetSide) => sheetMotion(side, reduce),
    popover: popoverMotion(reduce),
    dock: dockMotion(reduce),
    swap: swapMotion(reduce),
  };
}
