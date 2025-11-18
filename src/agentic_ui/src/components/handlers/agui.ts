import { addMessageToConversation, streamInference } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';
import type { MessageIn, MessageOut } from '@/lib/types';
import { EventSchemas, EventType as AGUIEventType } from '@ag-ui/core';

const parseEvent = (raw: unknown) => {
  const result = EventSchemas.safeParse(raw);
  return result.success ? result.data : null;
};

type MessageSetter = (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);

type ConversationSetter = (updater: (prev: any[]) => any[]) => void;

type ThinkingSetter = (updater: any) => void;

type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type AguiStreamOptions = {
  userId: string;
  conversationId: string;
  replyParentMessageId: string;
  uiBranchPath: string[];
  serverBranchPath?: string[];
  setMessages: MessageSetter;
  setThinkingState: ThinkingSetter;
  setCurrentConversation: (updater: any) => void;
  setConversations: ConversationSetter;
  toast: ToastFn;
  setShowAiTransition?: (v: boolean) => void;
  signal?: AbortSignal;
  prefillMessageId?: string;
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
  } = options;
  
  let aborted = false;
  options.signal?.addEventListener('abort', () => {
    aborted = true;
  }, { once: true });

  const runtime = {
    thoughts: [] as string[],
    thinkingStart: 0,
    thinkingEnd: 0,
    stagedMessageId: (prefillMessageId ?? '') as string,
    content: '' as string,
    closedThinkingOnFirstChunk: false,
    parentMessageId: replyParentMessageId,
    messagePath: uiBranchPath,
  };
  
  const finalizeThinkingState = () => {
    setThinkingState((prev: any) => {
      if (!prev) return prev;
      if (prev.isDone && !prev.isActive) return prev;
      return {
        ...prev,
        isActive: false,
        isDone: true,
        endTime: prev.endTime ?? Date.now(),
        currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1),
      };
    });
  };
  
  const onEvent = async (raw: unknown) => {
    if (aborted) return;
    const ev = parseEvent(raw);
    if (!ev) return;
    
    const type = ev.type;
    
    if (type === AGUIEventType.RUN_STARTED) {
      if (setShowAiTransition) setShowAiTransition(false);
      return;
    }
    
    if (type === AGUIEventType.THINKING_START) {
      if (aborted) return;
      runtime.thinkingStart = Date.now();
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
    
    if (type === AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT) {
      if (aborted) return;
      runtime.thoughts.push(String(ev.delta ?? ''));
      setThinkingState((prev: any) =>
        prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: runtime.thoughts.length - 1 } : prev,
      );
      return;
    }
    
    if (type === AGUIEventType.TOOL_CALL_START) {
      if (aborted) return;
      runtime.thoughts.push(`[tool] ${ev.toolCallName}`);
      setThinkingState((prev: any) =>
        prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: runtime.thoughts.length - 1 } : prev,
      );
      return;
    }
    
    if (type === AGUIEventType.TOOL_CALL_ARGS || type === AGUIEventType.TOOL_CALL_RESULT) {
      return;
    }

    if (type === AGUIEventType.THINKING_END) {
      if (aborted) return;
      runtime.thinkingEnd = Date.now();
      setThinkingState((prev: any) =>
        prev ? { ...prev, isDone: true, endTime: runtime.thinkingEnd, currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1) } : prev,
      );
      return;
    }
    
    if (type === AGUIEventType.TEXT_MESSAGE_START) {
      if (aborted) return;
      const msgId = ev.messageId || `ai-${Date.now()}`;
      const resolvedId = runtime.stagedMessageId || String(msgId);
      runtime.stagedMessageId = resolvedId;

      if (!prefillMessageId) {
        const staged: MessageOut = {
          id: resolvedId,
          sender: 'ai',
          type: 'text',
          parentMessageId: runtime.parentMessageId,
          content: '',
          attachments: [],
          created_at: new Date(),
          updated_at: new Date(),
        } as any;
        setMessages((prev: MessageOut[]) => [...prev, staged]);
      } else {
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
    
    if (type === AGUIEventType.TEXT_MESSAGE_CHUNK || type === AGUIEventType.TEXT_MESSAGE_CONTENT) {
      if (aborted) return;
      const delta = (ev.delta ?? '') as string;
      runtime.content += String(delta);
      
      if (!runtime.closedThinkingOnFirstChunk) {
        runtime.closedThinkingOnFirstChunk = true;
        setThinkingState((prev: any) =>
          prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev,
        );
      }
      
      const id = runtime.stagedMessageId;
      if (id) {
        setMessages((prev: MessageOut[]) =>
          prev.map((m) => (m.id === id ? { ...m, content: runtime.content, updated_at: new Date() } : m)),
        );
      }
      return;
    }
    
    if (type === AGUIEventType.TEXT_MESSAGE_END) {
      if (aborted) return;
      const thinkingTime = runtime.thinkingStart
        ? Math.round(((runtime.thinkingEnd || Date.now()) - runtime.thinkingStart) / 1000)
        : undefined;
      
      const payload: MessageIn = {
        sender: 'ai',
        type: 'text',
        content: runtime.content,
        parentMessageId: runtime.parentMessageId,
        thinking: runtime.thoughts.length ? runtime.thoughts : undefined,
        thinkingTime,
      } as any;
      
      try {
        const resp = await addMessageToConversation(userId, conversationId, payload);
        const id = runtime.stagedMessageId;
        setMessages((prev: MessageOut[]) => prev.map((m) => (m.id === id ? resp.message : m)));
        setCurrentConversation((prev: any) => (prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev));
        setConversations((prev: any[]) =>
          sortByUpdatedAtDesc(prev.map((c) => (c.id === resp.summary.id ? resp.summary : c))),
        );
      } catch (err) {
        console.error('Failed to persist AI message', err);
      }
      return;
    }
    
    if (type === AGUIEventType.RUN_ERROR) {
      if (aborted) return;
      setThinkingState((prev: any) => (prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev));
      if (setShowAiTransition) setShowAiTransition(false);
      
      const errorMsg = ev.message || 'Agent stream failed.';
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
      } as any;
      
      try {
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
      } catch (err) {
        console.error('Failed to persist error message', err);
      }
      toast({ title: 'Agent error', description: errorMsg, variant: 'destructive' });
      return;
    }
  };
  
  try {
    const outboundPath = serverBranchPath ?? runtime.messagePath;
    await streamInference(userId, conversationId, outboundPath, onEvent, signal);
  } catch (err) {
    const name = (err as any)?.name;
    if (name === 'AbortError') {
      const stagedId = runtime.stagedMessageId;
      if (stagedId) {
        setMessages((prev: MessageOut[]) => prev.filter((m) => m.id !== stagedId));
      }
      return;
    }
    console.error('Stream error', err);
    const stagedId = runtime.stagedMessageId;
    if (stagedId) {
      setMessages((prev: MessageOut[]) => prev.filter((m) => m.id !== stagedId));
    }
    const status = (err as any)?.status;
    const detail = (err as any)?.detail;
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
    finalizeThinkingState();
    if (setShowAiTransition) setShowAiTransition(false);
  }
}


