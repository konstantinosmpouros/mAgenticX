/**
 * Per-browser memory for the reasoning effort picked for each agent.
 *
 * Like `sidebarStorage.ts`, a small preference read on the first render, kept
 * outside the IndexedDB UI snapshot so it needs no snapshot version bump. Only
 * the agent id (in the key) and the level's name are stored. A stored value is
 * read back through `toEffortLevel`, so anything unknown reads as nothing.
 */
import { toEffortLevel, type EffortLevel } from "./schemas";

const effortKey = (agentId: string) => `mx_effort_${agentId}`;

/** The level last picked for this agent, or null (also when storage is unavailable). */
export function loadAgentEffort(agentId: string): EffortLevel | null {
  try {
    return toEffortLevel(localStorage.getItem(effortKey(agentId)));
  } catch {
    return null;
  }
}

export function saveAgentEffort(agentId: string, level: EffortLevel): void {
  try {
    localStorage.setItem(effortKey(agentId), level);
  } catch {
    // localStorage unavailable — the pick still holds for this document
  }
}
