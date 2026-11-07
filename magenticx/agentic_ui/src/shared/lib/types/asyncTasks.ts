// ------------------------------------------------------
// Async sub-agent tasks (plan 41) — the wire shapes of the bridge's task
// routes and sockets, and the client-side tree they fold into. A task is one
// sub-agent at any depth, running in the background on its own lifecycle: it
// outlives the run that started it, so it is held per conversation, not inside
// a run's timeline.
// ------------------------------------------------------
import type { AsyncTask, AsyncTaskFrameEvent, AsyncTaskStatus, QueuedMessage } from "../schemas";
import type { InferenceRun } from "./inference";
import type { RunTimeline } from "./timeline";

// The wire contracts are inferred from their Zod schemas (see `../schemas`), so
// the validator and the type cannot drift.
export type {
  AsyncTask,
  AsyncTaskFrameEvent,
  AsyncTaskStatus,
  QueuedMessage,
  TaskNotice,
  TaskSocketFrame,
} from "../schemas";

/**
 * One frame of the conversation channel (`/conversations/{user}/{id}/ws`), with
 * a `run_started` run already mapped to the app's run shape.
 */
export type ConversationChannelFrame =
  | { type: "task"; event: AsyncTaskFrameEvent; task: AsyncTask }
  | { type: "run_started"; run: InferenceRun; fromQueue: boolean }
  | { type: "queue"; queuedMessage: QueuedMessage | null };

/**
 * One node's live view, fed by its own socket while it is open (drill-down)
 * or waiting on an approval: its AG-UI events folded by the same reducer as a
 * top-level run, and the stream id a reconnect resumes from.
 */
export type AsyncTaskNodeView = {
  timeline: RunTimeline;
  /** The last stream entry applied; the socket's `since` on reconnect. */
  lastSeq: string | null;
};

/**
 * The conversation's task tree. Flat by id — the parent/child links are read
 * off `parentTaskId` when it is drawn — so frames can land in any order: a
 * child before its parent, a status before its start.
 */
export type AsyncTaskTreeState = {
  conversationId: string | null;
  tasks: Record<string, AsyncTask>;
  /**
   * Monotonic per-state counter, bumped by every frame. A task's entry in
   * `touchedAt` says when a frame last wrote it, so a hydration (`GET …/tasks`)
   * that was in flight meanwhile cannot overwrite a newer frame.
   */
  clock: number;
  touchedAt: Record<string, number>;
  /**
   * Stop requests: the epoch ms the user pressed Stop. Shown as "Stopping…"
   * until the task settles; kept a little longer after it settled cancelled,
   * so a status frame emitted before the cancel cannot revive it.
   */
  stopRequestedAt: Record<string, number>;
  nodes: Record<string, AsyncTaskNodeView>;
};

/**
 * How a task's card reads: its wire status, or `stopping` between the Stop
 * click and the cancel landing.
 */
export type AsyncTaskDisplayStatus = AsyncTaskStatus | "stopping";
