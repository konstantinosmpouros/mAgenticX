import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Bot, Brain, ChevronDown, FileText, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { Agent } from "@/shared/lib/types";
import type { MemoriesHandlers } from "@/features/settings/hooks/useMemories";
import { InfoCard, SkillHubRow, SoftPanel } from "./shared";

// Props are the useMemories hook output (spread straight in by ProfilePanel)
// plus the agent list to drill into.
type MemoriesTabProps = MemoriesHandlers & {
    agents?: Agent[];
};

const detailKey = (agentId: string, name: string) => `${agentId}::${name}`;
const MIN_REFRESH_SPIN_MS = 600;

const formatDate = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

export default function MemoriesTab({
    agents,
    memories,
    isAgentLoading,
    ensureLoaded,
    refreshAgent,
    detail,
    isDetailLoading,
    ensureDetail,
    deleteMemory,
    isDeleting,
}: MemoriesTabProps) {
    const prefersReducedMotion = useReducedMotion();
    // Sub-view transition — slide-in from the side, layout-shift duration per
    // CLAUDE.md; transform+opacity only, exit faster than enter.
    const viewMotionProps = useMemo(() => {
        if (prefersReducedMotion) {
            return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.1 } };
        }
        return {
            initial: { opacity: 0, x: 16 },
            animate: { opacity: 1, x: 0 },
            exit: { opacity: 0, x: -12 },
            transition: { duration: 0.3, ease: "easeOut" as const },
        };
    }, [prefersReducedMotion]);

    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const deepAgents = useMemo(
        () => (agents ?? []).filter((agent) => agent.type === "deep agent" && agent.isActive),
        [agents],
    );
    const selectedAgent = useMemo(
        () => deepAgents.find((a) => a.id === selectedAgentId) ?? null,
        [deepAgents, selectedAgentId],
    );

    const openAgent = useCallback((agentId: string) => {
        setSelectedAgentId(agentId);
        setExpanded(new Set());
        setConfirmingDelete(null);
        void ensureLoaded(agentId);
    }, [ensureLoaded]);

    const backToHub = useCallback(() => {
        setSelectedAgentId(null);
        setExpanded(new Set());
        setConfirmingDelete(null);
    }, []);

    const toggleMemory = useCallback((agentId: string, name: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
                void ensureDetail(agentId, name);
            }
            return next;
        });
    }, [ensureDetail]);

    const handleRefresh = useCallback(async () => {
        if (!selectedAgentId || refreshing) return;
        setRefreshing(true);
        const minSpin = new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_SPIN_MS));
        try {
            await Promise.all([refreshAgent(selectedAgentId), minSpin]);
        } finally {
            setRefreshing(false);
        }
    }, [selectedAgentId, refreshing, refreshAgent]);

    const sortedMemories = useMemo(() => {
        if (!selectedAgentId) return [];
        const list = memories[selectedAgentId] ?? [];
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }, [memories, selectedAgentId]);

    const agentLoading = selectedAgentId ? isAgentLoading(selectedAgentId) : false;
    const loadedOnce = selectedAgentId ? memories[selectedAgentId] !== undefined : false;

    return (
        <div className="space-y-6 animate-fade-in">
            <AnimatePresence mode="wait" initial={false}>
                {selectedAgent === null ? (
                    <motion.div key="memories-hub" className="space-y-3" {...viewMotionProps}>
                        {deepAgents.length === 0 ? (
                            <SoftPanel className="px-5 py-8 text-center">
                                <Brain className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
                                <p className="mt-3 text-sm text-muted-foreground">No active deep agents to inspect.</p>
                            </SoftPanel>
                        ) : (
                            deepAgents.map((agent, index) => {
                                const AgentIcon = agent.icon ?? Bot;
                                const loaded = memories[agent.id];
                                const meta = loaded !== undefined
                                    ? `${loaded.length} ${loaded.length === 1 ? "memory" : "memories"}`
                                    : undefined;
                                return (
                                    <SkillHubRow
                                        key={agent.id}
                                        index={index}
                                        reduceMotion={Boolean(prefersReducedMotion)}
                                        icon={<AgentIcon className="h-5 w-5" aria-hidden />}
                                        title={agent.name}
                                        subtitle={agent.description || "Inspect what this agent remembers about you"}
                                        meta={meta}
                                        actionLabel="Open"
                                        onClick={() => openAgent(agent.id)}
                                    />
                                );
                            })
                        )}
                        <p className="flex items-center gap-2 px-1 pt-2 text-xs text-muted-foreground">
                            <Brain className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
                            Long-term memories each deep agent has saved about you. Open one to review and delete entries.
                        </p>
                    </motion.div>
                ) : (
                    <motion.div key="memories-agent" {...viewMotionProps}>
                        <InfoCard
                            eyebrow="Agent memory"
                            title={selectedAgent.name}
                            headerAction={
                                <div className="flex items-center gap-1">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={backToHub}
                                        className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none"
                                    >
                                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                                        Back
                                    </Button>
                                    <Tooltip delayDuration={0}>
                                        <TooltipTrigger asChild>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => void handleRefresh()}
                                                disabled={refreshing}
                                                aria-label="Refresh memories"
                                                className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-[hsl(var(--hover-surface))] focus:outline-none focus-visible:ring-0 transition-colors disabled:opacity-100"
                                            >
                                                <RefreshCw size={16} className={cn(refreshing && "animate-spin")} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">{refreshing ? "Refreshing…" : "Refresh"}</TooltipContent>
                                    </Tooltip>
                                </div>
                            }
                        >
                            <div className="flex flex-col gap-2">
                                {agentLoading && !loadedOnce ? (
                                    <p className="text-sm text-muted-foreground">Loading memories…</p>
                                ) : null}

                                {loadedOnce && sortedMemories.length === 0 ? (
                                    <SoftPanel className="px-5 py-8 text-center">
                                        <FileText className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
                                        <p className="mt-3 text-sm text-muted-foreground">
                                            No memories saved yet. This agent will save durable facts here as you chat.
                                        </p>
                                    </SoftPanel>
                                ) : null}

                                <AnimatePresence initial={false}>
                                    {sortedMemories.map((mem) => {
                                        const isExpanded = expanded.has(mem.name);
                                        const key = detailKey(selectedAgent.id, mem.name);
                                        const memDetail = detail[key];
                                        const loadingDetail = isDetailLoading(selectedAgent.id, mem.name);
                                        const deleting = isDeleting(selectedAgent.id, mem.name);
                                        const confirming = confirmingDelete === mem.name;
                                        const created = formatDate(mem.createdAt);
                                        const updated = formatDate(mem.updatedAt);
                                        return (
                                            <motion.div
                                                key={mem.name}
                                                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.14 } }}
                                                transition={{ duration: 0.2, ease: "easeOut" }}
                                            >
                                                <SoftPanel className="p-3">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleMemory(selectedAgent.id, mem.name)}
                                                            className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                                                            aria-expanded={isExpanded}
                                                        >
                                                            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
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
                                                                <Button
                                                                    type="button"
                                                                    size="sm"
                                                                    variant="destructive"
                                                                    disabled={deleting}
                                                                    onClick={() => {
                                                                        setConfirmingDelete(null);
                                                                        void deleteMemory(selectedAgent.id, mem.name);
                                                                    }}
                                                                    className="h-7 gap-1 px-2 text-xs"
                                                                >
                                                                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                                                    Delete
                                                                </Button>
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
                                                                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                                                    >
                                                                        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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
                                                                    {(created || updated) ? (
                                                                        <p className="mt-2 text-[11px] text-muted-foreground">
                                                                            {created ? `Saved ${created}` : ""}
                                                                            {updated && updated !== created ? ` · updated ${updated}` : ""}
                                                                        </p>
                                                                    ) : null}
                                                                </>
                                                            ) : (
                                                                <p className="text-xs text-muted-foreground">Could not load content.</p>
                                                            )}
                                                        </div>
                                                    ) : null}
                                                </SoftPanel>
                                            </motion.div>
                                        );
                                    })}
                                </AnimatePresence>
                            </div>
                        </InfoCard>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
