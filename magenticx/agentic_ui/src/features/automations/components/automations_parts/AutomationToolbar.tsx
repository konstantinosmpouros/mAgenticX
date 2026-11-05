import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUpDown, Check, ListFilter, Plus, Search, X } from "lucide-react";

import type { AutomationSort, AutomationStatusFilter } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { DEFAULT_SORT, SORT_OPTIONS, STATUS_FILTERS } from "@/features/automations/lib/filters";
import { PRIMARY_BUTTON } from "@/features/automations/lib/styles";

const TOOL_BUTTON =
  "relative inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground data-[state=open]:bg-[hsl(var(--hover-surface))] data-[state=open]:text-foreground";

/** A tool's icon button with its name in a tooltip; a dot when it is set to something. */
const ToolButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & { label: string; marked?: boolean }
>(({ label, marked = false, className, children, ...props }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button ref={ref} type="button" aria-label={label} className={cn(TOOL_BUTTON, marked && "text-foreground", className)} {...props}>
        {children}
        {marked ? (
          <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
        ) : null}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="text-xs">
      {label}
    </TooltipContent>
  </Tooltip>
));
ToolButton.displayName = "ToolButton";

/**
 * The Automations page's tools, right of its tabs: search (an icon that
 * opens into a field; Esc or × closes it and clears the query), the status
 * filter (Schedules only: a menu of the statuses with their dot and count; a
 * dot on the icon while one is on), the sort (Next run / Newest / Name), and
 * the area's New action.
 */
export function AutomationToolbar({
  searchLabel,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  counts,
  sort,
  onSortChange,
  createLabel,
  onCreate,
}: {
  /** "Search schedules" / "Search workflows": the field's placeholder and name. */
  searchLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** The status filter; no filter menu without it (the Workflows area). */
  filter?: AutomationStatusFilter;
  onFilterChange?: (filter: AutomationStatusFilter) => void;
  counts?: Record<AutomationStatusFilter, number>;
  sort: AutomationSort;
  onSortChange: (sort: AutomationSort) => void;
  createLabel: string;
  onCreate: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [searchOpen, setSearchOpen] = React.useState(query.length > 0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const closeSearch = () => {
    onQueryChange("");
    setSearchOpen(false);
  };

  return (
    <div className="flex items-center gap-1">
      <AnimatePresence initial={false} mode="popLayout">
        {searchOpen ? (
          <motion.div
            key="field"
            className="relative"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 36 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, width: "min(15rem, 52vw)" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 36 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            onAnimationComplete={() => inputRef.current?.focus()}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              value={query}
              autoFocus
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              onBlur={() => {
                if (!query) setSearchOpen(false);
              }}
              placeholder={searchLabel}
              aria-label={searchLabel}
              spellCheck={false}
              className="h-9 w-full rounded-xl border border-border/70 bg-card pl-9 pr-8 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:ring-4 focus-visible:ring-primary/15 [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={closeSearch}
              aria-label="Close the search"
              className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </motion.div>
        ) : (
          <motion.div key="icon" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ToolButton label={searchLabel} onClick={() => setSearchOpen(true)}>
              <Search className="h-[17px] w-[17px]" aria-hidden />
            </ToolButton>
          </motion.div>
        )}
      </AnimatePresence>

      {filter && onFilterChange && counts ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <ToolButton
              label={filter === "all" ? "Filter by status" : `Filter: ${STATUS_FILTERS.find((f) => f.id === filter)?.label}`}
              marked={filter !== "all"}
            >
              <ListFilter className="h-[17px] w-[17px]" aria-hidden />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-xl p-1" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuLabel className="px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </DropdownMenuLabel>
            {STATUS_FILTERS.map(({ id, label, dot }) => {
              const on = filter === id;
              const live = id === "running" && counts.running > 0;
              return (
                <DropdownMenuItem
                  key={id}
                  role="menuitemradio"
                  aria-checked={on}
                  onSelect={() => onFilterChange(id)}
                  className={cn("gap-2.5 rounded-lg px-2.5 py-2 text-[13px]", on && "font-medium text-foreground")}
                >
                  <span className="relative flex h-2 w-2 flex-shrink-0 items-center justify-center" aria-hidden>
                    {dot ? (
                      <>
                        {live ? <span className={cn("absolute h-full w-full rounded-full opacity-60 motion-safe:animate-ping", dot)} /> : null}
                        <span className={cn("relative h-1.5 w-1.5 rounded-full", dot)} />
                      </>
                    ) : null}
                  </span>
                  <span className="flex-1">{label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{counts[id]}</span>
                  <Check className={cn("h-3.5 w-3.5 text-primary", on ? "opacity-100" : "opacity-0")} aria-hidden />
                </DropdownMenuItem>
              );
            })}
            {filter !== "all" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onFilterChange("all")} className="rounded-lg px-2.5 py-2 text-[13px] text-muted-foreground">
                  Clear the filter
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ToolButton label={`Sort: ${SORT_OPTIONS.find((o) => o.id === sort)?.label}`} marked={sort !== DEFAULT_SORT}>
            <ArrowUpDown className="h-[17px] w-[17px]" aria-hidden />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-xl p-1" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuLabel className="px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Sort by
          </DropdownMenuLabel>
          {SORT_OPTIONS.map(({ id, label, hint }) => {
            const on = sort === id;
            return (
              <DropdownMenuItem
                key={id}
                role="menuitemradio"
                aria-checked={on}
                onSelect={() => onSortChange(id)}
                className={cn("gap-2.5 rounded-lg px-2.5 py-2", on && "text-foreground")}
              >
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[13px]", on && "font-medium")}>{label}</span>
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </span>
                <Check className={cn("h-3.5 w-3.5 text-primary", on ? "opacity-100" : "opacity-0")} aria-hidden />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <button type="button" onClick={onCreate} className={cn(PRIMARY_BUTTON, "ml-1.5 h-9")}>
        <Plus className="h-4 w-4" aria-hidden />
        <span className="max-[420px]:sr-only">{createLabel}</span>
      </button>
    </div>
  );
}
