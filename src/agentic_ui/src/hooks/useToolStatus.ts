import { useMemo } from "react";

import type { ToolWithStatus, UserPreferences } from "@/shared/lib/types";

const toolKey = (tool: ToolWithStatus) => {
    const prefix = tool.serverId && tool.serverId.length > 0 ? tool.serverId : "default";
    return `${prefix}::${tool.toolName}`;
};

export function useToolStatus(availableTools: ToolWithStatus[], userPreferences: UserPreferences) {
    const disabledKeys = useMemo(() => {
        const entries = userPreferences?.tools?.disabled ?? [];
        const keys = entries.map((item) => {
            const name = (item as { toolName?: string; tool_name?: string }).toolName
                ?? (item as { toolName?: string; tool_name?: string }).tool_name
                ?? "";
            const serverPrefix = item.serverId && item.serverId.length > 0 ? item.serverId : "default";
            return `${serverPrefix}::${name}`;
        });
        return new Set(keys);
    }, [userPreferences]);

    const serverGroups = useMemo(
        () =>
            Object.entries(
                availableTools.reduce<Record<string, ToolWithStatus[]>>((acc, tool) => {
                    const serverKey = tool.serverId || "default";
                    if (!acc[serverKey]) acc[serverKey] = [];
                    acc[serverKey].push(tool);
                    return acc;
                }, {})
            ),
        [availableTools]
    );

    const enabledToolsCount = useMemo(
        () =>
            availableTools.filter((tool) =>
                typeof tool.enabled === "boolean" ? tool.enabled : !disabledKeys.has(toolKey(tool))
            ).length,
        [availableTools, disabledKeys]
    );

    return { toolKey, disabledKeys, serverGroups, enabledToolsCount };
}
