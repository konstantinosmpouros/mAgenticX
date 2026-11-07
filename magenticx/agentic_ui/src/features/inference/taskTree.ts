/**
 * The conversation's background task tree (plan 41 §3.9) — a pure fold.
 *
 * Every sub-agent is an async task that outlives the run that started it, so
 * tasks are held per conversation, not inside a run's timeline. Three sources
 * write here and may race each other:
 *
 *   - `GET …/tasks` on load and after every channel (re)connect (hydration);
 *   - the conversation channel's `TASK_STARTED` / `TASK_STATUS` /
 *     `TASK_SETTLED` frames, and the REST answers of cancel/resume, which are
 *     the same `TaskOut` and go through the same merge;
 *   - one task's own socket (the drill-down, or a task waiting on an
 *     approval), whose AG-UI events are folded by the run timeline reducer —
 *     the same `reduceTimelineEvents` a top-level run uses, since a task's
 *     stream is exactly what the normalizer emits for one.
 *
 * Ordering rules, so frames may land in any order:
 *   - the tree is flat by id; parent/child links are read off `parentTaskId`
 *     when drawn, so a child may arrive before its parent;
 *   - a `TASK_STARTED` for a task already known never rolls its status back;
 *   - a hydration answer never overwrites a task a frame wrote after the
 *     request went out (`clock` / `touchedAt`);
 *   - a status that would revive a task the user just stopped is ignored for a
 *     short grace window (a frame emitted before the cancel, relayed after);
 *     past it a settled task may reopen, as §3.4 allows.
 */
import { createTimeline, finalizeTimeline, foldTimeline, reduceTimelineEvents } from "./timeline";
import { SETTLED_ASYNC_TASK_STATUSES } from "@/shared/lib/schemas";
import type {
  AsyncTask,
  AsyncTaskDisplayStatus,
  AsyncTaskFrameEvent,
  AsyncTaskStatus,
  AsyncTaskTreeState,
  TaskSocketFrame,
  TimelineTerminalStatus,
} from "@/shared/lib/types";

/**
 * How long after a Stop a status frame that would revive the task is treated
 * as stale. Long enough to cover the bridge relaying a frame emitted before
 * the cancel; short enough that a deliberate reopen afterwards still shows.
 */
export const STOP_GRACE_MS = 10_000;

export function isTaskSettled(status: AsyncTaskStatus): boolean {
  return SETTLED_ASYNC_TASK_STATUSES.includes(status);
}

/** The run-terminal status a settled task's timeline is closed with. */
export function taskTerminalStatus(status: AsyncTaskStatus): TimelineTerminalStatus | null {
  if (status === "success") return "completed";
  if (status === "error") return "failed";
  if (status === "cancelled") return "cancelled";
  return null;
}

export function createTaskTree(conversationId: string | null = null): AsyncTaskTreeState {
  return {
    conversationId,
    tasks: {},
    clock: 0,
    touchedAt: {},
    stopRequestedAt: {},
    nodes: {},
  };
}

/**
 * The merge of one incoming `TaskOut` into what the tree holds. Returns the
 * task to keep — `existing` itself when the incoming one must be ignored.
 */
function mergeTask(
  existing: AsyncTask | undefined,
  incoming: AsyncTask,
  event: AsyncTaskFrameEvent,
  stopRequestedAt: number | undefined,
  now: number,
): AsyncTask {
  if (!existing) return incoming;
  // A start announcement for a task we already know (a replay, or one that
  // overtook it) only fills in what we lacked; it never moves the status.
  if (event === "TASK_STARTED") {
    return {
      ...incoming,
      status: existing.status,
      settledAt: existing.settledAt,
      resultPreview: existing.resultPreview ?? incoming.resultPreview,
      error: existing.error ?? incoming.error,
      usage: maxUsage(existing.usage, incoming.usage),
      startedAt: existing.startedAt ?? incoming.startedAt,
    };
  }
  const revives = isTaskSettled(existing.status) && !isTaskSettled(incoming.status);
  if (
    revives &&
    existing.status === "cancelled" &&
    stopRequestedAt !== undefined &&
    now - stopRequestedAt < STOP_GRACE_MS
  ) {
    return existing;
  }
  return { ...incoming, usage: maxUsage(existing.usage, incoming.usage) };
}

// Usage only grows (a task's runs add to it), so a stale frame never lowers it.
function maxUsage(a: AsyncTask["usage"], b: AsyncTask["usage"]): AsyncTask["usage"] {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
  };
}

