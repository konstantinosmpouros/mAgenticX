import { useMemo } from "react";

import { buildAgentMap, collectAgentMapAnswers, type AgentMap } from "@/features/chat/lib/agentMap";
import type { MessageOut, RunTimeline } from "@/shared/lib/types";

/**
 * The agent map of the branch the user sees: `messages` is the same list the
 * chat body renders, and the live answer takes the active run's timeline while
 * it streams. Settled answers are folded once per event log and rebuilt only
 * when they change (lib/agentMap), so a streamed frame rebuilds one answer.
 */
export function useAgentMap(
  messages: MessageOut[],
  liveMessageId: string | null,
  liveTimeline: RunTimeline | null,
): AgentMap {
  return useMemo(
    () =>
      buildAgentMap(
        collectAgentMapAnswers(messages, { messageId: liveMessageId, timeline: liveTimeline }),
      ),
    [messages, liveMessageId, liveTimeline],
  );
}
