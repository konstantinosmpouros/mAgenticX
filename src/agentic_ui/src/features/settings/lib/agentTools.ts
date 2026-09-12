import type { AgentToolRow } from "@/shared/lib/types";

/**
 * Grouping, filtering and tallying for the Agents tab's tool lists.
 *
 * A tool has two independent switches — whether the agent may use it, and
 * whether it pauses for approval first — so every helper takes the axis it is
 * reporting on. Reading the wrong field would show a switch that reports one
 * thing and writes the other.
 */

export type ToolGroup = {
  /** Display name: a builtin's family, or the MCP server id. */
  id: string;
  /** True for prebuilt tools, which are never enable-configurable. */
  builtin: boolean;
  tools: AgentToolRow[];
  enabled: number;
  total: number;
};

export type ToolFilter = "all" | "on" | "off";

/** Which of a tool's two switches a list is showing. */
export type ToolAxis = "enable" | "approval";

/** Whether the row's switch reads as on, for the axis being shown. */
export const isToolOn = (row: AgentToolRow, axis: ToolAxis = "enable"): boolean =>
  axis === "approval" ? row.approval : row.enabled;

/**
 * Whether the user may change this row on this axis.
 *
 * A prebuilt tool is built by the framework downstream of the tool list, so it
 * can never be switched off; a locked gate is re-applied by the runtime after
 * every user choice. Rendering a live switch for either would be a control that
 * silently does nothing.
 */
export const isToolLocked = (row: AgentToolRow, axis: ToolAxis = "enable"): boolean =>
  axis === "approval" ? row.approvalLocked : row.kind === "builtin";

/** Case-insensitive match across the name and the description. */
export const matchesToolQuery = (row: AgentToolRow, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q);
};

export const passesToolFilter = (
  row: AgentToolRow,
  filter: ToolFilter,
  axis: ToolAxis = "enable",
): boolean => filter === "all" || (filter === "on") === isToolOn(row, axis);

/**
 * Group rows by source, prebuilt families first then MCP servers.
 *
 * Counts are computed over the tools that survived filtering, so a header
 * describes what is actually on screen. Empty groups are dropped: a server whose
 * every tool was filtered out is noise, not information.
 */
export const groupTools = (
  rows: AgentToolRow[],
  { query = "", filter = "all" as ToolFilter, axis = "enable" as ToolAxis } = {},
): ToolGroup[] => {
  const buckets = new Map<string, AgentToolRow[]>();
  const builtinGroups = new Set<string>();

  for (const row of rows) {
    if (!matchesToolQuery(row, query) || !passesToolFilter(row, filter, axis)) continue;
    if (row.kind === "builtin") builtinGroups.add(row.group);
    const bucket = buckets.get(row.group);
    if (bucket) bucket.push(row);
    else buckets.set(row.group, [row]);
  }

  const groups: ToolGroup[] = [];
  for (const [id, tools] of buckets) {
    tools.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      id,
      builtin: builtinGroups.has(id),
      tools,
      enabled: tools.filter((row) => isToolOn(row, axis)).length,
      total: tools.length,
    });
  }

  // Prebuilt families first — they are what the agent always has, and the thing
  // a reader orients on; gateway servers follow alphabetically.
  groups.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return groups;
};

/** Overall tally for the section header, over the unfiltered set. */
export const countEnabled = (
  rows: AgentToolRow[],
  axis: ToolAxis = "enable",
): { enabled: number; total: number } => ({
  enabled: rows.filter((row) => isToolOn(row, axis)).length,
  total: rows.length,
});
