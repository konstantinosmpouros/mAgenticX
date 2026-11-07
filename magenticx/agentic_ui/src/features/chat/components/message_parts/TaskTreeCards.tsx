import { useMemo } from "react";

import { isTaskSettled, type BackgroundTasksContextValue } from "@/features/inference";
import { buildTaskCardTree } from "@/features/chat/lib/taskTreeAdapter";
import { useTaskClock } from "@/features/chat/hooks/useTaskClock";
import type { AsyncTask } from "@/shared/lib/types";
import { SubagentTreeCard } from "./SubagentTreeCard";
import { TaskStopButton } from "./TaskStopButton";

type TaskTreeCardsProps = {
  /** The tasks to draw as roots; each brings its whole subtree. */
  roots: AsyncTask[];
  tasks: BackgroundTasksContextValue;
  defaultCollapsedSections?: boolean;
};

/**
 * Background tasks (plan 41) drawn with the established sub-agent chrome: each
 * root a `SubagentTreeCard` with its sub-agents nested inside at every depth,
 * fed by the task-tree adapter. A card opens the task's drill-down (any depth)
 * instead of expanding in place, and an active one carries Stop on the right
 * of its row. Elapsed times tick while anything in the tree still works.
 */
export function TaskTreeCards({ roots, tasks, defaultCollapsedSections }: TaskTreeCardsProps) {
  const { tree, openTask, stopTask } = tasks;
  const anyActive = useMemo(
    () => Object.values(tree.tasks).some((task) => !isTaskSettled(task.status)),
    [tree.tasks],
  );
  const now = useTaskClock(anyActive);
  const cards = useMemo(() => buildTaskCardTree(tree, roots, now), [tree, roots, now]);

  if (!cards.roots.length) return null;
  return (
    <div className="space-y-3">
      {cards.roots.map((block, index) => (
        <SubagentTreeCard
          key={block.id}
          block={block}
          index={index}
          childrenOf={cards.childrenOf}
          statusOf={cards.statusOf}
          itemOf={cards.itemOf}
          onOpen={(card) => openTask(card.taskId)}
          defaultCollapsedSections={defaultCollapsedSections}
          trailingOf={(card) => {
            const entry = cards.taskOf(card);
            if (!entry) return null;
            return (
              <TaskStopButton
                name={entry.task.name}
                status={entry.status}
                onStop={() => void stopTask(entry.task.taskId)}
              />
            );
          }}
        />
      ))}
    </div>
  );
}
