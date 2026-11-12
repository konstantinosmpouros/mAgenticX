import { useBackgroundTasksContext } from "@/features/inference";
import { taskNoticeText } from "@/features/chat/lib/taskTreeAdapter";
import type { MessageOut } from "@/shared/lib/types";
import { TaskMarker } from "./ConversationMarkers";

/**
 * A wake-up's input row (`messages.kind = task_notification`, plan 41 §3.9):
 * the system telling the orchestrator a background task settled. It is a
 * `user`-sender row in the tree (the graph input is a HumanMessage) but never
 * the user's words, so it is drawn as one compact centred line — "✓ researcher
 * finished · 2m 14s" — not a bubble, with no edit, copy or branch controls.
 * Click opens that task's drill-down.
 */
export function TaskNoticeRow({ message }: { message: MessageOut }) {
  const tasks = useBackgroundTasksContext();
  const notice = message.taskNotice;
  if (!notice) {
    return <TaskMarker status="success" text="A background task finished" />;
  }
  const known = Boolean(tasks?.tree.tasks[notice.taskId]);
  return (
    <TaskMarker
      status={notice.status}
      text={taskNoticeText(notice)}
      onOpen={tasks && known ? () => tasks.openTask(notice.taskId) : undefined}
    />
  );
}
