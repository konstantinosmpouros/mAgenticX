import { CalendarDays, Repeat, Timer, type LucideIcon } from "lucide-react";

import type { ScheduleKind } from "@/shared/lib/types";

/**
 * The workflow builder's constants: its controls' classes (the agent
 * builder's inspector look, so the two builders read as one tool), the
 * palette's groups, and the drag-and-drop type a palette item carries.
 */

/** A text field / select trigger, as in the agent builder's inspector. */
export const INPUT =
  "w-full rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.02)] transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-border focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:focus-visible:ring-destructive/25";

/** A compact field inside a row (a rule, a map entry). */
export const INPUT_SM =
  "w-full min-w-0 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-[13px] text-foreground transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 aria-[invalid=true]:border-destructive/60";

export const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50";

export const ICON_BUTTON =
  "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40";

/** The top bar's pills (the agent builder's sizes). */
export const BAR_PRIMARY =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

export const BAR_SECONDARY =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A kind's icon tile (palette and drag ghost): its accent comes from
 * `--wf-accent` (set per item from `kindMeta`), a theme token, so it follows
 * light and dark.
 */
export const PALETTE_TILE =
  "flex flex-shrink-0 items-center justify-center rounded-[0.65rem] bg-[hsl(var(--wf-accent)/0.12)] text-[hsl(var(--wf-accent))] shadow-[inset_0_0_0_1px_hsl(var(--wf-accent)/0.16)] transition-[background-color,box-shadow,transform] duration-200";

/** A palette row: a quiet card that lifts on hover and focus. */
export const PALETTE_ROW =
  "group/item relative flex w-full cursor-grab items-center gap-3 overflow-hidden rounded-xl border border-transparent pl-2 pr-2 text-left outline-none transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out hover:-translate-y-px hover:border-border/70 hover:bg-background hover:shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_10px_22px_-14px_hsl(var(--foreground)/0.4)] focus-visible:border-primary/50 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/25 active:translate-y-0 active:cursor-grabbing motion-reduce:transition-none motion-reduce:hover:translate-y-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:translate-y-0 aria-disabled:hover:border-transparent aria-disabled:hover:bg-transparent aria-disabled:hover:shadow-none";

/** The palette's motion: a group folding, the panel sliding in. */
export const PALETTE_MOTION = {
  durationMs: 240,
  ease: [0.22, 1, 0.36, 1] as const,
  cssEase: "cubic-bezier(0.22, 1, 0.36, 1)",
};

/** A palette row's height (px): tile, name and description. */
export const PALETTE_ROW_HEIGHT = 52;

/** The palette's groups, in order, with their headings (a group the catalogue grows later goes last). */
export const PALETTE_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "trigger", label: "Triggers" },
  { id: "ai", label: "AI" },
  { id: "data", label: "Data" },
  { id: "tools", label: "Tools" },
  { id: "flow", label: "Flow" },
  { id: "output", label: "Output" },
];

/** Where the palette's open / shut choice is remembered on this device. */
export const PALETTE_OPEN_STORAGE_KEY = "magenticx:workflow-builder:palette-open";

/** Where the palette's folded groups (their ids) are remembered on this device. */
export const PALETTE_GROUPS_STORAGE_KEY = "magenticx:workflow-builder:palette-groups-collapsed";

/** The palette panel's width over the canvas's left edge (rem). */
export const PALETTE_WIDTH_REM = 17;

/** The inspector drawer's width over the canvas (px), short of the canvas's own width. */
export const INSPECTOR_DRAWER_WIDTH = 420;

/** The drag type a palette item carries onto the canvas; its value is the kind. */
export const PALETTE_DRAG_TYPE = "application/x-magenticx-workflow-kind";

/** The value types an input or state field may have. */
export const VALUE_TYPES = ["string", "number", "boolean", "object", "array"] as const;
export const REDUCERS = ["overwrite", "append", "merge"] as const;

export const REDUCER_HINTS: Record<(typeof REDUCERS)[number], string> = {
  overwrite: "Each write replaces the value.",
  append: "Each write adds to the list (array fields).",
  merge: "Each write merges its keys in (object fields).",
};

/** The schedule trigger's kind tabs, in the order people reach for them. */
export const SCHEDULE_KIND_TABS: ReadonlyArray<{ id: ScheduleKind; label: string; icon: LucideIcon }> = [
  { id: "one_off", label: "Once", icon: Timer },
  { id: "interval", label: "Every…", icon: Repeat },
  { id: "cron", label: "Custom (cron)", icon: CalendarDays },
];

/** One-click cron expressions for the schedule trigger's Custom tab. */
export const SCHEDULE_CRON_PRESETS: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "Weekdays at 09:00", expr: "0 9 * * 1-5" },
  { label: "Daily at 08:00", expr: "0 8 * * *" },
  { label: "Hourly", expr: "0 * * * *" },
];
