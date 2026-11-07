/**
 * The open conversation's background tasks (plan 41 §3.9) and its composer
 * queue (§3.6) — the live side of the async sub-agent tree.
 *
 * Owns three subscriptions and the state they feed:
 *   - the task tree: `GET …/tasks` on open and after every channel (re)connect,
 *     plus the conversation channel's `task` frames (folded by `taskTree.ts`);
 *   - the conversation channel's `run_started` frames — runs this client did
 *     not start (a wake-up reporting a result, the queued message going out, a
 *     scheduled run) — handed to `onRunStarted`, which attaches to them like a
 *     run the client started, and its `queue` frames (the queued chip);
 *   - one task socket per node that needs live events: the node open in the
 *     drill-down, and every task waiting on an approval (the approval card
 *     needs the interrupt the task's events carry).
 *
 * The run engine (`useInferenceRuns`) is untouched by tasks: a task's life is
 * not a run's, which is the whole point of the plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelAsyncTask,
  connectConversationChannel,
  connectTaskSocket,
  deleteQueuedMessage,
  listConversationTasks,
  resumeAsyncTask,
  type ResumeInferenceRunBody,
} from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type {
  AsyncTaskTreeState,
  ConversationChannelFrame,
  InferenceRun,
  QueuedMessage,
} from "@/shared/lib/types";
import {
  applyTaskFrame,
  applyTaskSocketFrame,
  createTaskTree,
  failTaskStop,
  hydrateTaskTree,
  isTaskSettled,
  requestTaskStop,
  STOP_GRACE_MS,
} from "./taskTree";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

type UseBackgroundTasksOptions = {
  userId: string | null;
  /**
   * The open conversation, or null for none (a new chat, a shared view). Only
   * a persisted conversation has tasks or a channel.
   */
  conversationId: string | null;
  /** A run this client did not start began in the conversation. */
  onRunStarted: (run: InferenceRun, meta: { fromQueue: boolean }) => void;
  toast: ToastFn;
};

export type BackgroundTasks = {
  tree: AsyncTaskTreeState;
  /** The task whose drill-down is open, at any depth. */
  openTaskId: string | null;
  openTask: (taskId: string | null) => void;
  /** Stop a task and its subtree: "Stopping…" at once, the frames confirm it. */
  stopTask: (taskId: string) => Promise<void>;
  /** The user's decision on a waiting task's approval. */
  resumeTask: (taskId: string, body: ResumeInferenceRunBody) => Promise<void>;
  /** The bridge accepted a decision for this interrupt; its marker may not have landed yet. */
  isDecisionSent: (interruptId: string) => boolean;
  queuedMessage: QueuedMessage | null;
  /** The send was queued (a 202): show the chip. */
  holdQueuedMessage: (message: QueuedMessage | null) => void;
  /** Cancel the queued message (the chip's ×); resolves to what was cancelled. */
  cancelQueuedMessage: () => Promise<QueuedMessage | null>;
};

// Re-read the tree after a reconnect at most this often: a flapping socket must
// not turn into a request storm.
const REHYDRATE_MIN_INTERVAL_MS = 2_000;

