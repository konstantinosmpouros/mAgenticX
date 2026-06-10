import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronDown } from "lucide-react";

import { useToolStatus } from "@/hooks/useToolStatus";
import { cn } from "@/lib/utils";
import type { ToolMetadata, ToolWithStatus, UserPreferences } from "@/lib/types";
import { InfoCard, MetricCard, SoftPanel } from "./shared";
import { McpIcon } from "./icons";

type McpServersTabProps = {
    availableTools: ToolWithStatus[];
    userPreferences: UserPreferences;
    preferencesSaving?: boolean;
    onToggleToolPreference?: (tool: ToolMetadata) => void;
};

export default function McpServersTab({
    availableTools,
    userPreferences,
    preferencesSaving = false,
    onToggleToolPreference,
}: McpServersTabProps) {
    const { theme } = useTheme();
    const currentTheme = theme === "dark" ? "dark" : "light";
    const { toolKey, disabledKeys: preferencesDisabledKeys, serverGroups, enabledToolsCount } = useToolStatus(
        availableTools,
        userPreferences
    );

    const [serverCollapsed, setServerCollapsed] = useState<Record<string, boolean>>({});
    const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});

    // Seed each server collapsed on mount; preserve any user toggle for servers
    // that persist across an availableTools change while the tab stays mounted.
    useEffect(() => {
        setServerCollapsed((prev) => {
            const next: Record<string, boolean> = {};
            availableTools.forEach((tool) => {
                const serverKey = tool.serverId || "default";
                if (!(serverKey in next)) {
                    next[serverKey] = serverKey in prev ? prev[serverKey] : true;
                }
            });
            return next;
        });
    }, [availableTools]);

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="grid gap-4 lg:grid-cols-3">
                <MetricCard
                    label="Servers"
                    value={String(serverGroups.length)}
                    hint="Discovered MCP server groups"
                />
                <MetricCard
                    label="Enabled Tools"
                    value={String(enabledToolsCount)}
                    hint="Currently allowed in conversation"
                />
                <MetricCard
                    label="Disabled Tools"
                    value={String(Math.max(availableTools.length - enabledToolsCount, 0))}
                    hint="Hidden until re-enabled"
                />
            </div>

            <InfoCard
                eyebrow="Apps"
                title="Manage MCP tools"
                description="This mirrors the apps/connectors mental model: browse grouped integrations, inspect descriptions, and keep only the tools you want available."
            >
                <div className="space-y-4">
                    {availableTools.length === 0 ? (
                        <SoftPanel className="px-4 py-10 text-center">
                            <p className="text-sm text-muted-foreground">
                                No tools discovered yet. Make sure the MCP tools server is running and refresh after login.
                            </p>
                        </SoftPanel>
                    ) : (
                        serverGroups.map(([serverKey, tools]) => {
                            const collapsed = serverCollapsed[serverKey] ?? false;
                            const serverLabel = serverKey === "default" ? "Unassigned server" : serverKey;

                            return (
                                <SoftPanel key={serverKey} className="p-4">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setServerCollapsed((prev) => ({
                                                ...prev,
                                                [serverKey]: !collapsed,
                                            }))
                                        }
                                        className="flex w-full items-center justify-between gap-4 rounded-2xl text-left"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-background/75">
                                                <McpIcon
                                                    size={20}
                                                    variant={currentTheme === "dark" ? "white" : "black"}
                                                />
                                            </div>
                                            <div>
                                                <p className="text-sm font-semibold text-foreground">
                                                    {serverLabel}
                                                </p>
                                                <p className="text-sm text-muted-foreground">
                                                    {tools.length} tool{tools.length === 1 ? "" : "s"}
                                                </p>
                                            </div>
                                        </div>
                                        <ChevronDown
                                            size={18}
                                            className={cn(
                                                "text-muted-foreground transition-transform",
                                                collapsed ? "-rotate-90" : "rotate-0"
                                            )}
                                        />
                                    </button>

                                    {!collapsed ? (
                                        <div className="mt-4 divide-y divide-border/35 overflow-hidden rounded-[1.1rem] bg-black/10 dark:bg-white/[0.03]">
                                            {tools.map((tool) => {
                                                const uniqueKey = toolKey(tool);
                                                const enabled =
                                                    typeof tool.enabled === "boolean"
                                                        ? tool.enabled
                                                        : !preferencesDisabledKeys.has(uniqueKey);
                                                const parameterCount = Math.max(0, tool.parameterCount ?? 0);
                                                const parameterLabel =
                                                    parameterCount === 0
                                                        ? "0 parameters"
                                                        : `${parameterCount} parameter${parameterCount > 1 ? "s" : ""}`;
                                                const description =
                                                    tool.description?.trim() || "No description provided.";
                                                const maxDescriptionLength = 160;
                                                const isTruncated =
                                                    description.length > maxDescriptionLength;
                                                const showFull = expandedDescriptions[uniqueKey] ?? false;
                                                const displayText =
                                                    showFull || !isTruncated
                                                        ? description
                                                        : description.slice(0, maxDescriptionLength);

                                                return (
                                                    <div
                                                        key={uniqueKey}
                                                        className="px-4 py-4"
                                                    >
                                                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                                            <div className="min-w-0 flex-1 space-y-2">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <p className="text-sm font-semibold text-foreground">
                                                                        {tool.toolName}
                                                                    </p>
                                                                    <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                        {parameterLabel}
                                                                    </span>
                                                                    <span
                                                                        className={cn(
                                                                            "inline-flex rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em]",
                                                                            enabled
                                                                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                                                : "bg-muted text-muted-foreground"
                                                                        )}
                                                                    >
                                                                        {enabled ? "Enabled" : "Disabled"}
                                                                    </span>
                                                                </div>
                                                                <p className="text-sm text-muted-foreground">
                                                                    {displayText}
                                                                    {!showFull && isTruncated ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() =>
                                                                                setExpandedDescriptions((prev) => ({
                                                                                    ...prev,
                                                                                    [uniqueKey]: true,
                                                                                }))
                                                                            }
                                                                            className="ml-2 text-[0.72rem] font-semibold text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                                                        >
                                                                            See more
                                                                        </button>
                                                                    ) : null}
                                                                </p>
                                                            </div>

                                                            <button
                                                                type="button"
                                                                role="switch"
                                                                aria-checked={enabled}
                                                                aria-disabled={preferencesSaving}
                                                                onClick={() =>
                                                                    !preferencesSaving && onToggleToolPreference?.(tool)
                                                                }
                                                                className={cn(
                                                                    "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                                                    enabled
                                                                        ? "border-primary/40 bg-primary/20"
                                                                        : "border-transparent bg-background/80",
                                                                    preferencesSaving && "cursor-not-allowed opacity-60"
                                                                )}
                                                            >
                                                                <span
                                                                    className={cn(
                                                                        "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                                        enabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                                                    )}
                                                                />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </SoftPanel>
                            );
                        })
                    )}
                </div>
            </InfoCard>
        </div>
    );
}
