import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  Copy,
  Download,
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
import { SoftPanel } from "@/features/settings/components/profile_parts/shared";
import {
  GALLERY_SCOPES,
  cardFacts,
  filterAgentCards,
  type AgentCard,
  type GalleryScope,
} from "@/features/agents/lib/gallery";
import { KindBadge } from "@/features/agents/components/page";
import { PRIMARY_BUTTON } from "@/features/agents/lib/styles";

/**
 * The gallery's body: scope and search, then every agent as a card, platform
 * and custom together.
 *
 * Moved from the Settings → Agents list, where agents were one-line rows in a
 * 45rem panel. On a page they have room to be cards: the description gets two
 * lines and a custom agent shows what it is made of (model, tools, skills,
 * sub-agents), enough to tell two of your own apart without opening either.
 * Which agents are custom comes from the catalog's `kind`.
 */
export function AgentsIndex({
  cards,
  canAuthor,
  busyAgentId,
  onOpen,
  onCreate,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
}: {
  cards: AgentCard[];
  canAuthor: boolean;
  busyAgentId?: string | null;
  onOpen: (agent: Agent) => void;
  onCreate: () => void;
  onEdit: (agent: Agent) => void;
  onDuplicate: (agent: Agent) => void;
  onExport: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<GalleryScope>("all");

  const visible = useMemo(() => filterAgentCards(cards, scope, query), [cards, scope, query]);
  const counts: Record<GalleryScope, number> = useMemo(
    () => ({
      all: cards.length,
      mine: cards.filter((c) => c.custom).length,
      platform: cards.filter((c) => !c.custom).length,
    }),
    [cards],
  );

  // "Mine" with nothing in it is a first visit, not a failed filter: it gets
  // the invitation to build one rather than "no matches".
  const firstAgent = scope === "mine" && counts.mine === 0 && !query.trim();

  return (
    <section className="space-y-5" aria-label="Agents">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            aria-label="Search agents"
            className="h-9 w-full rounded-xl border border-border/60 bg-background/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </div>
        <div
          role="group"
          aria-label="Show"
          className="inline-flex items-center gap-0.5 rounded-xl bg-muted/40 p-0.5"
        >
          {GALLERY_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScope(s.id)}
              aria-pressed={scope === s.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[0.6rem] px-2.5 py-1.5 text-xs font-medium transition-all active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                scope === s.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
              <span className="tabular-nums text-muted-foreground">{counts[s.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <SoftPanel className="px-6 py-12 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bot size={19} aria-hidden />
          </span>
          <p className="text-sm font-semibold text-foreground">
            {firstAgent ? "Build your first agent" : "No agents match"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {firstAgent
              ? "Give it its own instructions, model, tools, skills and sub-agents. It appears in your chat's agent picker as soon as it is created."
              : "Try a different search, or switch the filter back to All."}
          </p>
          {/* The empty state carries its own action rather than pointing at a
              button somewhere else on the page. */}
          {firstAgent && canAuthor ? (
            <button type="button" onClick={onCreate} className={cn(PRIMARY_BUTTON, "mt-5")}>
              <Plus className="h-4 w-4" aria-hidden /> New agent
            </button>
          ) : null}
        </SoftPanel>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((card, index) => {
            const { agent } = card;
            const Icon = agent.icon ?? Bot;
            const facts = cardFacts(card.summary);
            const busy = busyAgentId === agent.id;
            return (
              <motion.li
                key={agent.id}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                // Capped, so a long list does not keep the last cards waiting.
                transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(index, 8) * 0.035 }}
                className="relative"
              >
                <button
                  type="button"
                  onClick={() => onOpen(agent)}
                  aria-label={`${agent.name}, ${card.custom ? "custom" : "platform"} agent`}
                  aria-describedby={agent.description ? `agent-card-desc-${agent.id}` : undefined}
                  className={cn(
                    "group flex h-full w-full flex-col gap-3 rounded-[1.4rem] bg-muted/30 p-5 text-left",
                    "transition-all hover:bg-muted/50 active:scale-[0.99]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    busy && "opacity-60",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background/60 text-primary transition-colors group-hover:bg-background">
                      <Icon size={19} aria-hidden />
                    </span>
                    {/* Room on the right for the menu button, which sits over
                        the card rather than inside the button. */}
                    <div className={cn("min-w-0 flex-1 pt-0.5", card.custom && "pr-7")}>
                      <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
                      <KindBadge custom={card.custom} className="mt-1 inline-block" />
                    </div>
                  </div>
                  {agent.description ? (
                    <p
                      id={`agent-card-desc-${agent.id}`}
                      className="line-clamp-2 text-xs leading-relaxed text-muted-foreground"
                    >
                      {agent.description}
                    </p>
                  ) : null}
                  {facts.length ? (
                    <ul
                      aria-label="Made of"
                      className="mt-auto flex flex-wrap gap-1.5 text-[11px] tabular-nums text-muted-foreground"
                    >
                      {facts.map((fact) => (
                        <li key={fact} className="rounded-md bg-background/50 px-1.5 py-0.5">
                          {fact}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </button>

                {card.custom ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Actions for ${agent.name}`}
                        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 data-[state=open]:bg-background data-[state=open]:text-foreground"
                      >
                        <MoreHorizontal size={16} aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onEdit(agent)}>
                        <Pencil aria-hidden /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onDuplicate(agent)}>
                        <Copy aria-hidden /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onExport(agent)}>
                        <Download aria-hidden /> Export
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
