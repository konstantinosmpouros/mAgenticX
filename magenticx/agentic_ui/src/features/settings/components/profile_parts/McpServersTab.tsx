import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { ToolWithStatus } from "@/shared/lib/types";
import { InfoCard, MetricCard, SoftPanel } from "./shared";
import { McpIcon } from "./icons";

/**
 * McpServersTab — READ-ONLY inspection of the MCP tool catalog: which servers +
 * tools are available to the platform. Enabling/disabling tools is no longer a
 * global toggle here — that's done per agent in the Agents tab. This tab exists
 * purely to browse what integrations exist and read their descriptions.
 */
type McpServersTabProps = {
  availableTools: ToolWithStatus[];
};

export default function McpServersTab({ availableTools }: McpServersTabProps) {
  // Key off resolvedTheme, not theme: theme is often "system", which would make
  // the light/dark icon swap misfire and render the dark-variant icon in light mode.
  const { resolvedTheme } = useTheme();
  const currentTheme = resolvedTheme === "dark" ? "dark" : "light";

  // Group tools by their server (read-only; no preference state involved).
  const serverGroups = useMemo(
    () =>
      Object.entries(
        availableTools.reduce<Record<string, ToolWithStatus[]>>((acc, tool) => {
          const serverKey = tool.serverId || "default";
          (acc[serverKey] ||= []).push(tool);
          return acc;
        }, {}),
      ),
    [availableTools],
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
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          label="Servers"
          value={String(serverGroups.length)}
          hint="Discovered MCP server groups"
        />
        <MetricCard
          label="Tools"
          value={String(availableTools.length)}
          hint="Available across all servers"
        />
      </div>

      <InfoCard
        eyebrow="Apps"
        title="MCP tools"
        description="Browse the integrations available to the platform and inspect what each tool does. To choose which tools a specific agent may use, open the Agents tab."
      >
        <div className="space-y-4">
          {availableTools.length === 0 ? (
            <SoftPanel className="px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No tools discovered yet. Make sure the MCP tools server is running and refresh after
                login.
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
                      setServerCollapsed((prev) => ({ ...prev, [serverKey]: !collapsed }))
                    }
                    className="flex w-full items-center justify-between gap-4 rounded-2xl text-left"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-muted">
                        <McpIcon
                          size={20}
                          variant={currentTheme === "dark" ? "white" : "darkGrey"}
                        />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{serverLabel}</p>
                        <p className="text-sm text-muted-foreground">
                          {tools.length} tool{tools.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                    <ChevronDown
                      size={18}
                      className={cn(
                        "text-muted-foreground transition-transform",
                        collapsed ? "-rotate-90" : "rotate-0",
                      )}
                    />
                  </button>

                  {!collapsed ? (
                    <div className="mt-4 divide-y divide-border/35 overflow-hidden rounded-[1.1rem] bg-black/10 dark:bg-white/[0.03]">
                      {tools.map((tool) => {
                        const uniqueKey = `${tool.serverId || "default"}::${tool.toolName}`;
                        const parameterCount = Math.max(0, tool.parameterCount ?? 0);
                        const parameterLabel =
                          parameterCount === 0
                            ? "0 parameters"
                            : `${parameterCount} parameter${parameterCount > 1 ? "s" : ""}`;
                        const description = tool.description?.trim() || "No description provided.";
                        const maxDescriptionLength = 160;
                        const isTruncated = description.length > maxDescriptionLength;
                        const showFull = expandedDescriptions[uniqueKey] ?? false;
                        const displayText =
                          showFull || !isTruncated
                            ? description
                            : `${description.slice(0, maxDescriptionLength)}…`;

                        return (
                          <div key={uniqueKey} className="px-4 py-4">
                            <div className="min-w-0 space-y-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold text-foreground">
                                  {tool.toolName}
                                </p>
                                <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                  {parameterLabel}
                                </span>
                              </div>
                              <p className="text-sm leading-relaxed text-muted-foreground">
                                {displayText}
                                {isTruncated ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedDescriptions((prev) => ({
                                        ...prev,
                                        [uniqueKey]: !showFull,
                                      }))
                                    }
                                    className="ml-2 text-[0.72rem] font-semibold text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                  >
                                    {showFull ? "See less" : "See more"}
                                  </button>
                                ) : null}
                              </p>
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
