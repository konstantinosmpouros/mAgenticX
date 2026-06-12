import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  cancelInferenceRun,
  connectInferenceWebSocket,
  getActiveInferenceRuns,
  resumeInferenceRun,
  startInference,
  type ResumeInferenceRunBody,
} from "@/lib/api";
import { sortByUpdatedAtDesc } from "@/lib/utils";
import {
  createTimeline,
  foldTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "@/lib/timeline";
import type {
  ConversationDetail,
  ConversationSummary,
  InferenceRun,
  InferenceRunEvent,
  InferenceStartRequest,
  InferenceStartResponse,
  MessageOut,
  ThinkingState,
} from "@/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

type UseInferenceRunsOptions = {
  userId: string | null;
  currentConversationId?: string | null;
  currentActiveRunId?: string | null;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setThinkingState: (updater: any) => void;
  setShowAiTransition?: (value: boolean) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
};

const patchMessage = (messages: MessageOut[], message: MessageOut) => {
  const found = messages.some((item) => item.id === message.id);
  return found ? messages.map((item) => (item.id === message.id ? message : item)) : [...messages, message];
};

const isActiveRun = (run: InferenceRun | null | undefined) => Boolean(run && ACTIVE_STATUSES.has(String(run.status)));

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
const mergeRunEvent = (existing: InferenceRun | null | undefined, event: InferenceRunEvent): InferenceRun => {
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
      timeline: event.events?.length ? reduceTimelineEvents(previousTimeline, event.events) : previousTimeline,
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

  const applyRunEvent = useCallback((event: InferenceRunEvent) => {
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
        prev.map((conversation) => (conversation.id === resolvedSummary.id ? { ...conversation, ...resolvedSummary } : conversation))
      );
    } else {
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === run.conversationId
            ? { ...conversation, activeRunId: active ? run.id : null, isStreaming: active }
            : conversation
        )
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
      setShowAiTransition?.(false);
      const thoughts = message?.thinking ?? (run.timeline ? timelineThoughtStrings(run.timeline) : run.thinking ?? []);
      setThinkingState((prev: ThinkingState | null) => {
        if (!active && (!prev || prev.messageId !== run.assistantMessageId)) {
          return prev;
        }
        if (!active) {
          return prev
            ? { ...prev, thoughts, isActive: false, isDone: true, endTime: prev.endTime ?? Date.now() }
            : null;
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
      controllersRef.current[run.id]?.abort();
      delete controllersRef.current[run.id];
    }
  }, [setConversations, setCurrentConversation, setShowAiTransition, setThinkingState]);

  // Self-reference for the clean-resolve retry below — a useCallback cannot
  // list itself as a dependency.
  const observeRunIdRef = useRef<(runId?: string | null) => void>(() => {});

  const observeRunId = useCallback((runId?: string | null) => {
    if (!userId || !runId || controllersRef.current[runId]) {
      return;
    }
    const controller = new AbortController();
    controllersRef.current[runId] = controller;
    // connectInferenceWebSocket auto-reconnects with `since=<lastSeenSeq>` and
    // only rejects after a sustained failure (5 consecutive failed attempts)
    // or a permanent error (401/403/404). The toast below is therefore a true
    // "we gave up" signal, not a transient blip.
    void connectInferenceWebSocket(userId, runId, applyRunEvent, controller.signal)
      .then(() => {
        // Without this delete a cleanly-resolved run could never be
        // re-observed — the guard above would see the stale controller.
        delete controllersRef.current[runId];
        if (controller.signal.aborted) {
          return;
        }
        // Safety net: the socket closed on a terminal frame but the run is
        // still active in state — the terminal payload never landed. The
        // server answers a finished run with its DB snapshot (terminal
        // status), so one re-observe converges the state.
        const lingering = Object.values(runsRef.current).find((run) => run.id === runId);
        if (lingering && isActiveRun(lingering)) {
          window.setTimeout(() => observeRunIdRef.current(runId), 1000);
        }
      })
      .catch((error) => {
        delete controllersRef.current[runId];
        if ((error as any)?.name === "AbortError") {
          return;
        }
        console.error("Failed to observe inference run:", error);
        toast({
          title: "Stream observer lost",
          description: "The run is still owned by the server. Reopen the conversation to refresh its latest state.",
          variant: "destructive",
        });
      });
  }, [applyRunEvent, toast, userId]);

  useEffect(() => {
    observeRunIdRef.current = observeRunId;
  }, [observeRunId]);

  const observeRun = useCallback((run: InferenceRun) => {
    observeRunId(run.id);
  }, [observeRunId]);

  useEffect(() => {
    observeRunId(currentActiveRunId);
  }, [currentActiveRunId, observeRunId]);

  useEffect(() => {
    if (!userId) {
      runsRef.current = {};
      setRunsByConversation({});
      Object.values(controllersRef.current).forEach((controller) => controller.abort());
      controllersRef.current = {};
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
          })
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
    };
  }, [observeRun, setConversations, setCurrentConversation, userId]);

  const beginRun = useCallback(async (
    request: InferenceStartRequest,
  ): Promise<InferenceStartResponse> => {
    if (!userId) {
      throw new Error("Not authenticated.");
    }
    const response = await startInference(userId, request);
    setConversations((prev) => {
      const found = prev.some((conversation) => conversation.id === response.summary.id);
      const next = found
        ? prev.map((conversation) => (conversation.id === response.summary.id ? response.summary : conversation))
        : [response.summary, ...prev];
      return sortByUpdatedAtDesc(next);
    });
    setCurrentConversation((prev) => {
      if (!prev || prev.id === response.detail.id) {
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
  }, [applyRunEvent, observeRun, setConversations, setCurrentConversation, userId]);

  const stopRun = useCallback(async (runId?: string | null) => {
    if (!userId || !runId) return;
    const run = await cancelInferenceRun(userId, runId);
    applyRunEvent({ type: "update", run });
  }, [applyRunEvent, userId]);

  const resumeRun = useCallback(async (runId: string, body: ResumeInferenceRunBody) => {
    if (!userId) throw new Error("Not authenticated.");
    // Keyed by interruptId — every HITL in a conversation shares the same
    // thread_id, so threadId would mark every subsequent interrupt as already
    // resolved and the modal would never re-open for the next one.
    const key = `${runId}:${body.interruptId}`;
    // We deliberately do NOT optimistically flip resolved here — the modal
    // filters its cards by `isResolved`, so an optimistic flip would unmount
    // the card mid-click and steal the spinner feedback. Mark resolved only
    // after the bridge confirms the resume signal landed.
    const run = await resumeInferenceRun(userId, runId, body);
    applyRunEvent({ type: "update", run });
    setResolvedInterrupts((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [applyRunEvent, userId]);

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
      (conversationId?: string | null) => (conversationId ? runsByConversation[conversationId] ?? null : null),
      [runsByConversation],
    ),
    isConversationStreaming: useCallback(
      (conversationId?: string | null) => Boolean(conversationId && isActiveRun(runsByConversation[conversationId])),
      [runsByConversation],
    ),
  };
}
