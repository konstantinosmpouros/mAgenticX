import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cancelInferenceRun, getActiveInferenceRuns, observeInferenceRun, startInferenceRun } from "@/lib/api";
import type {
  ConversationDetail,
  ConversationSummary,
  InferenceRun,
  InferenceRunEvent,
  InferenceRunStartRequest,
  InferenceRunStartResponse,
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
  const controllersRef = useRef<Record<string, AbortController>>({});
  const currentConversationIdRef = useRef<string | null | undefined>(currentConversationId);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  const applyRunEvent = useCallback((event: InferenceRunEvent) => {
    const { run, message, summary } = event;
    const active = isActiveRun(run);

    setRunsByConversation((prev) => {
      const next = { ...prev };
      if (active) {
        next[run.conversationId] = run;
      } else {
        delete next[run.conversationId];
      }
      return next;
    });

    if (summary) {
      setConversations((prev) =>
        prev.map((conversation) => (conversation.id === summary.id ? { ...conversation, ...summary } : conversation))
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
        ...(summary
          ? {
              title: summary.title ?? prev.title,
              updated_at: new Date(summary.updated_at),
              activeRunId: summary.activeRunId ?? null,
              isStreaming: Boolean(summary.isStreaming),
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
      const thoughts = message?.thinking ?? run.thinking ?? [];
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

  const observeRunId = useCallback((runId?: string | null) => {
    if (!userId || !runId || controllersRef.current[runId]) {
      return;
    }
    const controller = new AbortController();
    controllersRef.current[runId] = controller;
    void observeInferenceRun(userId, runId, applyRunEvent, controller.signal).catch((error) => {
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

  const observeRun = useCallback((run: InferenceRun) => {
    observeRunId(run.id);
  }, [observeRunId]);

  useEffect(() => {
    observeRunId(currentActiveRunId);
  }, [currentActiveRunId, observeRunId]);

  useEffect(() => {
    if (!userId) {
      setRunsByConversation({});
      Object.values(controllersRef.current).forEach((controller) => controller.abort());
      controllersRef.current = {};
      return;
    }

    let cancelled = false;
    void getActiveInferenceRuns(userId)
      .then((runs) => {
        if (cancelled) return;
        setConversations((prev) =>
          prev.map((conversation) => {
            const run = runs.find((item) => item.conversationId === conversation.id && isActiveRun(item));
            return run ? { ...conversation, activeRunId: run.id, isStreaming: true } : conversation;
          })
        );
        setRunsByConversation(() => {
          const next: Record<string, InferenceRun> = {};
          for (const run of runs) {
            if (isActiveRun(run)) {
              next[run.conversationId] = run;
              observeRun(run);
            }
          }
          return next;
        });
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
  }, [observeRun, userId]);

  const beginRun = useCallback(async (
    conversationId: string,
    request: InferenceRunStartRequest,
  ): Promise<InferenceRunStartResponse> => {
    if (!userId) {
      throw new Error("Not authenticated.");
    }
    const response = await startInferenceRun(userId, conversationId, request);
    applyRunEvent({
      type: "snapshot",
      run: response.run,
      message: response.message,
      summary: response.summary,
    });
    observeRun(response.run);
    return response;
  }, [applyRunEvent, observeRun, userId]);

  const stopRun = useCallback(async (runId?: string | null) => {
    if (!userId || !runId) return;
    const run = await cancelInferenceRun(userId, runId);
    applyRunEvent({ type: "update", run });
  }, [applyRunEvent, userId]);

  return {
    runsByConversation,
    beginRun,
    stopRun,
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
