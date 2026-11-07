/**
 * Async sub-agent tasks API (plan 41 §14.4): the conversation's task tree, the
 * Stop button, a waiting task's approval, the composer's queued message, and
 * the two subscription sockets — the conversation channel and one task's own
 * event stream.
 *
 * Paths carry the user id like every other bridge route. §14.4 writes the
 * REST paths without it (`/conversations/{id}/tasks`), but under
 * `/v1/conversations` that collides with the existing
 * `/{user_id}/{conversation_id}` routes (GET detail, DELETE conversation) —
 * the user-scoped form is the one that cannot be mis-routed.
 */
import type { AsyncTask, ConversationChannelFrame, TaskSocketFrame } from "../types";
import { requestJson, requestVoid } from "../http";
import {
  AsyncTaskListSchema,
  AsyncTaskSchema,
  TaskBusyConversationsSchema,
  toConversationChannelFrame,
  toTaskSocketFrame,
} from "../schemas";
import { transformInferenceRun } from "../consts";
import { toResumeWireBody, type ResumeInferenceRunBody } from "./inference";
import { CONVERSATIONS_BASE_PATH, TASKS_BASE_PATH } from "./paths";
import { bridgeSocketUrl, runReconnectingSocket } from "./reconnecting-socket";

const segment = encodeURIComponent;

/** The conversation's task tree (every depth, flat), from the bridge's mirror. */
export async function listConversationTasks(
  userId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<AsyncTask[]> {
  return requestJson(
    `${CONVERSATIONS_BASE_PATH}/${segment(userId)}/${segment(conversationId)}/tasks`,
    {
      schema: AsyncTaskListSchema,
      signal,
      fallbackMessage: "Failed to load the background tasks",
    },
  );
}

/**
 * The user's conversations whose background tasks are still working. The
 * sidebar polls it while a row spins for tasks, so rows of conversations that
 * are not open start and stop spinning on their own.
 */
export async function listTaskBusyConversations(userId: string, signal?: AbortSignal): Promise<string[]> {
  return requestJson(`${TASKS_BASE_PATH}/${segment(userId)}/active-conversations`, {
    schema: TaskBusyConversationsSchema,
    signal,
    fallbackMessage: "Failed to load the conversations with background tasks",
  });
}

/** Stop a task and its whole subtree; answers the task as it now stands. */
export async function cancelAsyncTask(userId: string, taskId: string): Promise<AsyncTask> {
  return requestJson(`${TASKS_BASE_PATH}/${segment(userId)}/${segment(taskId)}/cancel`, {
    method: "POST",
    csrf: true,
    schema: AsyncTaskSchema,
    fallbackMessage: "The task could not be stopped",
  });
}

/** The user's decision on a `waiting` task's approval — the body of a run resume. */
export async function resumeAsyncTask(
  userId: string,
  taskId: string,
  body: ResumeInferenceRunBody,
): Promise<AsyncTask> {
  return requestJson(`${TASKS_BASE_PATH}/${segment(userId)}/${segment(taskId)}/resume`, {
    method: "POST",
    csrf: true,
    body: toResumeWireBody(body),
    schema: AsyncTaskSchema,
    fallbackMessage: "Failed to send your decision",
  });
}

/** Cancel the conversation's queued composer message before it is sent. */
export async function deleteQueuedMessage(userId: string, conversationId: string): Promise<void> {
  await requestVoid(
    `${CONVERSATIONS_BASE_PATH}/${segment(userId)}/${segment(conversationId)}/queued-message`,
    {
      method: "DELETE",
      csrf: true,
      fallbackMessage: "The queued message could not be cancelled",
    },
  );
}

/**
 * Follow the conversation channel until `signal` aborts: task tree changes,
 * runs this client did not start, and the queue. `onOpen` fires on every
 * (re)connect — frames sent during a gap are not replayed, so the caller
 * re-reads the tree then.
 */
export function connectConversationChannel(
  userId: string,
  conversationId: string,
  onFrame: (frame: ConversationChannelFrame) => void,
  options: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  const url = bridgeSocketUrl(
    `${CONVERSATIONS_BASE_PATH}/${segment(userId)}/${segment(conversationId)}/ws`,
  );
  return runReconnectingSocket(
    url,
    {
      subscribe: () => ({ type: "subscribe" }),
      onOpen: options.onOpen,
      onFrame: (raw) => {
        const frame = toConversationChannelFrame(raw);
        if (!frame) return;
        if (frame.type === "run_started") {
          onFrame({
            type: "run_started",
            run: transformInferenceRun(frame.run),
            fromQueue: frame.fromQueue,
          });
          return;
        }
        onFrame(frame);
      },
    },
    options.signal,
  );
}

/**
 * Follow one task's live events (the drill-down) until its terminal frame or
 * `signal` aborts. `since` is read on every (re)connect, so a reconnect resumes
 * after the last event the caller applied.
 */
export function connectTaskSocket(
  userId: string,
  taskId: string,
  onFrame: (frame: TaskSocketFrame) => void,
  options: { signal?: AbortSignal; since?: () => string | null } = {},
): Promise<void> {
  const url = bridgeSocketUrl(`${TASKS_BASE_PATH}/${segment(userId)}/${segment(taskId)}/ws`);
  return runReconnectingSocket(
    url,
    {
      subscribe: () => ({ type: "subscribe", since: options.since?.() ?? null }),
      onFrame: (raw) => {
        const frame = toTaskSocketFrame(raw);
        if (!frame) return;
        onFrame(frame);
        return frame.type === "terminal" ? "done" : undefined;
      },
    },
    options.signal,
  );
}