/** Upsert without stamping a frame time (hydration uses this for its rows). */
function writeTask(
  state: AsyncTaskTreeState,
  incoming: AsyncTask,
  event: AsyncTaskFrameEvent,
  now: number,
): AsyncTaskTreeState {
  const existing = state.tasks[incoming.taskId];
  const merged = mergeTask(existing, incoming, event, state.stopRequestedAt[incoming.taskId], now);
  if (merged === existing) return state;
  const tasks = { ...state.tasks, [incoming.taskId]: merged };
  const revived = existing && isTaskSettled(existing.status) && !isTaskSettled(merged.status);
  if (revived && incoming.taskId in state.stopRequestedAt) {
    // The stop is over: the task settled, and is now running again (the
    // orchestrator continued it). It is no longer "Stopping…".
    const stopRequestedAt = { ...state.stopRequestedAt };
    delete stopRequestedAt[incoming.taskId];
    return { ...state, tasks, stopRequestedAt };
  }
  return { ...state, tasks };
}

/**
 * One `TaskOut` from a frame of the conversation channel — or a cancel/resume
 * answer, which is the same object and must win over an older hydration the
 * same way.
 */
export function applyTaskFrame(
  state: AsyncTaskTreeState,
  task: AsyncTask,
  event: AsyncTaskFrameEvent,
  now: number,
): AsyncTaskTreeState {
  if (!task.taskId) return state;
  if (state.conversationId && task.conversationId && task.conversationId !== state.conversationId) {
    // A frame for another conversation (a channel switch in flight) is not ours.
    return state;
  }
  const clock = state.clock + 1;
  const written = writeTask(state, task, event, now);
  return {
    ...written,
    clock,
    touchedAt: { ...written.touchedAt, [task.taskId]: clock },
  };
}

/**
 * The answer of `GET …/tasks`, issued when the tree's clock read `issuedAt`.
 * A task a frame wrote after that is newer than the answer and is kept.
 */
export function hydrateTaskTree(
  state: AsyncTaskTreeState,
  tasks: AsyncTask[],
  issuedAt: number,
  now: number,
): AsyncTaskTreeState {
  let next = state;
  for (const task of tasks) {
    if (!task.taskId) continue;
    if (state.conversationId && task.conversationId && task.conversationId !== state.conversationId)
      continue;
    if ((state.touchedAt[task.taskId] ?? -1) > issuedAt) continue;
    // A hydrated row is a full state, not a start announcement.
    next = writeTask(next, task, "TASK_STATUS", now);
  }
  return next;
}

/** The user pressed Stop: show "Stopping…" until the task settles. */
export function requestTaskStop(
  state: AsyncTaskTreeState,
  taskId: string,
  now: number,
): AsyncTaskTreeState {
  const task = state.tasks[taskId];
  if (!task || isTaskSettled(task.status)) return state;
  return { ...state, stopRequestedAt: { ...state.stopRequestedAt, [taskId]: now } };
}

/** The cancel request failed: the task is not stopping after all. */
export function failTaskStop(state: AsyncTaskTreeState, taskId: string): AsyncTaskTreeState {
  if (!(taskId in state.stopRequestedAt)) return state;
  const stopRequestedAt = { ...state.stopRequestedAt };
  delete stopRequestedAt[taskId];
  return { ...state, stopRequestedAt };
}

/**
 * How a task's card reads right now: its own status, or `stopping` from the
 * Stop click until the task is settled.
 */
export function taskDisplayStatus(
  state: AsyncTaskTreeState,
  taskId: string,
): AsyncTaskDisplayStatus | null {
  const task = state.tasks[taskId];
  if (!task) return null;
  if (!isTaskSettled(task.status) && state.stopRequestedAt[taskId] !== undefined) {
    return "stopping";
  }
  return task.status;
}

/**
 * One frame of a task's own socket. A snapshot re-folds the node from the log
 * it carries; an event is folded on top (the same reducer as a run, which
 * also drops a replayed `seq`); the terminal frame closes the node's timeline.
 * A task embedded in a frame updates the tree like a status frame.
 */
