import { useBackgroundTasksContext } from "@/features/inference";
import { taskSettledText } from "@/features/chat/lib/taskTreeAdapter";
import type { TaskSettledBlock } from "@/shared/lib/types";
import { TaskOutcomeLine } from "./TaskOutcomeLine";

/**
 * "✓ researcher finished" inside an answer: a background task's result was
 * pulled into this run while it was busy, instead of waking the orchestrator
 * with a run of its own (TASK_SETTLED_INLINE, plan 41 §3.9). Persisted with the
 * run's events, so the moment the result arrived survives a reload. Opens the
 * task's drill-down when the tree is at hand.
 */
export function TaskSettledMarker({ block }: { block: TaskSettledBlock }) {
  const tasks = useBackgroundTasksContext();
  const known = Boolean(tasks?.tree.tasks[block.taskId]);
  return (
    <TaskOutcomeLine
      status={block.status}
      text={taskSettledText(block.name, block.status)}
      onOpen={tasks && known ? () => tasks.openTask(block.taskId) : undefined}
    />
  );
}
