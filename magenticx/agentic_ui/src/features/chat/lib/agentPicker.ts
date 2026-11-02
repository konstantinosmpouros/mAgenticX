import type { Agent } from "@/shared/lib/types";

/**
 * The chat's agent picker never scrolls: it shows at most `PICKER_LIMIT` rows,
 * whatever the number of agents. With no search those are the agents used most
 * recently (filled up with the user's own, then the platform's); a search
 * replaces them with the best matches and says how many more there are.
 * "Browse all agents" opens the Agents section for everything else.
 */
export const PICKER_LIMIT = 5;

const RECENT_KEY = "agent-picker:recent";
const RECENT_KEEP = 12;

/** The ids picked most recently, newest first; empty when storage is unavailable. */
export function readRecentAgentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Puts `id` first in the recent list (kept short); a no-op when storage is unavailable. */
export function rememberAgentPick(id: string): void {
  try {
    const next = [id, ...readRecentAgentIds().filter((other) => other !== id)].slice(0, RECENT_KEEP);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private windows and blocked storage: the picker still works, without recents.
  }
}

/**
 * The rows with no search: the selected agent, then the recent ones, then the
 * user's own and the platform's in catalog order — `limit` at most, no repeats.
 */
export function pickerDefaults(
  agents: Agent[],
  selectedId: string,
  recentIds: string[],
  limit = PICKER_LIMIT,
): Agent[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const order = [
    selectedId,
    ...recentIds,
    ...agents.filter((agent) => agent.kind === "custom").map((agent) => agent.id),
    ...agents.filter((agent) => agent.kind !== "custom").map((agent) => agent.id),
  ];
  const rows: Agent[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const agent = byId.get(id);
    if (!agent || seen.has(id)) continue;
    seen.add(id);
    rows.push(agent);
    if (rows.length === limit) break;
  }
  return rows;
}

/**
 * Every agent matching `query`, best first: a name that starts with it, then a
 * name that contains it, then a description that does; catalog order within
 * each. An empty query matches everyone, in catalog order.
 */
export function matchPickerAgents(agents: Agent[], query: string): Agent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  const rank = (agent: Agent): number => {
    const name = agent.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (agent.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return agents
    .map((agent, index) => ({ agent, index, score: rank(agent) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.agent);
}

/** The picker's search: the first `limit` matches, and how many matched in all. */
export function searchPickerAgents(
  agents: Agent[],
  query: string,
  limit = PICKER_LIMIT,
): { rows: Agent[]; total: number } {
  const matched = matchPickerAgents(agents, query);
  return { rows: matched.slice(0, limit), total: matched.length };
}

/** The search panel's filters. */
export type AgentScope = "all" | "mine" | "platform";

export const inScope = (agent: Agent, scope: AgentScope): boolean =>
  scope === "all" || (scope === "mine") === (agent.kind === "custom");

/** How many result cards one page of the search panel holds. */
export const RESULTS_PAGE_SIZE = 6;

/** The page count for `count` results (at least one, so an empty search still has a page). */
export const pageCount = (count: number, size = RESULTS_PAGE_SIZE): number =>
  Math.max(1, Math.ceil(count / size));

/** Splits `text` around the first case-insensitive match of `query`, for highlighting. */
export function splitMatch(text: string, query: string): [string, string, string] | null {
  const q = query.trim();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}