export function useBackgroundTasks({
  userId,
  conversationId,
  onRunStarted,
  toast,
}: UseBackgroundTasksOptions): BackgroundTasks {
  const [tree, setTree] = useState<AsyncTaskTreeState>(() => createTaskTree(conversationId));
  // Mirror of `tree`: socket callbacks fold onto the latest state synchronously
  // and must not race React's batched updates (the same reason as runsRef in
  // useInferenceRuns).
  const treeRef = useRef(tree);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);
  const queuedRef = useRef<QueuedMessage | null>(null);
  const [sentDecisions, setSentDecisions] = useState<ReadonlySet<string>>(() => new Set());
  const onRunStartedRef = useRef(onRunStarted);
  const lastHydrateRef = useRef(0);
  // Re-reads the open conversation's tree (set by the channel effect).
  const hydrateRef = useRef<((force: boolean) => void) | null>(null);

  useEffect(() => {
    onRunStartedRef.current = onRunStarted;
  }, [onRunStarted]);

  const update = useCallback((fold: (state: AsyncTaskTreeState) => AsyncTaskTreeState) => {
    const next = fold(treeRef.current);
    if (next === treeRef.current) return;
    treeRef.current = next;
    setTree(next);
  }, []);

  const setQueued = useCallback((message: QueuedMessage | null) => {
    queuedRef.current = message;
    setQueuedMessage(message);
  }, []);

  // ---- The tree and the conversation channel, per conversation ----
  useEffect(() => {
    const fresh = createTaskTree(conversationId);
    treeRef.current = fresh;
    setTree(fresh);
    setOpenTaskId(null);
    setQueued(null);
    setSentDecisions(new Set());
    lastHydrateRef.current = 0;
    if (!userId || !conversationId) return undefined;

    const controller = new AbortController();
    const hydrate = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastHydrateRef.current < REHYDRATE_MIN_INTERVAL_MS) return;
      lastHydrateRef.current = now;
      const issuedAt = treeRef.current.clock;
      listConversationTasks(userId, conversationId, controller.signal)
        .then((tasks) => {
          if (controller.signal.aborted) return;
          update((state) => hydrateTaskTree(state, tasks, issuedAt, Date.now()));
        })
        .catch((error: unknown) => {
          // Not fatal: the channel's frames still build the tree, and the next
          // reconnect re-reads it. No toast — nothing the user can act on.
          if (import.meta.env.DEV && (error as { name?: string })?.name !== "AbortError") {
            console.warn("Failed to load the conversation's background tasks:", error);
          }
        });
    };

    const onFrame = (frame: ConversationChannelFrame) => {
      if (frame.type === "task") {
        update((state) => applyTaskFrame(state, frame.task, frame.event, Date.now()));
        return;
      }
      if (frame.type === "queue") {
        setQueued(frame.queuedMessage);
        return;
      }
      // run_started: a run of the queued message clears the chip (the `queue`
      // frame says so too; whichever lands first wins).
      const fromQueue = frame.fromQueue;
      if (fromQueue) setQueued(null);
      onRunStartedRef.current(frame.run, { fromQueue });
    };

    hydrateRef.current = hydrate;
    hydrate(true);
    void connectConversationChannel(userId, conversationId, onFrame, {
      signal: controller.signal,
      // Frames sent while the socket was down are not replayed: re-read the
      // tree on every reconnect (the first open is covered by the read above).
      onOpen: () => hydrate(false),
    }).catch((error: unknown) => {
      // A refused channel (4403/4404 — e.g. a bridge without plan 41 yet) or an
      // ended session: the tree stays as hydrated, the chat works without it.
      if (import.meta.env.DEV && (error as { name?: string })?.name !== "AbortError") {
        console.warn("Conversation channel closed:", error);
      }
    });

    return () => {
      hydrateRef.current = null;
      controller.abort();
    };
  }, [conversationId, setQueued, update, userId]);

  // ---- One socket per node that needs live events ----
  // The open drill-down, and every task waiting on an approval. Keyed by the
  // sorted id list so a status frame that does not change the set does not
  // tear the sockets down.
  // Each id carries whether its task is settled: a node's socket ends at the
  // settle, so a task the orchestrator continues changes the key and its
  // drill-down reconnects and streams again, without a reload.
  const watchedKey = useMemo(() => {
    const ids = new Set<string>();
    if (openTaskId && tree.tasks[openTaskId]) ids.add(openTaskId);
    for (const task of Object.values(tree.tasks)) {
      if (task.status === "waiting") ids.add(task.taskId);
    }
    return [...ids]
      .sort()
      .map((id) => `${id}:${isTaskSettled(tree.tasks[id].status) ? "settled" : "live"}`)
      .join("|");
  }, [openTaskId, tree.tasks]);

  const nodeControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Each watched node's state ("settled" / "live") when its socket was opened.
  const nodeStatesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const controllers = nodeControllersRef.current;
    const states = new Map(
      (watchedKey ? watchedKey.split("|") : []).map((entry) => {
        const cut = entry.lastIndexOf(":");
        return [entry.slice(0, cut), entry.slice(cut + 1)] as const;
      }),
    );
    const watched = new Set(states.keys());
    for (const [taskId, controller] of controllers) {
      const reopened = nodeStatesRef.current.get(taskId) === "settled" && states.get(taskId) === "live";
      if (!watched.has(taskId) || reopened) {
        // Gone from view, or running again: a socket opened on the settled
        // task has nothing more to say — open a fresh one below.
        controller.abort();
        controllers.delete(taskId);
      }
    }
    nodeStatesRef.current = states;
    if (!userId) return;
    for (const taskId of watched) {
      if (controllers.has(taskId)) continue;
      const controller = new AbortController();
      controllers.set(taskId, controller);
      void connectTaskSocket(
        userId,
        taskId,
        (frame) => update((state) => applyTaskSocketFrame(state, taskId, frame, Date.now())),
        {
          signal: controller.signal,
          since: () => treeRef.current.nodes[taskId]?.lastSeq ?? null,
        },
      )
        .catch(() => {
          // Refused for good (pruned, or not this user's): the card keeps what
          // the tree knows; nothing to retry.
        })
        .finally(() => {
          if (controllers.get(taskId) === controller) controllers.delete(taskId);
        });
    }
  }, [update, userId, watchedKey]);

  // Close every node socket when the conversation (or the user) changes.
  useEffect(() => {
    const controllers = nodeControllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, [conversationId, userId]);

  // ---- Actions ----
  const stopTask = useCallback(
    async (taskId: string) => {
      if (!userId) return;
      const task = treeRef.current.tasks[taskId];
      if (!task || isTaskSettled(task.status)) return;
      update((state) => requestTaskStop(state, taskId, Date.now()));
      try {
        const answer = await cancelAsyncTask(userId, taskId);
        update((state) => applyTaskFrame(state, answer, "TASK_STATUS", Date.now()));
        // For the grace window a frame that would revive the stopped task is
        // taken as stale. If the orchestrator really continued it meanwhile,
        // re-reading the tree once the window closes shows it running again.
        window.setTimeout(() => hydrateRef.current?.(true), STOP_GRACE_MS + 500);
      } catch (error) {
        update((state) => failTaskStop(state, taskId));
        toastError(toast, "Could not stop the task", error);
      }
    },
    [toast, update, userId],
  );

  const resumeTask = useCallback(
    async (taskId: string, body: ResumeInferenceRunBody) => {
      if (!userId) throw new Error("Not authenticated.");
      try {
        const answer = await resumeAsyncTask(userId, taskId, body);
        update((state) => applyTaskFrame(state, answer, "TASK_STATUS", Date.now()));
        setSentDecisions((prev) => new Set(prev).add(body.interruptId));
      } catch (error) {
        toastError(toast, "Could not send your decision", error);
        throw error;
      }
    },
    [toast, update, userId],
  );

  const isDecisionSent = useCallback(
    (interruptId: string) => sentDecisions.has(interruptId),
    [sentDecisions],
  );

  const holdQueuedMessage = useCallback(
    (message: QueuedMessage | null) => setQueued(message),
    [setQueued],
  );

  const cancelQueuedMessage = useCallback(async () => {
    const held = queuedRef.current;
    if (!userId || !conversationId || !held) return null;
    // Optimistic: the chip goes at once; it comes back if the bridge refuses.
    setQueued(null);
    try {
      await deleteQueuedMessage(userId, conversationId);
      return held;
    } catch (error) {
      // 404: it already went out (or was cancelled elsewhere) — nothing to undo.
      if ((error as { status?: number })?.status === 404) return null;
      setQueued(held);
      toastError(toast, "Could not cancel the queued message", error);
      return null;
    }
  }, [conversationId, setQueued, toast, userId]);

  return {
    tree,
    openTaskId,
    openTask: setOpenTaskId,
    stopTask,
    resumeTask,
    isDecisionSent,
    queuedMessage,
    holdQueuedMessage,
    cancelQueuedMessage,
  };
}