export function applyTaskSocketFrame(
  state: AsyncTaskTreeState,
  taskId: string,
  frame: TaskSocketFrame,
  now: number,
): AsyncTaskTreeState {
  let next = state;
  const embedded = frame.type === "event" ? null : frame.task;
  if (embedded && embedded.taskId === taskId) {
    next = applyTaskFrame(next, embedded, "TASK_STATUS", now);
  }
  const node = next.nodes[taskId];

  if (frame.type === "snapshot") {
    // Without a log the snapshot only states the task; the events that follow
    // resume after `since`, so what the node already folded stays.
    if (frame.events === null) {
      if (node) return next;
      return {
        ...next,
        nodes: { ...next.nodes, [taskId]: { timeline: createTimeline(), lastSeq: null } },
      };
    }
    const task = next.tasks[taskId];
    const terminal = task ? taskTerminalStatus(task.status) : null;
    const timeline = foldTimeline(frame.events, { status: terminal });
    return {
      ...next,
      nodes: { ...next.nodes, [taskId]: { timeline, lastSeq: node?.lastSeq ?? null } },
    };
  }

  if (frame.type === "event") {
    if (frame.seq !== null && node?.lastSeq === frame.seq) return next;
    const previous = node?.timeline ?? createTimeline();
    const timeline = reduceTimelineEvents(previous, [frame.event]);
    return {
      ...next,
      nodes: {
        ...next.nodes,
        [taskId]: { timeline, lastSeq: frame.seq ?? node?.lastSeq ?? null },
      },
    };
  }

  // terminal
  const status = frame.status ?? next.tasks[taskId]?.status ?? null;
  if (status && !embedded && next.tasks[taskId] && isTaskSettled(status)) {
    // The frame names the end without a task: settle the row we hold.
    next = applyTaskFrame(
      next,
      { ...next.tasks[taskId], status, settledAt: next.tasks[taskId].settledAt ?? now },
      "TASK_SETTLED",
      now,
    );
  }
  const terminal = status ? taskTerminalStatus(status) : null;
  const previous = next.nodes[taskId]?.timeline ?? createTimeline();
  const timeline = terminal ? finalizeTimeline(previous, terminal) : previous;
  return {
    ...next,
    nodes: {
      ...next.nodes,
      [taskId]: { timeline, lastSeq: next.nodes[taskId]?.lastSeq ?? null },
    },
  };
}

/** Each task's children, in the order they started (ties: by id, for stability). */
export function taskChildrenIndex(state: AsyncTaskTreeState): Map<string, AsyncTask[]> {
  const children = new Map<string, AsyncTask[]>();
  for (const task of Object.values(state.tasks)) {
    if (!task.parentTaskId) continue;
    const list = children.get(task.parentTaskId) ?? [];
    list.push(task);
    children.set(task.parentTaskId, list);
  }
  for (const list of children.values()) list.sort(byStart);
  return children;
}

function byStart(a: AsyncTask, b: AsyncTask): number {
  const delta = (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER);
  return delta !== 0 ? delta : a.taskId.localeCompare(b.taskId);
}

/**
 * The tree's roots the AI message `messageId` started: the depth-1 tasks
 * whose `spawnedByMessageId` is that message. A nested task has its root's
 * message too, but it is drawn inside its parent, never as a root.
 */
export function rootTasksForMessage(state: AsyncTaskTreeState, messageId: string): AsyncTask[] {
  return Object.values(state.tasks)
    .filter((task) => !task.parentTaskId && task.spawnedByMessageId === messageId)
    .sort(byStart);
}

/** Whether any task of the tree is still working (busy like a streaming answer). */
export function hasWorkingTasks(state: AsyncTaskTreeState): boolean {
  return Object.values(state.tasks).some((task) => !isTaskSettled(task.status));
}

/** Tasks paused on an approval, oldest first: the approval cards to show. */
export function waitingTasks(state: AsyncTaskTreeState): AsyncTask[] {
  return Object.values(state.tasks)
    .filter((task) => task.status === "waiting")
    .sort(byStart);
}

/** The chain from a root down to `taskId` (inclusive), for the drill-down's path. */
export function taskAncestry(state: AsyncTaskTreeState, taskId: string): AsyncTask[] {
  const chain: AsyncTask[] = [];
  const seen = new Set<string>();
  let cursor: AsyncTask | undefined = state.tasks[taskId];
  while (cursor && !seen.has(cursor.taskId)) {
    seen.add(cursor.taskId);
    chain.unshift(cursor);
    cursor = cursor.parentTaskId ? state.tasks[cursor.parentTaskId] : undefined;
  }
  return chain;
}
