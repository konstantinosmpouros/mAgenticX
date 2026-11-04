/**
 * The Automations page's shared button classes — the page header, the empty
 * state and the error state use the same pill buttons, so they live here once
 * (consts belong in lib/, not in a `*_parts/` component file).
 */

/** The filled primary pill ("New automation", "Create from scratch"). */
export const PRIMARY_BUTTON =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** The outlined secondary pill ("Try again"). */
export const SECONDARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-full border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]";
