import { useMemo } from "react";

import { rootTasksForMessage, useBackgroundTasksContext } from "@/features/inference";
import type { MessageOut, RunTimeline } from "@/shared/lib/types";
import { TaskTreeCards } from "./TaskTreeCards";

type MessageTaskTreeProps = {
  message: MessageOut;
  /** The answer's timeline: tasks it already shows at their launch point are skipped. */
  timeline: RunTimeline | null;
};

/**
 * The background tasks an AI message started (plan 41 §3.9: the tree stays on
 * the message that spawned it, live, after the chat has moved on). A task the
 * answer's own events announced is drawn at that point by its "Started task"
 * block; this lists the rest — a launch whose event the answer does not carry —
 * so no root task of the message goes undrawn.
 */
export function MessageTaskTree({ message, timeline }: MessageTaskTreeProps) {
  const tasks = useBackgroundTasksContext();
  const referenced = useMemo(() => {
    const ids = new Set<string>();
    for (const block of timeline?.blocks ?? []) {
      if (block.kind === "task_ref") ids.add(block.taskId);
    }
    return ids;
  }, [timeline]);
  const roots = useMemo(
    () =>
      tasks
        ? rootTasksForMessage(tasks.tree, message.id).filter((task) => !referenced.has(task.taskId))
        : [],
    [message.id, referenced, tasks],
  );
  if (!tasks || !roots.length) return null;
  return (
    <section aria-label="Background tasks" className="space-y-1.5">
      <p className="px-1 text-xs text-muted-foreground">Background tasks</p>
      <TaskTreeCards roots={roots} tasks={tasks} />
    </section>
  );
}
