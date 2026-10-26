/**
 * The Agents pages' buttons, in the style of Schedules beside them: a pill for
 * the page's main action and an outlined pill for the rest.
 */

export const PRIMARY_BUTTON =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

export const SECONDARY_BUTTON =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3.5 py-2 text-sm font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60";
