import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getAgentModelInfo } from "@/shared/lib/api";
import { loadAgentEffort, saveAgentEffort } from "@/shared/lib/effortStorage";
import type { AgentEffortChoice, EffortLevel } from "@/shared/lib/types";
import { resolveEffort } from "@/features/chat/lib/effort";

/** How long an agent's model info is reused before it is asked for again. */
const AGENT_MODEL_STALE_MS = 5 * 60_000;

const NO_EFFORTS: readonly EffortLevel[] = [];

export type AgentEffortState = {
  /** The levels the agent's model takes, in the server's order; empty → no picker. */
  efforts: readonly EffortLevel[];
  /** The level in use for this agent, or null when it takes none. */
  effort: EffortLevel | null;
  /** What the send flow carries: the pick and the agent it is for. Null with no agent. */
  choice: AgentEffortChoice | null;
  setEffort: (level: EffortLevel) => void;
};

/**
 * The reasoning effort for the agent the next message goes to (the composer's
 * picker). The agent's levels come from `GET /agents/{user}/{agent}/model`; a
 * failed or pending load reads as "no levels", so it never blocks a send — the
 * message simply goes without an effort. The pick is remembered per agent in
 * this browser and falls back to the agent's default (else the middle level)
 * once the agent no longer lists it.
 */
export function useAgentEffort({
  userId,
  agentId,
}: {
  userId: string | null;
  agentId: string | null;
}): AgentEffortState {
  const query = useQuery({
    queryKey: ["agent-model", userId, agentId],
    queryFn: () => getAgentModelInfo(userId as string, agentId as string),
    enabled: Boolean(userId && agentId),
    staleTime: AGENT_MODEL_STALE_MS,
    retry: 1,
  });
  const efforts = query.data?.efforts ?? NO_EFFORTS;
  const defaultEffort = query.data?.defaultEffort ?? null;

  // Picks made in this document, by agent; storage holds the ones from before.
  const [picked, setPicked] = useState<Record<string, EffortLevel>>({});
  const stored = useMemo(
    () => (agentId ? (picked[agentId] ?? loadAgentEffort(agentId)) : null),
    [agentId, picked],
  );
  const effort = resolveEffort(efforts, defaultEffort, stored);

  const setEffort = useCallback(
    (level: EffortLevel) => {
      if (!agentId) return;
      setPicked((prev) => (prev[agentId] === level ? prev : { ...prev, [agentId]: level }));
      saveAgentEffort(agentId, level);
    },
    [agentId],
  );

  const choice = useMemo<AgentEffortChoice | null>(
    () => (agentId ? { agentId, level: effort } : null),
    [agentId, effort],
  );

  return { efforts, effort, choice, setEffort };
}
