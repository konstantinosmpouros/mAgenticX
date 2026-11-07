import { useMemo } from "react";
import { CornerDownRight } from "lucide-react";

import { toTitleCase, useBackgroundTasksContext } from "@/features/inference";
import type { TaskRefBlock } from "@/shared/lib/types";
import { SubagentCard } from "./SubagentContainer";
import { TaskTreeCards } from "./TaskTreeCards";

/**
 * "Started task" — where in its answer a run launched a background task
 * (TASK_LAUNCHED, plan 41). The block itself only says what the launch said;
 * everything live (status, elapsed time, its own sub-agents, Stop, the
 * drill-down) comes from the conversation's task tree, so the card stays live
 * after the run that launched it has ended and the chat has moved on. Before
 * the tree knows the task (or outside a conversation, e.g. a shared view) the
 * card shows the launch alone, with no status — never a guessed one.
 */
export function TaskRefBlockView({ block }: { block: TaskRefBlock }) {
  const tasks = useBackgroundTasksContext();
  const task = tasks?.tree.tasks[block.taskId];
  const roots = useMemo(() => (task ? [task] : []), [task]);
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <CornerDownRight className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Started task in the background</span>
      </p>
      {tasks && task ? (
        <TaskTreeCards roots={roots} tasks={tasks} />
      ) : (
        <SubagentCard
          subagent={{
            id: block.taskId,
            label: toTitleCase(block.name),
            type: block.name,
            description: block.description,
            prompt: block.description,
          }}
          status={null}
        />
      )}
    </div>
  );
}
