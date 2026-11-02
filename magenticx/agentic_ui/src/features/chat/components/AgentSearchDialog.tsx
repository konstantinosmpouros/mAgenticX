import * as React from "react";
import { Check, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/shared/lib/utils";
import type { Agent } from "@/shared/lib/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { AgentsIcon } from "@/shared/ui/agents-icon";
import {
  RESULTS_PAGE_SIZE,
  inScope,
  matchPickerAgents,
  pageCount,
  splitMatch,
  type AgentScope,
} from "@/features/chat/lib/agentPicker";

const SCOPES: { id: AgentScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "My agents" },
  { id: "platform", label: "Platform" },
];

// Two columns: Left/Right move by one card, Up/Down by a row.
const COLUMNS = 2;

/**
 * The agent search panel, opened from the picker's "See all N results": a
 * large search, All / My agents / Platform filters with their counts, and the
 * results as cards, six to a page. It never scrolls — more results are more
 * pages. Arrow keys move between cards (and on to the next or previous page),
 * Page Up / Page Down turn pages, Enter picks.
 */
export function AgentSearchDialog({
  open,
  onOpenChange,
  agents,
  selectedId,
  initialQuery,
  onPick,
  onBrowseAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  selectedId: string;
  initialQuery: string;
  onPick: (id: string) => void;
  onBrowseAll?: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [query, setQuery] = React.useState(initialQuery);
  const [scope, setScope] = React.useState<AgentScope>("all");
  const [page, setPage] = React.useState(0);
  const [active, setActive] = React.useState(0);
  const [direction, setDirection] = React.useState(1);

  React.useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setScope("all");
    setPage(0);
    setActive(0);
  }, [open, initialQuery]);

  const matched = React.useMemo(() => matchPickerAgents(agents, query), [agents, query]);
  const counts = React.useMemo(
    () => ({
      all: matched.length,
      mine: matched.filter((agent) => inScope(agent, "mine")).length,
      platform: matched.filter((agent) => inScope(agent, "platform")).length,
    }),
    [matched],
  );
  const results = React.useMemo(
    () => matched.filter((agent) => inScope(agent, scope)),
    [matched, scope],
  );
  const pages = pageCount(results.length);
  const shown = results.slice(page * RESULTS_PAGE_SIZE, (page + 1) * RESULTS_PAGE_SIZE);
  const first = results.length ? page * RESULTS_PAGE_SIZE + 1 : 0;
  const last = page * RESULTS_PAGE_SIZE + shown.length;

  // A new search or filter starts on its first page.
  const resetPaging = () => {
    setPage(0);
    setActive(0);
  };

  const goTo = (next: number, focus: "first" | "last" = "first") => {
    if (next < 0 || next >= pages || next === page) return;
    setDirection(next > page ? 1 : -1);
    setPage(next);
    const size = Math.min(RESULTS_PAGE_SIZE, results.length - next * RESULTS_PAGE_SIZE);
    setActive(focus === "first" ? 0 : size - 1);
  };

  const pick = (agent: Agent) => {
    onOpenChange(false);
    onPick(agent.id);
  };

  const move = (delta: number) => {
    const target = active + delta;
    if (target >= 0 && target < shown.length) setActive(target);
    else if (target >= shown.length) goTo(page + 1, "first");
    else goTo(page - 1, "last");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(1),
      ArrowLeft: () => move(-1),
      ArrowDown: () => move(COLUMNS),
      ArrowUp: () => move(-COLUMNS),
      PageDown: () => goTo(page + 1),
      PageUp: () => goTo(page - 1),
      Enter: () => {
        if (shown[active]) pick(shown[active]);
      },
    };
    const handler = keys[event.key];
    if (!handler) return;
    // Left/Right inside the search text move its caret, not the cards.
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      (event.target as HTMLElement).tagName === "INPUT"
    ) {
      const input = event.target as HTMLInputElement;
      const atEdge =
        event.key === "ArrowLeft"
          ? input.selectionStart === 0
          : input.selectionEnd === input.value.length;
      if (!atEdge) return;
    }
    event.preventDefault();
    handler();
  };

  const slide = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, x: 24 * direction },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: -24 * direction },
        transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
      };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden rounded-[1.75rem] border-border/60 p-0 sm:rounded-[1.75rem] [&>button:last-child]:hidden"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Find an agent</DialogTitle>
        <DialogDescription className="sr-only">
          Search your agents and the platform&apos;s, then pick one for this chat.
        </DialogDescription>

        {/* ---- search + filters ---- */}
        <div className="border-b border-border/60 bg-gradient-to-b from-primary/[0.06] to-transparent px-5 pb-4 pt-5 sm:px-6">
          <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 shadow-[0_1px_2px_hsl(var(--foreground)/0.05)] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetPaging();
              }}
              placeholder="Search agents by name or what they do…"
              aria-label="Search agents"
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/80"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  resetPaging();
                }}
                aria-label="Clear the search"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            <DialogPrimitive.Close
              className="rounded-lg border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              aria-label="Close"
            >
              Esc
            </DialogPrimitive.Close>
          </div>

          <div role="tablist" aria-label="Which agents" className="mt-3.5 flex flex-wrap gap-1.5">
            {SCOPES.map(({ id, label }) => {
              const on = scope === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    setScope(id);
                    resetPaging();
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    on
                      ? "border-primary/40 bg-primary/[0.1] text-primary"
                      : "border-border/70 bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] tabular-nums",
                      on ? "bg-primary/15" : "bg-muted",
                    )}
                  >
                    {counts[id]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- results: a fixed-height page of cards ---- */}
        <div className="relative h-[22.5rem] overflow-hidden px-5 py-4 sm:px-6">
          {results.length ? (
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.ul
                key={`${scope}-${query}-${page}`}
                {...slide}
                role="listbox"
                aria-label={`Results, page ${page + 1} of ${pages}`}
                className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
              >
                {shown.map((agent, index) => (
                  <ResultCard
                    key={agent.id}
                    agent={agent}
                    query={query}
                    current={agent.id === selectedId}
                    active={index === active}
                    onHover={() => setActive(index)}
                    onPick={() => pick(agent)}
                  />
                ))}
              </motion.ul>
            </AnimatePresence>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Search className="h-5 w-5" aria-hidden />
              </span>
              <p className="text-sm font-medium text-foreground">
                No agent matches “{query.trim()}”
              </p>
              <p className="text-xs text-muted-foreground">
                Try another word, or a different filter.
              </p>
            </div>
          )}
        </div>

        {/* ---- paging ---- */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-5 py-3 sm:px-6">
          <p className="text-xs tabular-nums text-muted-foreground">
            {results.length ? `${first}–${last} of ${results.length}` : "0 results"}
          </p>
          {pages > 1 ? (
            <nav aria-label="Result pages" className="mx-auto flex items-center gap-1">
              <PagerButton
                label="Previous page"
                disabled={page === 0}
                onClick={() => goTo(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </PagerButton>
              {Array.from({ length: pages }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  aria-label={`Page ${index + 1}`}
                  aria-current={index === page ? "page" : undefined}
                  onClick={() => goTo(index)}
                  className={cn(
                    "h-7 min-w-7 rounded-lg px-2 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    index === page
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {index + 1}
                </button>
              ))}
              <PagerButton
                label="Next page"
                disabled={page >= pages - 1}
                onClick={() => goTo(page + 1)}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </PagerButton>
            </nav>
          ) : (
            <span className="mx-auto" />
          )}
          {onBrowseAll ? (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onBrowseAll();
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <AgentsIcon className="h-3.5 w-3.5" />
              Manage agents
            </button>
          ) : null}
          <p className="hidden w-full text-center text-[11px] text-muted-foreground/80 sm:block">
            ←↑↓→ move · PgUp / PgDn change page · Enter choose
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultCard({
  agent,
  query,
  current,
  active,
  onHover,
  onPick,
}: {
  agent: Agent;
  query: string;
  current: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const Icon = agent.icon;
  const name = splitMatch(agent.name, query);
  const mine = agent.kind === "custom";
  return (
    <li role="option" aria-selected={active} className="h-[6.25rem]">
      <button
        type="button"
        tabIndex={-1}
        onClick={onPick}
        onMouseMove={onHover}
        className={cn(
          "group flex h-full w-full items-start gap-3 rounded-2xl border bg-card p-3.5 text-left transition-[border-color,box-shadow,transform] duration-200",
          active
            ? "border-primary/50 shadow-[0_10px_26px_-18px_hsl(var(--primary)/0.7)] ring-1 ring-primary/20"
            : "border-border/70 hover:border-primary/30",
        )}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/[0.08] text-primary ring-1 ring-primary/10">
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {name ? (
                <>
                  {name[0]}
                  <mark className="rounded bg-primary/15 px-0.5 text-foreground">{name[1]}</mark>
                  {name[2]}
                </>
              ) : (
                agent.name
              )}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                mine ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {mine ? "Custom" : "Platform"}
            </span>
            {!agent.isActive ? (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-500">
                inactive
              </span>
            ) : null}
            {current ? (
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
                <Check className="h-3.5 w-3.5" aria-hidden />
                In use
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {agent.description || "No description."}
          </span>
        </span>
      </button>
    </li>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {children}
    </button>
  );
}
