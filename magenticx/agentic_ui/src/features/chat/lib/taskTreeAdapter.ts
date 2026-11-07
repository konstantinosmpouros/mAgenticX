/**
 * Adapter from the conversation's background task tree (plan 41) to the
 * established sub-agent card chrome — `SubagentTreeCard` / `SubagentCard` draw
 * an async task exactly as they draw a blocking sub-agent, fed here instead of
 * by a run's fold. The card is not redesigned: a task becomes a `SubagentBlock`
 * flagged `asyncTask` (so no run status can end it), and a `SubagentItem` that
 * also carries the task's model, usage and elapsed time.
 */
import {
  isTaskSettled,
  subagentBlockToItem,
  taskChildrenIndex,
  taskDisplayStatus,
  toTitleCase,
} from "@/features/inference";
import { formatCompactTokens } from "@/shared/lib/utils";
import type {
  AsyncTask,
  AsyncTaskDisplayStatus,
  AsyncTaskNodeView,
  AsyncTaskStatus,
  AsyncTaskTreeState,
  ContentBlock,
  SubagentBlock,
  SubagentItem,
  SubagentRunStatus,
  TaskNotice,
  ThinkingBlock,
} from "@/shared/lib/types";

/** A task's status in the card's vocabulary (the badge, the running light). */
export function taskSubagentStatus(status: AsyncTaskDisplayStatus): SubagentRunStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting_children":
      return "waiting_children";
    case "waiting":
      return "awaiting_approval";
    case "stopping":
      return "stopping";
    case "success":
      return "done";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** Whether a task can still be stopped: working, waiting, and not already stopping. */
export function canStopTask(status: AsyncTaskDisplayStatus | null): boolean {
  return status !== null && status !== "stopping" && !isTaskSettled(status);
}

/** "<1s", "42s", "2m 14s", "1h 05m". */
export function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How long the task has worked: until now while it works, until it settled
 * once it did. Null without a start time (nothing honest to show).
 */
export function taskElapsedLabel(task: AsyncTask, now: number): string | null {
  if (task.startedAt === null) return null;
  const end = isTaskSettled(task.status) ? (task.settledAt ?? null) : now;
  if (end === null || end < task.startedAt) return null;
  return formatTaskDuration(end - task.startedAt);
}

/** "1.2K in · 340 out", or null before the task used any tokens. */
export function taskUsageLabel(usage: AsyncTask["usage"]): string | null {
  if (!usage.inputTokens && !usage.outputTokens) return null;
  return `${formatCompactTokens(usage.inputTokens)} in · ${formatCompactTokens(usage.outputTokens)} out`;
}

// The node's own steps and answer, in the two block kinds the card draws. Its
// `task_ref` blocks are its children, which the card nests as cards instead.
function nodeBlocks(node: AsyncTaskNodeView | undefined): (ThinkingBlock | ContentBlock)[] {
  if (!node) return [];
  return node.timeline.blocks.filter(
    (block): block is ThinkingBlock | ContentBlock =>
      block.kind === "thinking" || block.kind === "content",
  );
}

/**
 * One task as a sub-agent block. Its steps come from the node's live events
 * when its socket is open; otherwise the card shows what the tree knows — the
 * result preview, or the error — as the response.
 */
export function taskToSubagentBlock(
  task: AsyncTask,
  status: AsyncTaskDisplayStatus,
  node?: AsyncTaskNodeView,
): SubagentBlock {
  const blocks = nodeBlocks(node);
  const hasText = blocks.some((block) => block.kind === "content" && block.text.trim());
  const fallback = task.resultPreview ?? (task.status === "error" ? task.error : null);
  if (!hasText && fallback) {
    blocks.push({ kind: "content", id: `task-preview:${task.taskId}`, text: fallback });
  }
  return {
    kind: "subagent",
    id: `task:${task.taskId}`,
    taskId: task.taskId,
    type: task.name,
    label: toTitleCase(task.name),
    description: task.description || undefined,
    prompt: task.description || undefined,
    parentTaskId: task.parentTaskId ?? undefined,
    spawned: true,
    asyncTask: true,
    status: taskSubagentStatus(status),
    startedAt: task.startedAt ?? undefined,
    endedAt: task.settledAt ?? undefined,
    blocks,
  };
}

