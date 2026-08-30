import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { Agent } from "@/shared/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { SoftPanel } from "../shared";

/**
 * The Agents landing: every agent in one list, platform and authored together.
 *
 * The old tab opened on a tool manager and hid authoring behind a ghost button
 * in the card header — so the tab's own subject was the least prominent thing
 * on it, and choosing between two agents cost a full card. Here the agents are
 * the page: one list, a badge saying where each came from, and enough summary
 * on the row to decide without opening it.
 */

export type AgentSummary = {
  agent: Agent;
  mine: boolean;
  /** Rendered as the row's meta line; omitted entries are skipped. */
  model?: string | null;
  toolCount?: number | null;
  gatedCount?: number | null;
  skillCount?: number | null;
  subagentCount?: number | null;
};

type Scope = "all" | "platform" | "mine";

const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "platform", label: "Platform" },
  { id: "mine", label: "Yours" },
];

/** Build the row's meta line, dropping anything the caller could not supply. */
const metaLine = (s: AgentSummary): string => {
  const parts: string[] = [];
  if (s.model) parts.push(s.model);
  if (typeof s.toolCount === "number") {
    parts.push(`${s.toolCount} ${s.toolCount === 1 ? "tool" : "tools"}`);
  }
  if (typeof s.gatedCount === "number" && s.gatedCount > 0) {
    parts.push(`${s.gatedCount} need approval`);
  }
  if (typeof s.skillCount === "number" && s.skillCount > 0) {
    parts.push(`${s.skillCount} ${s.skillCount === 1 ? "skill" : "skills"}`);
  }
  if (typeof s.subagentCount === "number" && s.subagentCount > 0) {
    parts.push(`${s.subagentCount} sub-${s.subagentCount === 1 ? "agent" : "agents"}`);
  }
  return parts.join(" · ");
};

export function AgentsIndex({
  summaries,
  canAuthor,
  busyAgentId,
  onOpen,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  summaries: AgentSummary[];
  canAuthor: boolean;
  busyAgentId?: string | null;
  onOpen: (agent: Agent) => void;
  onCreate: () => void;
  onEdit: (agent: Agent) => void;
  onDuplicate: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return summaries.filter((s) => {
      if (scope === "mine" && !s.mine) return false;
      if (scope === "platform" && s.mine) return false;
      if (!q) return true;
      return (
        s.agent.name.toLowerCase().includes(q) || s.agent.description.toLowerCase().includes(q)
      );
    });
  }, [summaries, query, scope]);

  const mineCount = summaries.filter((s) => s.mine).length;

  return (
    <section className="space-y-5">
      {/* Page header — one title, not three stacked eyebrows */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">Agents</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure what each agent can do, or build your own.
          </p>
        </div>
        {canAuthor ? (
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Plus size={15} aria-hidden /> New agent
          </button>
        ) : null}
      </div>

      {/* Search + scope */}
      {summaries.length > 3 || mineCount > 0 ? (
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
              placeholder="Search agents…"
              aria-label="Search agents"
              className="h-9 w-full rounded-xl border border-border/60 bg-background/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            />
          </div>
          <div
            role="group"
            aria-label="Filter agents"
            className="inline-flex items-center gap-0.5 rounded-xl bg-muted/40 p-0.5"
          >
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScope(s.id)}
                aria-pressed={scope === s.id}
                className={cn(
                  "rounded-[0.6rem] px-2.5 py-1.5 text-xs font-medium transition-all active:scale-[0.97]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  scope === s.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <SoftPanel className="px-6 py-12 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bot size={19} aria-hidden />
          </span>
          <p className="text-sm font-semibold text-foreground">
            {query || scope !== "all" ? "No agents match" : "No agents yet"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {query || scope !== "all"
              ? "Try a different search, or switch the filter back to All."
              : "Build one with its own instructions, model, tools and sub-agents."}
          </p>
          {/* The empty state carries its own action rather than pointing at a
              button somewhere else on the page. */}
          {canAuthor && !query && scope !== "platform" ? (
            <button
              type="button"
              onClick={onCreate}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <Plus size={15} aria-hidden /> New agent
            </button>
          ) : null}
        </SoftPanel>
      ) : (
        <ul className="space-y-2">
          {visible.map((summary, index) => {
            const { agent } = summary;
            const Icon = agent.icon ?? Bot;
            const meta = metaLine(summary);
            const busy = busyAgentId === agent.id;
            return (
              <motion.li
                key={agent.id}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut", delay: index * 0.04 }}
                className="relative"
              >
                <button
                  type="button"
                  onClick={() => onOpen(agent)}
                  className={cn(
                    "group flex w-full items-center gap-4 rounded-[1.4rem] bg-muted/30 px-5 py-4 text-left",
                    "transition-all hover:bg-muted/50 active:scale-[0.995]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "max-[639px]:gap-3 max-[639px]:px-4",
                    busy && "opacity-60",
                  )}
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background/60 text-primary transition-colors group-hover:bg-background">
                    <Icon size={19} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          summary.mine
                            ? "bg-primary/10 text-primary"
                            : "bg-background/60 text-muted-foreground",
                        )}
                      >
                        {summary.mine ? "Yours" : "Platform"}
                      </span>
                    </div>
                    {agent.description ? (
                      <p className="truncate text-xs text-muted-foreground">{agent.description}</p>
                    ) : null}
                    {meta ? (
                      <p className="mt-1 truncate text-[11px] tabular-nums text-muted-foreground/80">
                        {meta}
                      </p>
                    ) : null}
                  </div>
                  {/* Reserve the overflow slot so rows with and without a menu
                      keep their chevron on the same vertical line. */}
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    {summary.mine ? <span className="w-7" aria-hidden /> : null}
                    <ChevronRight
                      size={16}
                      aria-hidden
                      className="transition-transform duration-200 group-hover:translate-x-0.5"
                    />
                  </span>
                </button>

                {summary.mine ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Actions for ${agent.name}`}
                        className="absolute right-11 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <MoreHorizontal size={16} aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[90]">
                      <DropdownMenuItem onSelect={() => onEdit(agent)}>
                        <Pencil aria-hidden /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onDuplicate(agent)}>
                        <Copy aria-hidden /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(agent)}>
                        <Trash2 aria-hidden /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </motion.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
