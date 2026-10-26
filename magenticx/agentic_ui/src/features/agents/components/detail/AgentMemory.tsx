import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Brain, ChevronDown, FileText, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { toast } from "@/shared/hooks/use-toast";
import { useMemories } from "@/features/agents/hooks/useMemories";
import { DangerButton, SoftPanel } from "@/features/settings/components/profile_parts/shared";

const detailKey = (agentId: string, name: string) => `${agentId}::${name}`;

const formatDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

const notify = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) =>
  toast({
    title: opts.title,
    description: opts.description,
    variant: (opts.variant === "error" ? "destructive" : opts.variant) as
      "default" | "destructive" | undefined,
    duration: opts.duration,
  });

/**
 * The agent page's Memory section: what this agent has saved about the user
 * between conversations, to read and delete. It used to be a Settings tab that
 * listed every agent first; on the agent's own page that step is gone.
 *
 * Read fresh every time the section opens (the agent writes in the background,
 * so nothing is cached — see `useMemories`). The agent writes; the user only
 * inspects and deletes.
 */
export function AgentMemory({
  userId,
  agentId,
  agentName,
}: {
  userId: string | null;
  agentId: string;
  agentName: string;
}) {
  const reduceMotion = useReducedMotion();
  const {
    memories,
    isAgentLoading,
    loadAgent,
    detail,
    isDetailLoading,
    loadDetail,
    deleteMemory,
    isDeleting,
  } = useMemories({ userId, toast: notify });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(new Set());
    setConfirmingDelete(null);
    void loadAgent(agentId);
  }, [agentId, loadAgent]);

  const toggleMemory = useCallback(
    (name: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
          void loadDetail(agentId, name);
        }
        return next;
      });
    },
    [agentId, loadDetail],
  );

  const sorted = useMemo(
    () => [...(memories[agentId] ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [memories, agentId],
  );
  const loadedOnce = memories[agentId] !== undefined;
  const loading = isAgentLoading(agentId) && !loadedOnce;

  return (
    <div className="space-y-3">
      {loading ? <p className="px-1 text-sm text-muted-foreground">Loading memories…</p> : null}

      {loadedOnce && sorted.length === 0 ? (
        <SoftPanel className="px-6 py-10 text-center">
          <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
            <Brain size={18} aria-hidden />
          </span>
          <p className="text-sm font-semibold text-foreground">Nothing remembered yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {agentName} saves lasting facts about you here as you chat, when memory is on.
          </p>
        </SoftPanel>
      ) : null}

      <AnimatePresence initial={false}>
        {sorted.map((mem) => {
          const isExpanded = expanded.has(mem.name);
          const memDetail = detail[detailKey(agentId, mem.name)];
          const loadingDetail = isDetailLoading(agentId, mem.name);
          const deleting = isDeleting(agentId, mem.name);
          const confirming = confirmingDelete === mem.name;
          const created = formatDate(mem.createdAt);
          const updated = formatDate(mem.updatedAt);
          return (
            <motion.div
              key={mem.name}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, y: -4, transition: { duration: 0.14 } }
              }
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <SoftPanel className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleMemory(mem.name)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    aria-expanded={isExpanded}
                  >
                    <FileText
                      className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm font-medium text-foreground">
                        {mem.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {mem.summary || "No summary."}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        isExpanded && "rotate-180",
                      )}
                    />
                  </button>
                  {confirming ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <DangerButton
                        size="sm"
                        disabled={deleting}
                        onClick={() => {
                          setConfirmingDelete(null);
                          void deleteMemory(agentId, mem.name);
                        }}
                      >
                        {deleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : null}
                        Delete
                      </DangerButton>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingDelete(null)}
                        className="h-7 px-2 text-xs"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Tooltip delayDuration={200}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={deleting}
                          aria-label={`Delete memory ${mem.name}`}
                          onClick={() => setConfirmingDelete(mem.name)}
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-destructive"
                        >
                          {deleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Delete memory</TooltipContent>
                    </Tooltip>
                  )}
                </div>

                {isExpanded ? (
                  <div className="mt-3 border-t border-border/40 pt-3">
                    {loadingDetail && !memDetail ? (
                      <p className="text-xs text-muted-foreground">Loading content…</p>
                    ) : memDetail ? (
                      <>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-3 font-sans text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
                          {memDetail.content || "(empty)"}
                        </pre>
                        {created || updated ? (
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            {created ? `Saved ${created}` : ""}
                            {updated && updated !== created ? ` · updated ${updated}` : ""}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      // The body fetch failed: `loadDetail` only fires on expand,
                      // so without this the open row has no way back.
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground">Could not load content.</p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void loadDetail(agentId, mem.name)}
                          className="h-6 px-2 text-xs"
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                ) : null}
              </SoftPanel>
            </motion.div>
          );
        })}
      </AnimatePresence>

      <p className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
        <Brain className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
        What {agentName} remembers about you between conversations. Memory itself is switched on or
        off in Settings → Personalization.
      </p>
    </div>
  );
}
