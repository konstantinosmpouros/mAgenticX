import { useMemo } from "react";

import { buildAgentMap, collectAgentMapAnswers, taskAgentNodes, type AgentMap } from "@/features/chat/lib/agentMap";
import { buildTaskCardTree } from "@/features/chat/lib/taskTreeAdapter";
import { rootTasksForMessage } from "@/features/inference";
import type { AsyncTaskTreeState, MessageOut, RunTimeline } from "@/shared/lib/types";

/**
 * The agent map of the branch the user sees: `messages` is the same list the
 * chat body renders, and the live answer takes the active run's timeline while
 * it streams. Settled answers are folded once per event log and rebuilt only
 * when they change (lib/agentMap), so a streamed frame rebuilds one answer.
 *
 * Background tasks (plan 41) come from the conversation's task tree and are
 * placed under the answer that launched them (`spawned_by_message_id`), so the
 * map, its badge and its running count include async sub-agents too.
 */
export function useAgentMap(
  messages: MessageOut[],
  liveMessageId: string | null,
  liveTimeline: RunTimeline | null,
  taskTree: AsyncTaskTreeState | null = null,
): AgentMap {
  return useMemo(() => {
    const taskNodesFor = taskTree
      ? (messageId: string) => {
          const roots = rootTasksForMessage(taskTree, messageId);
          if (!roots.length) return [];
          return taskAgentNodes(messageId, buildTaskCardTree(taskTree, roots, Date.now()));
        }
      : undefined;
    return buildAgentMap(
      collectAgentMapAnswers(messages, { messageId: liveMessageId, timeline: liveTimeline }),
      taskNodesFor,
    );
  }, [messages, liveMessageId, liveTimeline, taskTree]);
}
