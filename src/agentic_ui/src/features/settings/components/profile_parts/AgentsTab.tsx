import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot } from "lucide-react";

import { getAgentTools, toggleAgentTool } from "@/shared/lib/api";
import { loadSession } from "@/shared/lib/authStorage";
import { cn } from "@/shared/lib/utils";
import type { Agent, AgentToolRow, AgentToolsResponse } from "@/shared/lib/types";
import { InfoCard, SoftPanel } from "./shared";

/**
 * AgentsTab — pick a (deep) agent and toggle which tools it may use in your
 * conversations. The disabled set is per-(user, agent); the agents service
 * subtracts it from the agent's declared tools at run time. Self-contained:
 * reads the current user from the session and drives its own load/toggle via
 * the api layer (optimistic, with rollback on failure). Only deep agents expose
 * a tool model, so the selector is filtered to them.
 */
type AgentsTabProps = {
    agents: Agent[];
};

export default function AgentsTab({ agents }: AgentsTabProps) {
    const userId = loadSession()?.userId ?? null;
    const toolAgents = useMemo(() => agents.filter((a) => a.type === "deep agent"), [agents]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [resp, setResp] = useState<AgentToolsResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [togglingKey, setTogglingKey] = useState<string | null>(null);

    // Default to the first deep agent once the list is known.
    useEffect(() => {
        setSelectedId((prev) => prev ?? toolAgents[0]?.id ?? null);
    }, [toolAgents]);

    const selectedAgent = useMemo(
        () => toolAgents.find((a) => a.id === selectedId) ?? null,
        [toolAgents, selectedId]
    );

    const load = useCallback(
        async (agentId: string) => {
            if (!userId) {
                setError("Sign in to manage agent tools.");
                return;
            }
            setLoading(true);
            setError(null);
            try {
                setResp(await getAgentTools(userId, agentId));
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load agent tools.");
                setResp(null);
            } finally {
                setLoading(false);
            }
        },
        [userId]
    );

    useEffect(() => {
        if (selectedId) void load(selectedId);
    }, [selectedId, load]);

    const onToggle = async (row: AgentToolRow) => {
        if (!userId || !selectedId || togglingKey) return;
        setTogglingKey(row.key);
        setError(null);
        const nextDisabled = !row.disabled;
        // Optimistic flip; reconcile with the server response (or roll back).
        setResp((prev) =>
            prev
                ? { ...prev, tools: prev.tools.map((t) => (t.key === row.key ? { ...t, disabled: nextDisabled } : t)) }
                : prev
        );
        try {
            setResp(await toggleAgentTool(userId, selectedId, row.key, nextDisabled));
        } catch (err) {
            setResp((prev) =>
                prev
                    ? { ...prev, tools: prev.tools.map((t) => (t.key === row.key ? { ...t, disabled: row.disabled } : t)) }
                    : prev
            );
            setError(err instanceof Error ? err.message : "Failed to update tool.");
        } finally {
            setTogglingKey(null);
        }
    };

    const renderRow = (row: AgentToolRow) => {
        const enabled = !row.disabled;
        const busy = togglingKey === row.key;
        return (
            <div key={row.key} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{row.name}</p>
                        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            {row.source}
                        </span>
                    </div>
                    {row.description ? (
                        <p className="mt-1 break-words text-sm text-muted-foreground">{row.description}</p>
                    ) : null}
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${enabled ? "Disable" : "Enable"} ${row.name}`}
                    disabled={busy}
                    onClick={() => void onToggle(row)}
                    className={cn(
                        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        enabled ? "border-primary/40 bg-primary/20" : "border-transparent bg-background/80",
                        busy && "cursor-not-allowed opacity-60"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-5 w-5 rounded-full shadow transition-transform",
                            enabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                        )}
                    />
                </button>
            </div>
        );
    };

    // Split the agent's baseline tools from the gateway tools the user may add.
    const declaredRows = resp?.tools.filter((t) => t.declared) ?? [];
    const availableRows = resp?.tools.filter((t) => !t.declared) ?? [];

    return (
        <div className="space-y-6 animate-fade-in">
            <InfoCard
                eyebrow="Workspace"
                title="Choose an agent"
                description="Pick an agent to manage its tools. Your choices apply to this agent only."
            >
                {toolAgents.length === 0 ? (
                    <SoftPanel className="px-6 py-10 text-center">
                        <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <Bot size={18} aria-hidden />
                        </span>
                        <p className="text-sm font-semibold text-foreground">No configurable agents</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Only deep agents expose per-agent tool controls.
                        </p>
                    </SoftPanel>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {toolAgents.map((agent) => {
                            const Icon = agent.icon;
                            const active = agent.id === selectedId;
                            return (
                                <button
                                    key={agent.id}
                                    type="button"
                                    onClick={() => setSelectedId(agent.id)}
                                    aria-pressed={active}
                                    className={cn(
                                        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                        active
                                            ? "border-primary/40 bg-primary/10 text-foreground"
                                            : "border-border/60 bg-background/60 text-muted-foreground hover:bg-background/80 hover:text-foreground"
                                    )}
                                >
                                    {Icon ? <Icon size={15} aria-hidden /> : <Bot size={15} aria-hidden />}
                                    <span className="font-medium">{agent.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </InfoCard>

            {selectedAgent ? (
                <InfoCard
                    eyebrow="Tools"
                    title={`${selectedAgent.name}'s tools`}
                    description="Turn off any of the agent's own tools, or turn on extra tools from the connected apps to grant them to just this agent."
                >
                    {error ? (
                        <SoftPanel className="flex items-center gap-3 px-4 py-3">
                            <AlertCircle size={16} className="shrink-0 text-destructive" aria-hidden />
                            <p className="text-sm text-muted-foreground">{error}</p>
                        </SoftPanel>
                    ) : loading && !resp ? (
                        <SoftPanel className="px-4 py-8 text-center">
                            <p className="text-sm text-muted-foreground">Loading tools…</p>
                        </SoftPanel>
                    ) : resp && resp.tools.length > 0 ? (
                        <div className="space-y-5">
                            {declaredRows.length > 0 ? (
                                <div className="space-y-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                        The agent's tools
                                    </p>
                                    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                                        {declaredRows.map(renderRow)}
                                    </SoftPanel>
                                </div>
                            ) : null}
                            {availableRows.length > 0 ? (
                                <div className="space-y-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                        Available to add
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        Tools from the connected apps. Turn one on to let this agent use it in your conversations.
                                    </p>
                                    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                                        {availableRows.map(renderRow)}
                                    </SoftPanel>
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <SoftPanel className="px-6 py-10 text-center">
                            <p className="text-sm font-semibold text-foreground">No configurable tools</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                                This agent has no tools to toggle right now.
                            </p>
                        </SoftPanel>
                    )}
                </InfoCard>
            ) : null}
        </div>
    );
}
