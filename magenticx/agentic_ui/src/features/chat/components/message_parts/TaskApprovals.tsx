import { useMemo } from "react";

import { pendingTimelineInterrupts, type BackgroundTasksContextValue } from "@/features/inference";
import type { AsyncTask } from "@/shared/lib/types";
import { HitlInterruptCard } from "./HitlInterruptCard";

type TaskApprovalsProps = {
  task: AsyncTask;
  tasks: BackgroundTasksContextValue;
};

/**
 * A waiting task's pending approvals, each answerable here: the decision goes
 * to the task's own run (`resumeTask`), not the conversation's. Shared by the
 * task drill-down and the agent map's detail view, so the user can approve or
 * reject wherever they are looking at the task. Until the task's events bring
 * the approval in, a placeholder holds its place.
 */
export function TaskApprovals({ task, tasks }: TaskApprovalsProps) {
  const { tree, resumeTask, isDecisionSent } = tasks;
  const timeline = tree.nodes[task.taskId]?.timeline;
  const approvals = useMemo(
    () => (task.status === "waiting" ? pendingTimelineInterrupts(timeline) : []),
    [timeline, task.status],
  );

  if (task.status !== "waiting") return null;
  if (!approvals.length) {
    return (
      <div className="loading-skeleton h-24 rounded-[24px]" aria-label="Loading the approval" />
    );
  }
  return (
    <>
      {approvals.map((approval) => (
        <HitlInterruptCard
          key={approval.id}
          interrupt={{
            interruptId: approval.id,
            threadId: approval.threadId,
            content: approval.content,
          }}
          resolved={isDecisionSent(approval.id)}
          onResolve={(decision, reason) =>
            resumeTask(task.taskId, {
              interruptId: approval.id,
              threadId: approval.threadId,
              decision,
              reason,
            })
          }
        />
      ))}
    </>
  );
}
