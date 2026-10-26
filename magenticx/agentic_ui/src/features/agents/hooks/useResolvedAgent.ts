import { useEffect, useRef, useState } from "react";

import { useAgentsPage } from "@/features/agents/context";

/**
 * The catalog agent a URL names, with one fresh look before giving up.
 *
 * The catalog in hand can be behind the URL: restored from the last session's
 * snapshot before the login fetch lands, or opened from a link to an agent made
 * in another tab. So an id that is not in it triggers one re-pull of the
 * catalog (per id) before the page says "not found"; `resolving` covers that.
 * An id that is still missing afterwards is unknown, deleted, or not this
 * user's — the catalog only ever holds the platform's agents and their own.
 */
export function useResolvedAgent(agentId: string) {
  const { agents, refreshCatalog } = useAgentsPage();
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const tried = useRef<Set<string>>(new Set());
  const [resolving, setResolving] = useState(() => !agent);

  useEffect(() => {
    if (agent || !agentId || tried.current.has(agentId)) return;
    tried.current.add(agentId);
    setResolving(true);
    // Not cancelled on cleanup: the re-pull is worth finishing either way, and
    // a cancelled flag would end `resolving` early under StrictMode's double
    // effect run (the second run finds the id already tried).
    void refreshCatalog().finally(() => setResolving(false));
  }, [agent, agentId, refreshCatalog]);

  return { agent, resolving: !agent && Boolean(agentId) && resolving };
}
