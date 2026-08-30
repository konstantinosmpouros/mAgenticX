import type { AgentToolRow } from "@/shared/lib/types";

/**
 * Grouping and counting for an agent's tool list.
 *
 * The old list was one flat stack of ~100px rows with no counts, which stopped
 * being readable somewhere around a dozen tools. These helpers turn the flat
 * `AgentToolRow[]` into the shape the dense list renders: sources in a stable
 * order, each carrying its own on/off tally so a collapsed group still tells
 * you whether anything inside it is live.
 *
 * Kept pure and separate from the components so the grouping rules — which is
 * what actually decides whether the screen reads correctly — are testable
 * without mounting a tree.
 */

/**
 * Tools the platform gates on every agent, whatever its definition says.
 *
 * Mirrors `_HITL_FLOOR` in `agents/runtime/abstractions/user_agents.py`. The two
 * lists are coupled with nothing enforcing it — a gate present there but missing
 * here once made every agent save fail validation — so treat the server as the
 * authority and keep this in step with it.
 */
export const ALWAYS_GATED: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "execute",
  "task",
  "create_skill",
]);

/** Built-in tools have a bare key; MCP tools are keyed `server_id/tool_name`. */
export const BUILTIN_GROUP = "Built in";

export type ToolGroup = {
  /** Display name: `Built in`, or the MCP server id. */
  id: string;
  /** True for the platform's own tools, which are never grouped under a server. */
  builtin: boolean;
  tools: AgentToolRow[];
  enabled: number;
  total: number;
};

export type ToolFilter = "all" | "on" | "off";

/**
 * The server an MCP tool belongs to, or null for a built-in.
 *
 * Mirrors `_make_cache_key` in the agents service: `server_id/tool_name`, with
 * the server omitted entirely when there isn't one. Splitting on the FIRST
 * slash matters — a tool name may contain slashes, a server id may not.
 */
export const toolServerId = (row: AgentToolRow): string | null => {
  const slash = row.key.indexOf("/");
  if (slash <= 0) return null;
  return row.key.slice(0, slash);
};

/** A tool is on when it is not disabled. `declared` says where it came from, not whether it runs. */
export const isToolEnabled = (row: AgentToolRow): boolean => !row.disabled;

/** Case-insensitive match across the name and the description. */
export const matchesToolQuery = (row: AgentToolRow, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q);
};

export const passesToolFilter = (row: AgentToolRow, filter: ToolFilter): boolean =>
  filter === "all" || (filter === "on") === isToolEnabled(row);

/**
 * Group rows by source, built-ins first then servers alphabetically.
 *
 * Counts are computed over the tools that survived filtering, so the header
 * describes what is actually on screen. Empty groups are dropped: a server
 * whose every tool was filtered out is noise, not information.
 */
export const groupTools = (
  rows: AgentToolRow[],
  { query = "", filter = "all" as ToolFilter } = {},
): ToolGroup[] => {
  const buckets = new Map<string, AgentToolRow[]>();
  for (const row of rows) {
    if (!matchesToolQuery(row, query) || !passesToolFilter(row, filter)) continue;
    const server = toolServerId(row);
    const id = server ?? BUILTIN_GROUP;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }

  const groups: ToolGroup[] = [];
  for (const [id, tools] of buckets) {
    tools.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      id,
      builtin: id === BUILTIN_GROUP,
      tools,
      enabled: tools.filter(isToolEnabled).length,
      total: tools.length,
    });
  }

  // Built-ins first — they are the agent's own capability and the thing a
  // reader orients on; gateway servers follow alphabetically.
  groups.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return groups;
};

/** Overall tally for the section header, over the unfiltered set. */
export const countEnabled = (rows: AgentToolRow[]): { enabled: number; total: number } => ({
  enabled: rows.filter(isToolEnabled).length,
  total: rows.length,
});
