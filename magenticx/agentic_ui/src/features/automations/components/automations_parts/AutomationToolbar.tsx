import { Search } from "lucide-react";

import type { AutomationStatusFilter } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { STATUS_FILTERS } from "@/features/automations/lib/filters";

/**
 * The Automations page's toolbar: status filter chips with counts (they
 * replace the old tabs and the "N running · M active" line), and a search box
 * once the list is long. Chips follow the agent search dialog's chip style.
 */
export function AutomationToolbar({
  filter,
  onFilterChange,
  counts,
  query,
  onQueryChange,
  showSearch,
}: {
  filter: AutomationStatusFilter;
  onFilterChange: (filter: AutomationStatusFilter) => void;
  counts: Record<AutomationStatusFilter, number>;
  query: string;
  onQueryChange: (query: string) => void;
  showSearch: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        role="group"
        aria-label="Filter automations by status"
        className="flex flex-wrap gap-1.5"
      >
        {STATUS_FILTERS.map(({ id, label }) => {
          const on = filter === id;
          const running = id === "running" && counts.running > 0;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onFilterChange(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                on
                  ? "border-primary/40 bg-primary/[0.1] text-primary"
                  : "border-border/70 bg-background text-muted-foreground supports-[hover:hover]:hover:text-foreground",
              )}
            >
              {label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px] tabular-nums",
                  on ? "bg-primary/15" : "bg-muted",
                  running && !on && "text-[hsl(var(--subagent-active))]",
                )}
              >
                {counts[id]}
              </span>
            </button>
          );
        })}
      </div>
      {showSearch ? (
        <div className="relative w-full sm:w-60">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search automations"
            aria-label="Search automations"
            className="h-9 w-full rounded-xl border border-border/70 bg-card pl-9 pr-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:ring-4 focus-visible:ring-primary/15"
            spellCheck={false}
          />
        </div>
      ) : null}
    </div>
  );
}
