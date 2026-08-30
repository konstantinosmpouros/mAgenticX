import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";

/**
 * Horizontal section nav with an animated active indicator.
 *
 * Horizontal on purpose: the settings panel already renders its own sidebar on
 * the left, so a second vertical rail inside it would put two nav columns side
 * by side. Keeping this on the x-axis leaves one vertical axis on screen.
 *
 * A section may carry a dot to mark unresolved validation, so a problem in a
 * section you are not looking at is visible before you press Save rather than
 * after.
 */

export type SectionTab<T extends string> = {
  id: T;
  label: string;
  /** Marks the tab with a dot — used for per-section validation errors. */
  flagged?: boolean;
  /** Small trailing count, e.g. the number of tools selected. */
  count?: number | null;
};

export function SectionTabs<T extends string>({
  tabs,
  active,
  onSelect,
  idPrefix,
}: {
  tabs: SectionTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Namespaces the shared layoutId so two mounted navs don't animate into each other. */
  idPrefix: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <nav
      aria-label="Sections"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "relative shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {tab.label}
              {typeof tab.count === "number" && tab.count > 0 ? (
                <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {tab.count}
                </span>
              ) : null}
              {tab.flagged ? (
                <span
                  aria-label="Needs attention"
                  className="h-1.5 w-1.5 rounded-full bg-destructive"
                />
              ) : null}
            </span>
            {selected ? (
              <motion.span
                aria-hidden
                layoutId={`${idPrefix}-section-underline`}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }
                }
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