/** The card's view model: the block's, plus the task's model, usage and time. */
export function taskSubagentItem(task: AsyncTask, block: SubagentBlock, now: number): SubagentItem {
  const item = subagentBlockToItem(block);
  const usage = taskUsageLabel(task.usage);
  const elapsed = taskElapsedLabel(task, now);
  return {
    ...item,
    ...(task.model ? { model: task.model } : {}),
    ...(usage ? { usageLabel: usage } : {}),
    ...(elapsed ? { elapsedLabel: elapsed } : {}),
  };
}

export type TaskCardTree = {
  /** The given roots, as cards. */
  roots: SubagentBlock[];
  childrenOf: (block: SubagentBlock) => SubagentBlock[];
  statusOf: (block: SubagentBlock) => SubagentRunStatus | null;
  itemOf: (block: SubagentBlock) => SubagentItem;
  /** The task behind a card (its id, its display status). */
  taskOf: (block: SubagentBlock) => { task: AsyncTask; status: AsyncTaskDisplayStatus } | null;
};

/**
 * The subtree under `roots`, in the shape `SubagentTreeCard` walks. Children
 * are found by `parentTaskId` at every depth; a task whose parent is not in
 * the tree yet is simply not reached (it shows once its parent arrives).
 */
export function buildTaskCardTree(
  tree: AsyncTaskTreeState,
  roots: AsyncTask[],
  now: number,
): TaskCardTree {
  const children = taskChildrenIndex(tree);
  const blocks = new Map<string, SubagentBlock>();
  const statuses = new Map<string, AsyncTaskDisplayStatus>();
  const blockOf = (task: AsyncTask): SubagentBlock => {
    const cached = blocks.get(task.taskId);
    if (cached) return cached;
    const status = taskDisplayStatus(tree, task.taskId) ?? task.status;
    statuses.set(task.taskId, status);
    const block = taskToSubagentBlock(task, status, tree.nodes[task.taskId]);
    blocks.set(task.taskId, block);
    return block;
  };
  return {
    roots: roots.map(blockOf),
    childrenOf: (block) => (children.get(block.taskId) ?? []).map(blockOf),
    statusOf: (block) => block.status ?? null,
    itemOf: (block) => {
      const task = tree.tasks[block.taskId];
      return task ? taskSubagentItem(task, block, now) : subagentBlockToItem(block);
    },
    taskOf: (block) => {
      const task = tree.tasks[block.taskId];
      if (!task) return null;
      return { task, status: statuses.get(block.taskId) ?? task.status };
    },
  };
}

/** How a settled task's end reads in a sentence ("researcher finished"). */
export function taskOutcomeVerb(status: AsyncTaskStatus): string {
  if (status === "error") return "failed";
  if (status === "cancelled") return "was stopped";
  if (status === "success") return "finished";
  return "is still working";
}

/** The notice row's line: "researcher finished · 2m 14s". */
export function taskNoticeText(notice: TaskNotice): string {
  const head = taskSettledText(notice.name, notice.status);
  return notice.durationMs !== null ? `${head} · ${formatTaskDuration(notice.durationMs)}` : head;
}

/**
 * "General Purpose finished": the outcome line shared by the notice row and
 * the inline marker. The name is title-cased the same way the task cards
 * label it, so the line and the card name the sub-agent identically.
 */
export function taskSettledText(name: string, status: Parameters<typeof taskOutcomeVerb>[0]): string {
  return `${toTitleCase(name) ?? name} ${taskOutcomeVerb(status)}`;
}
