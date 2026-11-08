import type { WorkflowDetailTab } from "@/shared/lib/types";

/**
 * The workflow view's constants: the details tabs, the graph's framing, and
 * the pill buttons its header and empty state share (consts belong in lib/,
 * not in a `*_parts/` component file).
 */

export const DETAIL_TABS: ReadonlyArray<{ id: WorkflowDetailTab; label: string }> = [
  { id: "output", label: "Output" },
  { id: "input", label: "Input" },
  { id: "state", label: "Saved" },
  { id: "tools", label: "Tool calls" },
];

/** Room kept round the graph when it is framed (px): clear of the corner buttons. */
export const GRAPH_FIT_PADDING = 56;

/**
 * Never framed smaller than this: a big graph overflows (and pans) rather
 * than shrinking its cards past reading.
 */
export const GRAPH_FIT_MIN_ZOOM = 0.5;

type FitPadding = `${number}px`;

/**
 * React Flow's framing: the whole graph, never zoomed past 1:1 nor below
 * `GRAPH_FIT_MIN_ZOOM`. `rightInset` is what covers the canvas's right edge
 * (the builder's open inspector drawer) and `leftInset` its left edge (the
 * builder's expanded step palette, an overlay), so the graph frames between.
 */
export const graphFitView = (rightInset = 0, leftInset = 0) => ({
  padding: {
    top: `${GRAPH_FIT_PADDING}px` as FitPadding,
    bottom: `${GRAPH_FIT_PADDING}px` as FitPadding,
    left: `${GRAPH_FIT_PADDING + Math.max(0, Math.round(leftInset))}px` as FitPadding,
    right: `${GRAPH_FIT_PADDING + Math.max(0, Math.round(rightInset))}px` as FitPadding,
  },
  minZoom: GRAPH_FIT_MIN_ZOOM,
  maxZoom: 1,
});

export const GRAPH_FIT_VIEW = graphFitView();

/**
 * The run view's motion: one ease and a few durations (s) for every panel
 * transition — tabs, a step opening, cards unfolding — so they move as one.
 * Reduced motion turns the movement off (fades stay, instantly).
 */
export const VIEW_MOTION = {
  ease: [0.22, 1, 0.36, 1] as const,
  fast: 0.16,
  base: 0.24,
  slow: 0.34,
  /** How far content slides in (px). */
  shift: 14,
  /** The gap between staggered items (s), and the most items that stagger. */
  stagger: 0.035,
  staggerMax: 12,
} as const;

/** The run view's side panel width (px): its bounds, default and keyboard step. */
export const RUN_PANEL_WIDTH = { min: 340, max: 760, initial: 440, step: 24 } as const;

/** The run panel keeps at least this share of the window for the graph. */
export const RUN_PANEL_MAX_SHARE = 0.6;

/** Where the run panel's width is remembered on this device. */
export const RUN_PANEL_WIDTH_STORAGE_KEY = "magenticx:workflow-view:panel-width";

/** JSON trees open this many levels deep; deeper levels start folded. */
export const JSON_OPEN_DEPTH = 2;

/** Long strings in a JSON tree are cut here, with a "show all" toggle. */
export const JSON_STRING_PREVIEW = 280;

/** The filled primary pill (Run ▸), as on the Automations page. */
export const PRIMARY_BUTTON =
  "inline-flex min-h-[2.5rem] flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** The outlined secondary pill (run picker, Cancel, Try again). */
export const SECONDARY_BUTTON =
  "inline-flex min-h-[2.5rem] flex-shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3.5 py-2 text-sm font-medium text-foreground transition-colors disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]";

/** A small icon-only button (copy, fold). */
export const ICON_BUTTON =
  "inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground";

/** The History panel's soft surface: the agent history's SoftPanel, rounded and faintly tinted. */
export const HISTORY_PANEL = "rounded-[1.4rem] bg-muted/30";

/** The History panel's row actions: the secondary pill with tighter padding and text for the narrow drawer. */
export const HISTORY_ROW_BUTTON =
  "inline-flex min-h-[2.5rem] flex-shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]";
