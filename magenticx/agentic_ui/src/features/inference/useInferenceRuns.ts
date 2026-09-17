import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  cancelInferenceRun,
  connectInferenceWebSocket,
  getActiveInferenceRuns,
  resumeInferenceRun,
  startInference,
  type ResumeInferenceRunBody,
} from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import { sortByUpdatedAtDesc } from "@/shared/lib/utils";
import {
  createTimeline,
  foldTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "./timeline";
import type {
  ConversationDetail,
  ConversationSummary,
  InferenceRun,
  InferenceRunEvent,
  InferenceStartRequest,
  InferenceStartResponse,
  MessageOut,
  ThinkingState,
} from "@/shared/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

type UseInferenceRunsOptions = {
  userId: string | null;
  currentConversationId?: string | null;
  currentActiveRunId?: string | null;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setThinkingState: (updater: any) => void;
  setShowAiTransition?: (value: boolean) => void;
  toast: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
};

const patchMessage = (messages: MessageOut[], message: MessageOut) => {
  const found = messages.some((item) => item.id === message.id);
  return found
    ? messages.map((item) => (item.id === message.id ? message : item))
    : [...messages, message];
};

const isActiveRun = (run: InferenceRun | null | undefined) =>
  Boolean(run && ACTIVE_STATUSES.has(String(run.status)));

/**
 * Has the agent actually started doing something on this run — a timeline block
 * (thinking/tool/content), a thought, or a pending HITL interrupt?
 *
 * A live run with none of these is still in its transition phase: the UI shows
 * the pulsing bridge dot under the user's message and no thinking block yet.
 * Shared by the event fold and the optimistic paint below so the two can never
 * disagree about what counts as "started".
 */
const runHasAgentSignal = (run: InferenceRun, thoughts: string[]) =>
  thoughts.length > 0 || (run.timeline?.blocks.length ?? 0) > 0 || (run.pendingInterrupts ?? 0) > 0;

/** The thoughts a run currently carries, preferring its folded timeline. */
const runThoughts = (run: InferenceRun): string[] =>
  run.timeline ? timelineThoughtStrings(run.timeline) : (run.thinking ?? []);

const foldRunSnapshot = (run: InferenceRun): InferenceRun => ({
  ...run,
  timeline: foldTimeline(run.rawEvents, {
    status: String(run.status),
    legacyMessage: { content: run.content, thinking: run.thinking },
  }),
});

// One run state per conversation, folded incrementally. "events" frames carry
// only the new AG-UI events + run meta; "snapshot"/"terminal" frames carry the
// full state (rawEvents = the coalesced log) and are re-folded from scratch.
// "update" is the client-local merge of cancel/resume REST responses — meta
// only, so the in-progress timeline is preserved.
const mergeRunEvent = (
  existing: InferenceRun | null | undefined,
  event: InferenceRunEvent,
): InferenceRun => {
  const incoming = event.run;
  const base = existing && existing.id === incoming.id ? existing : null;

  if (event.type === "events") {
    const fallback = base ?? { ...incoming, timeline: createTimeline() };
    const previousTimeline = fallback.timeline ?? createTimeline();
    return {
      ...fallback,
      status: incoming.status ?? fallback.status,
      pendingInterrupts: incoming.pendingInterrupts ?? fallback.pendingInterrupts,
      errorMessage: incoming.errorMessage ?? fallback.errorMessage ?? null,
      completedAt: incoming.completedAt ?? fallback.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? fallback.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
      timeline: event.events?.length
        ? reduceTimelineEvents(previousTimeline, event.events)
        : previousTimeline,
    };
  }

  if (event.type === "update" && base) {
    return {
      ...base,
      status: incoming.status ?? base.status,
      errorMessage: incoming.errorMessage ?? base.errorMessage ?? null,
      completedAt: incoming.completedAt ?? base.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? base.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
    };
  }

  return foldRunSnapshot(incoming);
};

export function useInferenceRuns({
  userId,
  currentConversationId,
  currentActiveRunId,
  setConversations,
  setCurrentConversation,
  setThinkingState,
  setShowAiTransition,
  toast,
}: UseInferenceRunsOptions) {
  const [runsByConversation, setRunsByConversation] = useState<Record<string, InferenceRun>>({});
  // Per-(run,thread) marker that a HITL interrupt has been resolved client-side
  // so the Confirmation card flips to its resolved state instantly. Cleared
  // automatically on rollback if the resume HTTP call fails.
  const [resolvedInterrupts, setResolvedInterrupts] = useState<Set<string>>(new Set());
  const controllersRef = useRef<Record<string, AbortController>>({});
  // Mirror of runsByConversation so incremental "events" frames fold onto the
  // latest run state synchronously — WS callbacks arrive in order and must
  // not race React's async state updates.
  const runsRef = useRef<Record<string, InferenceRun>>({});
  const currentConversationIdRef = useRef<string | null | undefined>(currentConversationId);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  const applyRunEvent = useCallback(
    (event: InferenceRunEvent) => {
      const { message, summary } = event;
      const run = mergeRunEvent(runsRef.current[event.run.conversationId], event);
      const active = isActiveRun(run);
      const resolvedSummary = summary
        ? {
            ...summary,
            activeRunId: active ? (summary.activeRunId ?? run.id) : null,
            isStreaming: active,
          }
        : null;

      {
        const next = { ...runsRef.current };
        if (active) {
          next[run.conversationId] = run;
        } else {
          delete next[run.conversationId];
        }
        runsRef.current = next;
        setRunsByConversation(next);
      }

      if (resolvedSummary) {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === resolvedSummary.id
              ? { ...conversation, ...resolvedSummary }
              : conversation,
          ),
        );
      } else {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === run.conversationId
              ? { ...conversation, activeRunId: active ? run.id : null, isStreaming: active }
              : conversation,
          ),
        );
      }

      setCurrentConversation((prev) => {
        if (!prev || prev.id !== run.conversationId) {
          return prev;
        }
        const nextMessages = message ? patchMessage(prev.messages ?? [], message) : prev.messages;
        return {
          ...prev,
          ...(resolvedSummary
            ? {
                title: resolvedSummary.title ?? prev.title,
                updated_at: new Date(resolvedSummary.updated_at),
                activeRunId: resolvedSummary.activeRunId ?? null,
                isStreaming: Boolean(resolvedSummary.isStreaming),
              }
            : {
                activeRunId: active ? run.id : null,
                isStreaming: active,
              }),
          messages: nextMessages,
        };
      });

      if (run.conversationId === currentConversationIdRef.current) {
        const thoughts =
          message?.thinking ??
          (run.timeline ? timelineThoughtStrings(run.timeline) : (run.thinking ?? []));
        // "First real signal" = the agent has actually started doing something:
        // a timeline block (thinking/tool/content), a thought, a pending HITL
        // interrupt, or the run reaching a terminal state. The /start snapshot
        // alone is NOT a signal — until one arrives the transition dot keeps
        // pulsing under the user's message and no thinking UI is shown.
        const hasAgentSignal = !active || runHasAgentSignal(run, thoughts);
        // Symmetric on purpose. This used to only ever turn the dot OFF, which
        // left `showAiTransition` owned solely by the local send/edit/retry
        // paths — so a run this client did not START had no way to switch it on.
        // Rejoining a run in its pre-signal phase (hard refresh, re-login, a
        // second tab, or just navigating back) therefore rendered nothing at all
        // under the user's message until the agent's first event arrived.
        setShowAiTransition?.(!hasAgentSignal);
        setThinkingState((prev: ThinkingState | null) => {
          if (!active && (!prev || prev.messageId !== run.assistantMessageId)) {
            return prev;
          }
          if (!active) {
            return prev
              ? {
                  ...prev,
                  thoughts,
                  isActive: false,
                  isDone: true,
                  endTime: prev.endTime ?? Date.now(),
                }
              : null;
          }
          if (!hasAgentSignal) {
            // Still in the transition phase. A lingering done-state from a
            // PREVIOUS run must be dropped here: retry/edit switch the view to a
            // new sibling branch, and the old state's branchPath would fail the
            // transition dot's branch-visibility check and hide it. Null state
            // (no branchPath) always passes, so the dot shows on the new branch.
            return prev && prev.messageId === run.assistantMessageId ? prev : null;
          }
          return {
            messageId: run.assistantMessageId,
            thoughts,
            currentThoughtIndex: Math.max(0, thoughts.length - 1),
            isActive: true,
            isDone: false,
            startTime: run.startedAt.getTime(),
            branchPath: [...run.messagePath],
          };
        });
      }

      if (!active) {
        // Terminal run — the one non-abort stop condition. Drop the observer and
        // any pending re-observe so nothing reattaches to a finished run.
        controllersRef.current[run.id]?.abort();
        delete controllersRef.current[run.id];
        window.clearTimeout(reobserveTimersRef.current[run.id]);
        delete reobserveTimersRef.current[run.id];
        delete reobserveAttemptsRef.current[run.id];
      }
    },
    [setConversations, setCurrentConversation, setShowAiTransition, setThinkingState],
  );

  // Self-reference for the clean-resolve retry below — a useCallback cannot
  // list itself as a dependency.
  const observeRunIdRef = useRef<(runId?: string | null) => void>(() => {});

  // Re-observe attempts per run, so a run that keeps failing backs off instead
  // of hot-looping. Cleared whenever a socket connects or the run goes terminal.
  const reobserveAttemptsRef = useRef<Record<string, number>>({});
  const reobserveTimersRef = useRef<Record<string, number>>({});

  const observeRunId = useCallback(
    (runId?: string | null) => {
      if (!userId || !runId || controllersRef.current[runId]) {
        return;
      }
      const controller = new AbortController();
      controllersRef.current[runId] = controller;

      /**
       * Re-attach unless the run is genuinely over.
       *
       * The invariant: while a conversation is open and its run is active, the
       * client keeps trying to follow it, full stop. It stops for exactly four
       * reasons — the run reached a terminal state, the user stopped it, the
       * user navigated away, or the conversation changed. The last three all
       * arrive as an abort on the controller.
       *
       * Anything else (socket drop, proxy hiccup, sleeping laptop, a server
       * error) is transient by definition, because the run is server-owned and
       * durable: it is still executing whether or not we are listening. Giving
       * up used to leave the UI showing a stale approval prompt for a run that
       * had long since moved on, and the only recovery was a manual refresh.
       */
      const scheduleReobserve = (reason: "closed" | "error") => {
        if (controller.signal.aborted) return;
        const current = Object.values(runsRef.current).find((run) => run.id === runId);
        if (!current || !isActiveRun(current)) {
          delete reobserveAttemptsRef.current[runId];
          return;
        }
        const attempt = (reobserveAttemptsRef.current[runId] ?? 0) + 1;
        reobserveAttemptsRef.current[runId] = attempt;
        // Cap the delay rather than the attempt count — never stop retrying.
        const delay = reason === "closed" ? 1000 : Math.min(1000 * 2 ** (attempt - 1), 30_000);
        window.clearTimeout(reobserveTimersRef.current[runId]);
        reobserveTimersRef.current[runId] = window.setTimeout(() => {
          delete reobserveTimersRef.current[runId];
          observeRunIdRef.current(runId);
        }, delay);
      };

      void connectInferenceWebSocket(userId, runId, applyRunEvent, controller.signal)
        .then(() => {
          // Without this delete a cleanly-resolved run could never be
          // re-observed — the guard above would see the stale controller.
          delete controllersRef.current[runId];
          if (controller.signal.aborted) return;
          // The socket closed but the run is still active in state — the
          // terminal payload never landed. The server answers a finished run
          // with its DB snapshot, so re-observing converges either way.
          scheduleReobserve("closed");
        })
        .catch((error: unknown) => {
          delete controllersRef.current[runId];
          if ((error as { name?: string })?.name === "AbortError") {
            delete reobserveAttemptsRef.current[runId];
            return;
          }
          // Deliberately no toast here: this is now a retry, not a failure, and
          // the run continues regardless. A permanently-dead session still
          // surfaces via emitUnauthorized() inside the socket client.
          scheduleReobserve("error");
        });
    },
    [applyRunEvent, userId],
  );

  useEffect(() => {
    observeRunIdRef.current = observeRunId;
  }, [observeRunId]);

  const observeRun = useCallback(
    (run: InferenceRun) => {
      observeRunId(run.id);
    },
    [observeRunId],
  );

  useEffect(() => {
    if (currentActiveRunId) {
      // Paint the transition dot from the conversation detail, which reports
      // `activeRunId` well before `getActiveInferenceRuns` and the WebSocket
      // handshake resolve. Waiting for the socket's snapshot frame is what left
      // a refresh showing empty space under the user's message for a beat.
      //
      // Only when we hold no evidence to the contrary: if a folded run for this
      // conversation is already in hand and has emitted something, this is a
      // reconnect mid-answer, not a fresh pre-signal run. Either way the snapshot
      // lands moments later and `applyRunEvent` reconciles.
      const conversationId = currentConversationIdRef.current;
      const known = conversationId ? runsRef.current[conversationId] : undefined;
      if (!known || !runHasAgentSignal(known, runThoughts(known))) {
        setShowAiTransition?.(true);
      }
    }
    observeRunId(currentActiveRunId);
  }, [currentActiveRunId, observeRunId, setShowAiTransition]);

  useEffect(() => {
    if (!userId) {
      runsRef.current = {};
      setRunsByConversation({});
      Object.values(controllersRef.current).forEach((controller) => controller.abort());
      controllersRef.current = {};
      Object.values(reobserveTimersRef.current).forEach((id) => window.clearTimeout(id));
      reobserveTimersRef.current = {};
      reobserveAttemptsRef.current = {};
      return;
    }

    let cancelled = false;
    void getActiveInferenceRuns(userId)
      .then((runs) => {
        if (cancelled) return;
        const activeRunsByConversation = new Map(
          runs.filter(isActiveRun).map((run) => [run.conversationId, run]),
        );
        setConversations((prev) =>
          prev.map((conversation) => {
            const run = activeRunsByConversation.get(conversation.id);
            return run
              ? { ...conversation, activeRunId: run.id, isStreaming: true }
              : { ...conversation, activeRunId: null, isStreaming: false };
          }),
        );
        setCurrentConversation((prev) => {
          if (!prev) return prev;
          const run = activeRunsByConversation.get(prev.id);
          return run
            ? { ...prev, activeRunId: run.id, isStreaming: true }
            : { ...prev, activeRunId: null, isStreaming: false };
        });
        {
          const next: Record<string, InferenceRun> = {};
          for (const run of runs) {
            if (isActiveRun(run)) {
              // REST placeholders carry no event log mid-run; the WS snapshot
              // frame that follows the subscribe re-folds the full timeline.
              next[run.conversationId] = foldRunSnapshot(run);
              observeRun(run);
            }
          }
          runsRef.current = next;
          setRunsByConversation(next);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to hydrate active inference runs:", error);
      });

    return () => {
      cancelled = true;
      Object.values(controllersRef.current).forEach((controller) => controller.abort());
      controllersRef.current = {};
      Object.values(reobserveTimersRef.current).forEach((id) => window.clearTimeout(id));
      reobserveTimersRef.current = {};
      reobserveAttemptsRef.current = {};
    };
  }, [observeRun, setConversations, setCurrentConversation, userId]);

  /**
   * Reattach the moment the browser can talk again.
   *
   * A backgrounded tab is throttled and a sleeping machine runs no timers at
   * all, so the backoff above can be mid-wait — or the socket can have died
   * without us noticing — exactly when the user returns and expects the live
   * view. Waking on `visibilitychange` and `online` closes that window: any
   * active run without a live observer is re-attached immediately, and
   * `observeRunId` no-ops for runs that already have one.
   */
  useEffect(() => {
    if (!userId) return;
    const reattach = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const run of Object.values(runsRef.current)) {
        if (isActiveRun(run) && !controllersRef.current[run.id]) {
          window.clearTimeout(reobserveTimersRef.current[run.id]);
          delete reobserveTimersRef.current[run.id];
          reobserveAttemptsRef.current[run.id] = 0;
          observeRunIdRef.current(run.id);
        }
      }
    };
    document.addEventListener("visibilitychange", reattach);
    window.addEventListener("online", reattach);
    window.addEventListener("focus", reattach);
    return () => {
      document.removeEventListener("visibilitychange", reattach);
      window.removeEventListener("online", reattach);
      window.removeEventListener("focus", reattach);
    };
  }, [userId]);

  const beginRun = useCallback(
    async (request: InferenceStartRequest): Promise<InferenceStartResponse> => {
      if (!userId) {
        throw new Error("Not authenticated.");
      }
      const response = await startInference(userId, request);
      setConversations((prev) => {
        // A private conversation must never enter the sidebar list. Every bridge
        // listing endpoint filters `is_private`, so a row inserted here is a
        // phantom: it appears the moment the first message is sent and vanishes
        // on the next refresh. Filter rather than skip, so a conversation that is
        // switched to private while listed is removed too.
        if (response.summary.isPrivate) {
          return prev.filter((conversation) => conversation.id !== response.summary.id);
        }
        const found = prev.some((conversation) => conversation.id === response.summary.id);
        const next = found
          ? prev.map((conversation) =>
              conversation.id === response.summary.id ? response.summary : conversation,
            )
          : [response.summary, ...prev];
        return sortByUpdatedAtDesc(next);
      });
      setCurrentConversation((prev) => {
        // Empty id = the optimistic conversation shell created by the send flow
        // for a brand-new chat — always replace it with the real server detail.
        if (!prev || !prev.id || prev.id === response.detail.id) {
          return response.detail;
        }
        return prev;
      });
      applyRunEvent({
        type: "snapshot",
        run: response.run,
        message: response.message,
        summary: response.summary,
      });
      observeRun(response.run);
      return response;
    },
    [applyRunEvent, observeRun, setConversations, setCurrentConversation, userId],
  );

  const stopRun = useCallback(
    async (runId?: string | null) => {
      if (!userId || !runId) return;
      const run = await cancelInferenceRun(userId, runId);
      applyRunEvent({ type: "update", run });
    },
    [applyRunEvent, userId],
  );

  const resumeRun = useCallback(
    async (runId: string, body: ResumeInferenceRunBody) => {
      if (!userId) throw new Error("Not authenticated.");
      // Keyed by interruptId — every HITL in a conversation shares the same
      // thread_id, so threadId would mark every subsequent interrupt as already
      // resolved and the modal would never re-open for the next one.
      const key = `${runId}:${body.interruptId}`;
      // We deliberately do NOT optimistically flip resolved here — the modal
      // filters its cards by `isResolved`, so an optimistic flip would unmount
      // the card mid-click and steal the spinner feedback. Mark resolved only
      // after the bridge confirms the resume signal landed.
      let run;
      try {
        run = await resumeInferenceRun(userId, runId, body);
      } catch (error) {
        // Surface as a toast, not only as the takeover's inline error: a failed
        // resume usually means the run already moved on (409 — the interrupt
        // the user was looking at is stale), which drives the run terminal and
        // unmounts the takeover, taking its inline message with it. Without
        // this the run just stopped showing "Failed" and said nothing.
        toastError(toast, "Could not send your decision", error, {
          description:
            "The run may have already moved past this approval. Reload the conversation to see its current state.",
        });
        throw error;
      }
      applyRunEvent({ type: "update", run });
      setResolvedInterrupts((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [applyRunEvent, toast, userId],
  );

  const isInterruptResolved = useCallback(
    (runId: string, interruptId: string) => resolvedInterrupts.has(`${runId}:${interruptId}`),
    [resolvedInterrupts],
  );

  // Derive the branch-selections map that places the active run's
  // assistantMessageId on the visible path. Branches are picked by index of
  // sibling under each parent, so we walk run.messagePath and record the
  // chosen index at every fork. Returns null when there's no active run, or
  // when the messagePath can't be reconciled with the messages list (e.g.
  // out-of-sync state — the existing branchSelections are left untouched).
  // ``__root__`` matches the rootKey used by useBranchingHandlers.
  const deriveBranchSelectionsForActiveRun = useCallback(
    (detail: ConversationDetail | null): Record<string, number> | null => {
      if (!detail) return null;
      const liveRun = runsByConversation[detail.id];
      if (!liveRun || !isActiveRun(liveRun)) return null;
      const messagePath = liveRun.messagePath ?? [];
      if (!messagePath.length) return null;
      const messages = detail.messages ?? [];
      if (!messages.length) return null;
      const byParent = new Map<string | null, MessageOut[]>();
      for (const message of messages) {
        const key = message.parentMessageId ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push(message);
      }
      const result: Record<string, number> = {};
      let parentId: string | null = null;
      for (const stepId of messagePath) {
        const siblings = byParent.get(parentId) ?? [];
        const index = siblings.findIndex((message) => message.id === stepId);
        if (index < 0) return null;
        result[parentId ?? "__root__"] = index;
        parentId = stepId;
      }
      return result;
    },
    [runsByConversation],
  );

  return {
    runsByConversation,
    beginRun,
    stopRun,
    resumeRun,
    isInterruptResolved,
    deriveBranchSelectionsForActiveRun,
    getRunForConversation: useCallback(
      (conversationId?: string | null) =>
        conversationId ? (runsByConversation[conversationId] ?? null) : null,
      [runsByConversation],
    ),
    isConversationStreaming: useCallback(
      (conversationId?: string | null) =>
        Boolean(conversationId && isActiveRun(runsByConversation[conversationId])),
      [runsByConversation],
    ),
  };
}
