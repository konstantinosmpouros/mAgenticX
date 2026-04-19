import { addMessageToConversation, streamInference, updateMessageInConversation } from '@/lib/api';
import {
  CustomEventSchema,
  EventSchemas,
  EventType as AGUIEventType,
  BeforeAgentCustomEventSchema,
  HITLInterruptCustomEventSchema,
  PlanSnapshotCustomEventSchema,
  RunErrorEventSchema,
  RunStartedEventSchema,
  SubAgentCustomEventSchema,
  TaskSubAgentCustomEventSchema,
  TextMessageChunkEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ThinkingEndEventSchema,
  ThinkingStartEventSchema,
  ThinkingTextMessageContentEventSchema,
  ToolCallArgsEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from '@/lib/agui';
import type { PlanSnapshot } from '@/lib/agui';
import { sortByUpdatedAtDesc } from '@/lib/utils';
import type { MessageIn, MessageOut, ToolPreference } from '@/lib/types';

// `streamAguiRun` is the bridge between low-level AG-UI stream events and the chat UI model.
// It keeps a transient in-memory runtime while the stream is live, mirrors partial state into React,
// then persists the final assistant message back into the conversation store.
const parseEvent = (raw: unknown) => {
  // Parse any incoming frame against the full AG-UI union before we branch on its exact type.
  const result = EventSchemas.safeParse(raw);
  return result.success ? result.data : null;
};


type MessageSetter = (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
type ConversationSetter = (updater: (prev: any[]) => any[]) => void;
type ThinkingSetter = (updater: any) => void;
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
type StreamSubagentState = {
  // HITL interrupts emitted by nested/sub-agent flows.
  interrupts?: unknown[];
  // Task assignment envelopes for spawned sub-agents.
  tasks?: unknown[];
  // Wrapped AG-UI events coming from sub-agent namespaces.
  events?: unknown[];
  // Delegation prompts captured before a sub-agent starts.
  beforeAgent?: unknown[];
};


export type AguiStreamOptions = {
  // Auth and conversation identity needed for persistence and stream bootstrap.
  userId: string;
  conversationId: string;
  replyParentMessageId: string;
  // UI branch path controls where optimistic thinking/message updates should appear.
  uiBranchPath: string[];
  // Server branch path can differ when we want the backend to stream against a different lineage.
  serverBranchPath?: string[];
  setMessages: MessageSetter;
  setThinkingState: ThinkingSetter;
  setCurrentConversation: (updater: any) => void;
  setConversations: ConversationSetter;
  toast: ToastFn;
  setShowAiTransition?: (v: boolean) => void;
  signal?: AbortSignal;
  prefillMessageId?: string;
  enabledTools?: ToolPreference[];
  persistUIState?: () => void;
  onPlanSnapshot?: (plan: PlanSnapshot) => void;
};


export async function streamAguiRun(options: AguiStreamOptions): Promise<void> {
  const {
    userId,
    conversationId,
    setMessages,
    setThinkingState,
    setCurrentConversation,
    setConversations,
    toast,
    setShowAiTransition,
    signal,
    replyParentMessageId,
    uiBranchPath,
  serverBranchPath,
  prefillMessageId,
  enabledTools,
  persistUIState,
  onPlanSnapshot,
  } = options;
  
  // Abort is handled out-of-band because the SSE stream can end while async persistence is still pending.
  let aborted = false;
  options.signal?.addEventListener('abort', () => {
    aborted = true;
  }, { once: true });

  // Runtime accumulators keep the transient stream state until the final AI message is persisted.
  const runtime = {
    // Collected thinking/tool lines shown in the live reasoning panel.
    thoughts: [] as string[],
    // Thinking start timestamp for duration tracking.
    thinkingStart: 0,
    // Thinking end timestamp once reasoning or first answer chunk finishes it.
    thinkingEnd: 0,
    // First valid event timestamp used as a fallback start marker.
    firstEventTs: 0,
    // The message row currently being streamed into the UI.
    stagedMessageId: (prefillMessageId ?? '') as string,
    // Incrementally assembled assistant text.
    content: '' as string,
    // Guards against closing the thinking panel more than once.
    closedThinkingOnFirstChunk: false,
    // Parent message id for the reply being persisted.
    parentMessageId: replyParentMessageId,
    // Branch path sent to and mirrored from the stream.
    messagePath: uiBranchPath,
    // Raw custom events kept for persistence/debugging.
    rawEvents: [] as Record<string, any>[],
    // Latest parsed plan snapshot from custom AG-UI events.
    plan: undefined as PlanSnapshot | undefined,
    // Structured sub-agent metadata collected during the run.
    subagents: undefined as StreamSubagentState | undefined,
  };

  const pushRawEvent = (event: Record<string, any>) => {
    // Keep the original custom payload so the final message retains stream-side metadata.
    runtime.rawEvents.push(event);
  };

  const pushSubagentEvent = (key: keyof StreamSubagentState, value: unknown) => {
    // Group sub-agent metadata by category so the UI can render it later without reparsing.
    const current = runtime.subagents ?? {};
    const existing = Array.isArray(current[key]) ? current[key] : [];
    runtime.subagents = {
      ...current,
      [key]: [...existing, value],
    };
  };
  
  const finalizeThinkingState = () => {
    // Always mark reasoning complete at stream teardown even if the backend ends abruptly.
    setThinkingState((prev: any) => {
      if (!prev) return prev;
      // Preserve the existing state object if it is already finalized to avoid pointless rerenders.
      if (prev.isDone && !prev.isActive) return prev;
      const endTs = runtime.thinkingEnd || Date.now();
      return {
        ...prev,
        isActive: false,
        isDone: true,
        endTime: prev.endTime ?? endTs,
        currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1),
      };
    });
  };
  
  const onEvent = async (raw: unknown) => {
    // Ignore anything after cancellation to avoid stale UI writes.
    if (aborted) return;
    const ev = parseEvent(raw);
    // Unknown or invalid frames are ignored instead of crashing the whole stream lifecycle.
    if (!ev) return;
    
    // The first event doubles as a durable fallback start time for thinking duration math.
    if (!runtime.firstEventTs) {
      runtime.firstEventTs = Date.now();
    }
    
    switch (ev.type) {
      case AGUIEventType.CUSTOM: {
        // Custom events are parsed twice: first as generic AG-UI custom events, then as one of our app-specific payloads.
        const customEvent = CustomEventSchema.safeParse(ev);
        if (!customEvent.success) return;
        pushRawEvent(customEvent.data as Record<string, any>);

        const planSnapshotEvent = PlanSnapshotCustomEventSchema.safeParse(ev);
        if (planSnapshotEvent.success) {
          // Keep only the latest snapshot; the page-level history is handled by onPlanSnapshot.
          runtime.plan = planSnapshotEvent.data.value;
          onPlanSnapshot?.(planSnapshotEvent.data.value);
          return;
        }

        const taskSubAgentEvent = TaskSubAgentCustomEventSchema.safeParse(ev);
        if (taskSubAgentEvent.success) {
          pushSubagentEvent('tasks', taskSubAgentEvent.data.value);
          return;
        }

        const subAgentEvent = SubAgentCustomEventSchema.safeParse(ev);
        if (subAgentEvent.success) {
          pushSubagentEvent('events', subAgentEvent.data.value);
          return;
        }

        const beforeAgentEvent = BeforeAgentCustomEventSchema.safeParse(ev);
        if (beforeAgentEvent.success) {
          pushSubagentEvent('beforeAgent', beforeAgentEvent.data.value);
          return;
        }

        const interruptEvent = HITLInterruptCustomEventSchema.safeParse(ev);
        if (interruptEvent.success) {
          // Interrupt payloads are still persisted even if the UI does not yet provide a dedicated HITL surface.
          pushSubagentEvent('interrupts', interruptEvent.data.value);
        }
        return;
      }

      case AGUIEventType.RUN_STARTED: {
        // The first official run event means the backend has taken over from the optimistic transition state.
        const runStartedEvent = RunStartedEventSchema.safeParse(ev);
        if (!runStartedEvent.success) return;
        if (setShowAiTransition) setShowAiTransition(false);
        return;
      }

      case AGUIEventType.THINKING_START: {
        // Thinking frames drive the live CoT panel until the first answer chunk closes the thinking session.
        const thinkingStartEvent = ThinkingStartEventSchema.safeParse(ev);
        if (!thinkingStartEvent.success || aborted) return;
        runtime.thinkingStart = Date.now();
        runtime.thinkingEnd = 0;
        // The staged assistant message id is not known yet, so thinking is keyed by branch path first.
        setThinkingState({
          messageId: '',
          thoughts: [],
          currentThoughtIndex: 0,
          isActive: true,
          isDone: false,
          startTime: runtime.thinkingStart,
          branchPath: [...runtime.messagePath],
        });
        return;
      }

      case AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT: {
        // Thinking deltas are appended as plain lines because the UI currently renders reasoning as a flat sequence.
        const thinkingContentEvent = ThinkingTextMessageContentEventSchema.safeParse(ev);
        if (!thinkingContentEvent.success || aborted) return;
        runtime.thoughts.push(String(thinkingContentEvent.data.delta ?? ''));
        setThinkingState((prev: any) =>
          prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: runtime.thoughts.length - 1 } : prev,
        );
        return;
      }

      case AGUIEventType.TOOL_CALL_START: {
        // Tool calls are surfaced as synthetic thought lines for now; richer tool rendering can build on the typed event later.
        const toolCallStartEvent = ToolCallStartEventSchema.safeParse(ev);
        if (!toolCallStartEvent.success || aborted) return;
        runtime.thoughts.push(`[tool] ${toolCallStartEvent.data.toolCallName}`);
        setThinkingState((prev: any) =>
          prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: runtime.thoughts.length - 1 } : prev,
        );
        return;
      }

      case AGUIEventType.TOOL_CALL_ARGS: {
        // Tool args are validated for safety now and can be rendered later without changing the parser shape.
        const toolCallArgsEvent = ToolCallArgsEventSchema.safeParse(ev);
        if (!toolCallArgsEvent.success) return;
        return;
      }

      case AGUIEventType.TOOL_CALL_RESULT: {
        // Tool results are validated now even though the current UI does not surface them separately.
        const toolCallResultEvent = ToolCallResultEventSchema.safeParse(ev);
        if (!toolCallResultEvent.success) return;
        return;
      }

      case AGUIEventType.THINKING_END: {
        // Explicit thinking end updates the duration even if no answer chunk has arrived yet.
        const thinkingEndEvent = ThinkingEndEventSchema.safeParse(ev);
        if (!thinkingEndEvent.success || aborted) return;
        runtime.thinkingEnd = Date.now();
        return;
      }

      case AGUIEventType.TEXT_MESSAGE_START: {
        // The first assistant frame either materializes a staged placeholder or reuses the DB-backed placeholder created before streaming.
        const textMessageStartEvent = TextMessageStartEventSchema.safeParse(ev);
        if (!textMessageStartEvent.success || aborted) return;

        const msgId = textMessageStartEvent.data.messageId || `ai-${Date.now()}`;
        // Prefer the DB-backed placeholder id so later persistence updates the same row.
        const resolvedId = runtime.stagedMessageId || String(msgId);
        runtime.stagedMessageId = resolvedId;

        if (!prefillMessageId) {
          // If no placeholder exists, create a purely local assistant row to stream into.
          const staged: MessageOut = {
            id: resolvedId,
            sender: 'ai',
            type: 'text',
            parentMessageId: runtime.parentMessageId,
            content: '',
            attachments: [],
            created_at: new Date(),
            updated_at: new Date(),
            rawEvents: [],
            plan: undefined,
            subagents: undefined,
          } as any;
          setMessages((prev: MessageOut[]) => [...prev, staged]);
        } else {
          // If a placeholder already exists, just stamp the final parent/type metadata onto it.
          setMessages((prev: MessageOut[]) =>
            prev.map((m) =>
              m.id === resolvedId
                ? { ...m, sender: 'ai', type: 'text', parentMessageId: runtime.parentMessageId, updated_at: new Date() }
                : m
            )
          );
        }
        return;
      }

      case AGUIEventType.TEXT_MESSAGE_CHUNK:
      case AGUIEventType.TEXT_MESSAGE_CONTENT: {
        // Stream deltas are accumulated locally and mirrored into the staged message so the UI updates token-by-token.
        const textDeltaEvent = ev.type === AGUIEventType.TEXT_MESSAGE_CHUNK
          ? TextMessageChunkEventSchema.safeParse(ev)
          : TextMessageContentEventSchema.safeParse(ev);
        if (!textDeltaEvent.success || aborted) return;

        const delta = String(textDeltaEvent.data.delta ?? '');
        // Assistant text is assembled incrementally because AG-UI can split content across many frames.
        runtime.content += delta;

        if (!runtime.closedThinkingOnFirstChunk) {
          // The first answer token implicitly closes the reasoning phase in the current UX model.
          runtime.closedThinkingOnFirstChunk = true;
          runtime.thinkingEnd = Date.now();
          setThinkingState((prev: any) =>
            prev
              ? {
                  ...prev,
                  isActive: false,
                  isDone: true,
                  endTime: Date.now(),
                  currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1),
                }
              : prev,
          );
        }

        const id = runtime.stagedMessageId;
        if (id) {
          // Mirror the partial text into the staged message so React can repaint progressively.
          setMessages((prev: MessageOut[]) =>
            prev.map((m) => (m.id === id ? { ...m, content: runtime.content, updated_at: new Date() } : m)),
          );
        }
        return;
      }

      case AGUIEventType.TEXT_MESSAGE_END: {
        // Once the assistant stream ends, we persist the fully assembled message plus all collected AG-UI metadata.
        const textMessageEndEvent = TextMessageEndEventSchema.safeParse(ev);
        if (!textMessageEndEvent.success || aborted) return;

        const endRef = runtime.thinkingEnd || Date.now();
        const startRef = runtime.firstEventTs || runtime.thinkingStart;
        // Thinking duration uses the earliest reliable stream marker to stay stable across agent variants.
        const thinkingTime =
          startRef && endRef
            ? Math.max(0, Math.round((endRef - startRef) / 1000))
            : undefined;

        // This is the final assistant payload written back into the conversation store.
        const payload: MessageIn = {
          sender: 'ai',
          type: 'text',
          content: runtime.content,
          parentMessageId: runtime.parentMessageId,
          thinking: runtime.thoughts.length ? runtime.thoughts : undefined,
          thinkingTime,
          rawEvents: runtime.rawEvents,
          plan: runtime.plan,
          subagents: runtime.subagents,
        } as any;

        try {
          if (prefillMessageId || runtime.stagedMessageId) {
            // Normal path: finalize the placeholder created before the stream started.
            const targetId = runtime.stagedMessageId || prefillMessageId!;
            const resp = await updateMessageInConversation(userId, conversationId, targetId, payload as any);
            setMessages((prev: MessageOut[]) => prev.map((m) => (m.id === targetId ? resp.message : m)));
            setCurrentConversation((prev: any) => (prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev));
            setConversations((prev: any[]) =>
              sortByUpdatedAtDesc(prev.map((c) => (c.id === resp.summary.id ? resp.summary : c))),
            );
            persistUIState?.();
          } else {
            // Fallback path: create the assistant message only after streaming completes.
            const resp = await addMessageToConversation(userId, conversationId, payload);
            const id = runtime.stagedMessageId;
            // If we created a local staged row earlier, replace it; otherwise append the saved assistant row.
            setMessages((prev: MessageOut[]) => prev.map((m) => (m.id === id ? resp.message : m)));
            setCurrentConversation((prev: any) => (prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev));
            setConversations((prev: any[]) =>
              sortByUpdatedAtDesc(prev.map((c) => (c.id === resp.summary.id ? resp.summary : c))),
            );
            persistUIState?.();
          }
        } catch (err) {
          console.error('Failed to persist AI message', err);
        }
        return;
      }

      case AGUIEventType.RUN_ERROR: {
        // Error frames are persisted as failed AI messages so retries and conversation history remain consistent.
        const runErrorEvent = RunErrorEventSchema.safeParse(ev);
        if (!runErrorEvent.success || aborted) return;

        const errEndTs = runtime.thinkingEnd || Date.now();
        // Errors also terminate the active reasoning state so the UI does not stay in a loading posture.
        setThinkingState((prev: any) => (prev ? { ...prev, isActive: false, isDone: true, endTime: errEndTs } : prev));
        if (setShowAiTransition) setShowAiTransition(false);

        const errorMsg = runErrorEvent.data.message || 'Agent stream failed.';
        // Error payloads reuse the same persistence shape as normal messages plus error flags.
        const payload: MessageIn = {
          sender: 'ai',
          type: 'text',
          content: runtime.content || 'An error occurred while generating the response.',
          parentMessageId: runtime.parentMessageId,
          error: true,
          errorMessage: errorMsg,
          thinking: runtime.thoughts.length ? runtime.thoughts : undefined,
          thinkingTime: runtime.thinkingStart
            ? Math.round(((runtime.thinkingEnd || Date.now()) - runtime.thinkingStart) / 1000)
            : undefined,
          rawEvents: runtime.rawEvents,
          plan: runtime.plan,
          subagents: runtime.subagents,
        } as any;

        try {
          if (prefillMessageId || runtime.stagedMessageId) {
            // Update the existing placeholder when the stream fails after optimistic message creation.
            const targetId = runtime.stagedMessageId || prefillMessageId!;
            const resp = await updateMessageInConversation(userId, conversationId, targetId, payload as any);
            setMessages((prev: MessageOut[]) => prev.map((m) => (m.id === targetId ? resp.message : m)));
            setCurrentConversation((prev: any) => (prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev));
            setConversations((prev: any[]) =>
              sortByUpdatedAtDesc(prev.map((c) => (c.id === resp.summary.id ? resp.summary : c))),
            );
            persistUIState?.();
          } else {
            // If no placeholder exists, persist the error as a brand new assistant row.
            const resp = await addMessageToConversation(userId, conversationId, payload);
            const id = runtime.stagedMessageId;
            if (id) {
              setMessages((prev: MessageOut[]) => prev.map((m) => (m.id === id ? resp.message : m)));
            } else {
              setMessages((prev: MessageOut[]) => [...prev, resp.message]);
            }
            setCurrentConversation((prev: any) => (prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev));
            setConversations((prev: any[]) =>
              sortByUpdatedAtDesc(prev.map((c) => (c.id === resp.summary.id ? resp.summary : c))),
            );
            persistUIState?.();
          }
        } catch (err) {
          console.error('Failed to persist error message', err);
        }
        toast({ title: 'Agent error', description: errorMsg, variant: 'destructive' });
        return;
      }

      default:
        // Unknown-but-validated AG-UI events are intentionally ignored until the UI has a use for them.
        return;
    }
  };
  
  try {
    // The server branch path wins when retries or branch switches need to stream against a different lineage.
    const outboundPath = serverBranchPath ?? runtime.messagePath;
    // `streamInference` owns the transport; `onEvent` above owns all client-side interpretation and persistence.
    await streamInference(userId, conversationId, outboundPath, onEvent, signal, enabledTools);
  } catch (err) {
    const name = (err as any)?.name;
    if (name === 'AbortError') {
      return;
    }
    console.error('Stream error', err);
    const status = (err as any)?.status;
    const detail = (err as any)?.detail;
    // Stream bootstrap failures are surfaced immediately because no RUN_ERROR event will arrive in this path.
    const description =
      status === 404
        ? 'Agent metadata not found. Please select a different agent and try again.'
        : detail
          ? `The agent stream ended unexpectedly: ${detail}`
          : 'The agent stream ended unexpectedly.';
    toast({
      title: 'Stream error',
      description,
      variant: 'destructive',
    });
  } finally {
    // Final cleanup runs for success, server errors, and manual aborts.
    finalizeThinkingState();
    // Always hide the optimistic transition indicator once the stream lifecycle is considered over.
    if (setShowAiTransition) setShowAiTransition(false);
  }
}
