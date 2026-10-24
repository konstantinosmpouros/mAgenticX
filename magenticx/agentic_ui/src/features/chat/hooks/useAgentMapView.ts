import * as React from "react";

/**
 * How the agent map draws the conversation's sub-agents: as the indented tree
 * or as a top-down graph. A per-browser preference — kept in localStorage like
 * the sidebar's sections (shared/lib/sidebarStorage), the tree by default and
 * whenever storage is unavailable. Only the literal "tree" / "flow" is stored.
 */
export type AgentMapViewMode = "tree" | "flow";

export const AGENT_MAP_VIEW_KEY = "mx_agent_map_view";

export function loadAgentMapView(): AgentMapViewMode {
  try {
    return localStorage.getItem(AGENT_MAP_VIEW_KEY) === "flow" ? "flow" : "tree";
  } catch {
    return "tree";
  }
}

export function saveAgentMapView(mode: AgentMapViewMode): void {
  try {
    localStorage.setItem(AGENT_MAP_VIEW_KEY, mode);
  } catch {
    // localStorage unavailable — the choice still holds for this document
  }
}

/** The remembered view, and a setter that remembers the next one. */
export function useAgentMapView(): [AgentMapViewMode, (mode: AgentMapViewMode) => void] {
  const [mode, setMode] = React.useState<AgentMapViewMode>(loadAgentMapView);
  const change = React.useCallback((next: AgentMapViewMode) => {
    setMode(next);
    saveAgentMapView(next);
  }, []);
  return [mode, change];
}
