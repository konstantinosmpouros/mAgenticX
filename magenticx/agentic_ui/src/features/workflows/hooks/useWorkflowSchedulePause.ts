import { useCallback } from "react";

import { pauseWorkflowSchedule, resumeWorkflowSchedule } from "@/shared/lib/api";
import type { WorkflowSchedule } from "@/shared/lib/types";
import { setSchedulePausedOptimistic } from "@/shared/lib/workflowSchedule";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";

/**
 * Pause or resume a workflow's schedule as the signed-in user, optimistically:
 * `apply` (the caller's state setter — the list's or the open workflow's)
 * gets the expected schedule at once, then the server's answer, or the old
 * schedule back when the call fails (the error is rethrown for a toast).
 */
export function useWorkflowSchedulePause() {
  const userId = useWorkflowUserId();
  return useCallback(
    async (
      workflowId: string,
      current: WorkflowSchedule,
      paused: boolean,
      apply: (schedule: WorkflowSchedule) => void,
    ): Promise<WorkflowSchedule> => {
      if (!userId) throw new Error("You're signed out.");
      return setSchedulePausedOptimistic({
        current,
        paused,
        apply,
        send: () =>
          paused
            ? pauseWorkflowSchedule(userId, workflowId)
            : resumeWorkflowSchedule(userId, workflowId),
      });
    },
    [userId],
  );
}
