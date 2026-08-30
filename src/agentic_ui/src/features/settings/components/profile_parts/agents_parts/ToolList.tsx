import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Lock, Search, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { AgentToolRow } from "@/shared/lib/types";
import { Skeleton } from "@/shared/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  countEnabled,
  groupTools,
  isToolEnabled,
  type ToolFilter,
} from "@/features/settings/lib/agentTools";
import { SoftPanel, ToggleSwitch } from "../shared";

/**
 * The agent's tool list: one line per tool, grouped by source, searchable.
 *
 * Replaces a flat stack of ~100px rows that showed the tool's full LLM-facing
 * prompt text truncated mid-word. That text is written for the model, not for
 * someone scanning a list, and at four lines per tool a gateway with two dozen
 * tools was an unbounded scroll with no way to find anything.
 *
 * Here each tool is a single line, the description is clamped to one line with
 * the full text on hover, and tools are grouped by where they come from — with
 * a per-group tally so a collapsed group still says whether anything inside is
 * on. Groups with nothing enabled start collapsed, because the common case is
 * scanning what an agent *has*, not what it could have.
 */

type ToolListProps = {
  tools: AgentToolRow[];
  loading?: boolean;
  /** Key of the row currently being written, so only that switch goes busy. */
  togglingKey?: string | null;
  onToggle?: (row: AgentToolRow) => void;
  /** Tool names that always require approval; rendered with a lock. */
  gatedNames?: ReadonlySet<string>;
  emptyHint?: string;
};

const FILTERS: { id: ToolFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

export function ToolList({
  tools,
  loading = false,
  togglingKey = null,
  onToggle,
  gatedNames,
  emptyHint = "This agent has no tools to configure right now.",
}: ToolListProps) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  // Only holds groups the user explicitly toggled; everything else follows the
  // "collapsed when nothing is on" default, so the list re-settles sensibly as
  // tools are switched rather than freezing whatever state it opened in.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupTools(tools, { query, filter }), [tools, query, filter]);
  const totals = useMemo(() => countEnabled(tools), [tools]);

  if (loading) {
    return (
      <div className="space-y-2" aria-busy>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
    );
  }

  if (tools.length === 0) {
    return (
      <SoftPanel className="px-6 py-10 text-center">
        <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Wrench size={18} aria-hidden />
        </span>
        <p className="text-sm font-semibold text-foreground">No tools</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{emptyHint}</p>
      </SoftPanel>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4">
        {/* Search + filter + running tally */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              aria-label="Search tools"
              className="h-9 w-full rounded-xl border border-border/60 bg-background/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            />
          </div>

          <div
            role="group"
            aria-label="Filter tools"
            className="inline-flex items-center gap-0.5 rounded-xl bg-muted/40 p-0.5"
          >
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  "rounded-[0.6rem] px-2.5 py-1.5 text-xs font-medium transition-all active:scale-[0.97]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  filter === f.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {totals.enabled} of {totals.total} on
          </span>
        </div>

        {groups.length === 0 ? (
          <SoftPanel className="px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No tools match{" "}
              {query ? <span className="text-foreground">“{query}”</span> : "that filter"}.
            </p>
          </SoftPanel>
        ) : null}

        {groups.map((group, groupIndex) => {
          const open = overrides[group.id] ?? group.enabled > 0;
          return (
            <motion.section
              key={group.id}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut", delay: groupIndex * 0.04 }}
              className="space-y-2"
            >
              <button
                type="button"
                onClick={() => setOverrides((prev) => ({ ...prev, [group.id]: !open }))}
                aria-expanded={open}
                className="group flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <ChevronDown
                  size={14}
                  aria-hidden
                  className={cn(
                    "shrink-0 text-muted-foreground transition-transform duration-200",
                    open ? "rotate-0" : "-rotate-90",
                  )}
                />
                <span className="text-sm font-semibold text-foreground">{group.id}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.builtin ? null : "MCP · "}
                  {group.enabled} of {group.total} on
                </span>
              </button>

              {open ? (
                <SoftPanel className="divide-y divide-border/30 overflow-hidden">
                  {group.tools.map((row) => {
                    const enabled = isToolEnabled(row);
                    const gated = gatedNames?.has(row.name) ?? false;
                    return (
                      <div
                        key={row.key}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30"
                      >
                        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
                          <span className="shrink-0 text-sm font-medium text-foreground">
                            {row.name}
                          </span>
                          {gated ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 text-muted-foreground">
                                  <Lock size={11} aria-label="Always asks for approval" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>Always asks for your approval</TooltipContent>
                            </Tooltip>
                          ) : null}
                          {row.description ? (
                            // One line, full text on hover: the stored copy is the
                            // model's prompt, useful to read but not to scan.
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="truncate text-xs text-muted-foreground">
                                  {row.description}
                                </span>
                              </TooltipTrigger>
                              {/* MCP servers ship enormous prompt text — one
                                  arXiv tool runs to several hundred words — so
                                  the panel is capped and scrolls instead of
                                  growing past the viewport. The scroll sits on
                                  an inner element because TooltipContent keeps
                                  `overflow-hidden` for its rounded corners. */}
                              <TooltipContent
                                side="top"
                                align="start"
                                collisionPadding={12}
                                className="max-w-sm p-0"
                              >
                                <div className="scrollbar-muted max-h-64 overflow-y-auto overscroll-contain px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]">
                                  {row.description}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                        <ToggleSwitch
                          size="sm"
                          checked={enabled}
                          disabled={togglingKey === row.key || !onToggle}
                          onToggle={() => onToggle?.(row)}
                          label={`${enabled ? "Disable" : "Enable"} ${row.name}`}
                        />
                      </div>
                    );
                  })}
                </SoftPanel>
              ) : null}
            </motion.section>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
