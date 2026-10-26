import type { Agent } from "@/shared/lib/types";

// The picker's "Manage agents…" row. A real item rather than a button below the
// list, so arrow keys reach it like any agent; choosing it opens the Agents
// section and never becomes the selection.
export const MANAGE_AGENTS_VALUE = "__manage_agents__";

/**
 * The picker's groups: the user's own agents first ("My agents", by the
 * catalog's `kind`), then the platform's. A group with no agents is left out,
 * and with no custom agents at all the list is one unlabelled group, as before.
 */
export function groupPickerAgents(agents: Agent[]): { label: string | null; agents: Agent[] }[] {
  const mine = agents.filter((agent) => agent.kind === "custom");
  if (mine.length === 0) return [{ label: null, agents }];
  const platform = agents.filter((agent) => agent.kind !== "custom");
  return [
    { label: "My agents", agents: mine },
    ...(platform.length ? [{ label: "Platform", agents: platform }] : []),
  ];
}
