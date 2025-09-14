import { createConversation, addMessageToConversation, streamInference, type AGUIEvent } from '@/lib/api';
import { AGUIEventType, asEventType } from '@/lib/agui';
import { convertFileAttachments, sortByUpdatedAtDesc } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment } from '@/lib/types';

type InferenceCtx = {
  userId: string | null;
  selectedAgent: string;
  isPrivateMode: boolean;
  messages: MessageOut[];
  attachments: File[];
  agents: Agent[];
  currentConversation: ConversationDetail | null;
  currentMessage: string;
  isSendingMessage?: boolean;
  
  // setters
  setMessages: (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
  setCurrentMessage: (v: string) => void;
  setAttachments: (v: File[] | ((prev: File[]) => File[])) => void;
  setIsSendingMessage: (v: boolean) => void;
  setCurrentConversation: (v: ConversationDetail | null) => void;
  setConversations: (updater: (prev: any[]) => any[]) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  
  // helpers from attachments
  isImageFile: (file: File | any) => boolean;
  getImageUrl: (file: File | any) => string;
  
  // thinking
  setThinkingState: (updater: any) => void;
  // UI transition indicator between persistence and thinking start
  setShowAiTransition?: (v: boolean) => void;
};

export function createInferenceHandlers(ctx: InferenceCtx) {
  // Allow aborting previous streams if user sends again quickly
  let currentStreamAbort: AbortController | null = null;
  const {
    userId,
    selectedAgent,
    isPrivateMode,
    messages,
    attachments,
    agents,
    currentConversation,
    setMessages,
    setCurrentMessage,
    setAttachments,
    setIsSendingMessage,
    setCurrentConversation,
    setConversations,
    toast,
    isImageFile,
    getImageUrl,
    setThinkingState,
    setShowAiTransition,
  } = ctx;
  
  const handleSendMessage = async () => {
    const currentMessage = ctx.currentMessage;
    
    if (!currentMessage && attachments.length === 0) return;
    if (ctx.isSendingMessage) return;
    
    if (attachments.length) {
      const sizeErr = validateAttachmentsForUpload(attachments);
      if (sizeErr) {
        toast({ title: 'Attachment too large', description: sizeErr, variant: 'destructive' });
        return;
      }
    }
    
    setIsSendingMessage(true);
    const currentAgent = agents.find(a => a.id === selectedAgent);
    
    // Prepare attachments once (as both API payload and temp AttachmentOuts)
    const messageAttachments: FileAttachment[] = attachments.map(file => ({
      file,
      url: isImageFile(file) ? getImageUrl(file) : '',
      name: file.name,
      type: file.type,
    }));
    const apiAttachments = await convertFileAttachments(messageAttachments);
    const tempAttachmentsOut: any[] = apiAttachments.map((a, i) => ({
      id: `temp-att-${Date.now()}-${i}`,
      name: a.name,
      mime: a.mime,
      size: a.size,
      timestamp: new Date(),
      data: a.dataB64,
    }));
    
    // Show user's message immediately (with AttachmentOut shape)
    const tempId = `temp-${Date.now()}`;
    const tempMessage: MessageOut = {
      id: tempId,
      sender: 'user',
      type: attachments.length > 0 ? 'file' : 'text',
      content: currentMessage || undefined,
      created_at: new Date(),
      updated_at: new Date(),
      attachments: tempAttachmentsOut as any,
    };
    setMessages(prev => [...prev, tempMessage]);
    setCurrentMessage('');
    setAttachments([]);
    
    try {
      if (messages.length === 0) {
        const conversationPayload: ConversationIn = {
          agentId: selectedAgent,
          isPrivate: isPrivateMode,
          title: undefined,
          firstMessage: {
            sender: 'user',
            type: attachments.length > 0 ? 'file' : 'text',
            content: currentMessage || undefined,
            attachments: apiAttachments,
          },
        };
        
        const response = await createConversation(userId!, conversationPayload);
        setCurrentConversation(response.detail);
        
        // Replace temp  message with authoritative messages from server
        setMessages(() => response.detail.messages);
        setConversations(prev => sortByUpdatedAtDesc([response.summary, ...prev]));
        if (setShowAiTransition) setShowAiTransition(true);
        
        // Build full chat history for the agent (role/content only)
        const history = (response.detail.messages || []).map((m) => ({
          role: m.sender === 'user' ? 'user' : 'ai',
          content: m.content || ''
        }));
        
        // Start streaming inference
        if (currentStreamAbort) currentStreamAbort.abort();
        currentStreamAbort = new AbortController();
        await startStreaming({
          userId: userId!,
          conversationId: response.detail.id,
          history,
        }, currentStreamAbort.signal);
        
      } else {
        const messagePayload: MessageIn = {
          sender: 'user',
          type: attachments.length > 0 ? 'file' : 'text',
          content: currentMessage || undefined,
          attachments: apiAttachments,
        };
        
        const response = await addMessageToConversation(userId!, currentConversation!.id, messagePayload);
        // Replace temp message with API message
        setMessages(prev => prev.map(m => (m.id === tempId ? response.message : m)));
        
        // Touch currentConversation timestamps minimally
        setCurrentConversation(
          currentConversation
            ? { ...currentConversation, updated_at: new Date(response.summary.updated_at) }
            : currentConversation
        );
        // Update sidebar summary and keep ordering
        setConversations(prev => sortByUpdatedAtDesc(prev.map(conv => (conv.id === response.summary.id ? response.summary : conv))));
        if (setShowAiTransition) setShowAiTransition(true);
        // Build full chat history from current messages + new API message
        const base = messages.filter(m => !String(m.id).startsWith('temp-'));
        const historyMessages: MessageOut[] = [...base, response.message];
        const history = historyMessages.map((m) => ({
          role: m.sender === 'user' ? 'user' : 'ai',
          content: m.content || ''
        }));
        if (currentStreamAbort) currentStreamAbort.abort();
        currentStreamAbort = new AbortController();
        await startStreaming({
          userId: userId!,
          conversationId: currentConversation!.id,
          history,
        }, currentStreamAbort.signal);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      toast({ title: 'Error', description: 'Failed to send message. Please try again.', variant: 'destructive' });
      // Remove any temp message if present
      setMessages((prev) => prev.filter((m) => !String(m.id).startsWith('temp-')));
      if (setShowAiTransition) setShowAiTransition(false);
    }
    setIsSendingMessage(false);
  };
  
  return { handleSendMessage };
  
  // --- Streaming helpers ---
  async function startStreaming(
    {
      userId,
      conversationId,
      history,
    }: { userId: string; conversationId: string; history: { role: string; content: string }[] },
    signal?: AbortSignal,
  ) {
    const runtime = {
      thoughts: [] as string[],
      thinkingStart: 0,
      thinkingEnd: 0,
      stagedMessageId: '' as string,
      content: '' as string,
      closedThinkingOnFirstChunk: false,
      lastToolIndex: null as number | null,
    };
    
    const onEvent = async (e: AGUIEvent) => {
      const t = asEventType(e);
      
      if (t === AGUIEventType.RUN_STARTED) {
        if (setShowAiTransition) setShowAiTransition(false);
        return;
      }
      
      if (t === AGUIEventType.THINKING_START) {
        runtime.thinkingStart = Date.now();
        setThinkingState({
          messageId: '',
          thoughts: [],
          currentThoughtIndex: 0,
          isActive: true,
          isDone: false,
          startTime: runtime.thinkingStart,
        });
        return;
      }
      
      if (t === AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT) {
        const delta = e.delta ?? '';
        runtime.thoughts.push(String(delta));
        setThinkingState((prev: any) => prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1) } : prev);
        return;
      }
      
      if (t === AGUIEventType.TOOL_CALL_START) {
        const name = e.tool_call_name || e.name || (e.tool && (e.tool.name || e.tool_call_name)) || 'tool';
        const line = `[tool_active] ${name}`;
        runtime.thoughts.push(line);
        runtime.lastToolIndex = runtime.thoughts.length - 1;
        setThinkingState((prev: any) => prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: runtime.lastToolIndex } : prev);
        return;
      }
      if (t === AGUIEventType.TOOL_CALL_ARGS) {
        // Suppress verbose args in the thinking list to keep it clean.
        return;
      }
      if (t === AGUIEventType.TOOL_CALL_RESULT) {
        const content = typeof e.content === 'string' ? e.content : (e.content ? JSON.stringify(e.content) : '');
        const line = `[tool] ${content}`; // keep tool icon, hide prefix in UI
        if (runtime.lastToolIndex != null && runtime.lastToolIndex >= 0 && runtime.lastToolIndex < runtime.thoughts.length) {
          // Replace the active tool line with the result content
          runtime.thoughts[runtime.lastToolIndex] = line;
          runtime.lastToolIndex = null;
        } else {
          // No start seen, just append as tool result
          runtime.thoughts.push(line);
        }
        setThinkingState((prev: any) => prev ? { ...prev, thoughts: [...runtime.thoughts], currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1) } : prev);
        return;
      }
      if (t === AGUIEventType.THINKING_END) {
        // Mark thinking done, but keep the panel open until the first content chunk arrives
        runtime.thinkingEnd = Date.now();
        setThinkingState((prev: any) => prev ? { ...prev, isDone: true, endTime: runtime.thinkingEnd, currentThoughtIndex: Math.max(0, runtime.thoughts.length - 1) } : prev);
        return;
      }
      
      if (t === AGUIEventType.TEXT_MESSAGE_START) {
        const msgId = e.message_id || e.messageId || `ai-${Date.now()}`;
        runtime.stagedMessageId = String(msgId);
        const staged: MessageOut = {
          id: runtime.stagedMessageId,
          sender: 'ai',
          type: 'text',
          content: '',
          attachments: [],
          created_at: new Date(),
          updated_at: new Date(),
        } as any;
        setMessages((prev: MessageOut[]) => [...prev, staged]);
        return;
      }

      if (t === AGUIEventType.TEXT_MESSAGE_CHUNK || t === AGUIEventType.TEXT_MESSAGE_CONTENT) {
        const delta = (e.delta ?? e.content ?? e.text ?? e.token ?? '') as string;
        runtime.content += String(delta);

        // As soon as first visible content arrives, auto-close the global thinking panel
        if (!runtime.closedThinkingOnFirstChunk) {
          runtime.closedThinkingOnFirstChunk = true;
          setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
        }

        const id = runtime.stagedMessageId;
        if (id) {
          setMessages((prev: MessageOut[]) => prev.map(m => m.id === id ? { ...m, content: runtime.content, updated_at: new Date() } : m));
        }
        return;
      }
      
      if (t === AGUIEventType.TEXT_MESSAGE_END) {
        const thinkingTime = runtime.thinkingStart ? Math.round(((runtime.thinkingEnd || Date.now()) - runtime.thinkingStart) / 1000) : undefined;
        const payload: MessageIn = {
          sender: 'ai',
          type: 'text',
          content: runtime.content,
          thinking: runtime.thoughts.length ? runtime.thoughts : undefined,
          thinkingTime,
        } as any;
        try {
          const resp = await addMessageToConversation(userId, conversationId, payload);
          const id = runtime.stagedMessageId;
          setMessages((prev: MessageOut[]) => prev.map(m => m.id === id ? resp.message : m));
          setCurrentConversation((prev: any) => prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev);
          setConversations((prev: any[]) => sortByUpdatedAtDesc(prev.map(c => c.id === resp.summary.id ? resp.summary : c)));
        } catch (err) {
          console.error('Failed to persist AI message', err);
        }
        return;
      }
      
      if (t === AGUIEventType.RUN_ERROR) {
        // Close thinking if active
        setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
        if (setShowAiTransition) setShowAiTransition(false);
        
        // Persist an error assistant message so history reflects the failure
        const errorMsg = (e as any)?.message || 'Agent stream failed.';
        const payload: MessageIn = {
          sender: 'ai',
          type: 'text',
          content: runtime.content || 'An error occurred while generating the response.',
          error: true,
          errorMessage: errorMsg,
          thinking: runtime.thoughts.length ? runtime.thoughts : undefined,
          thinkingTime: runtime.thinkingStart ? Math.round(((runtime.thinkingEnd || Date.now()) - runtime.thinkingStart) / 1000) : undefined,
        } as any;
        try {
          const resp = await addMessageToConversation(userId, conversationId, payload);
          const id = runtime.stagedMessageId;
          if (id) {
            setMessages((prev: MessageOut[]) => prev.map(m => m.id === id ? resp.message : m));
          } else {
            setMessages((prev: MessageOut[]) => [...prev, resp.message]);
          }
          setCurrentConversation((prev: any) => prev ? { ...prev, updated_at: new Date(resp.summary.updated_at) } : prev);
          setConversations((prev: any[]) => sortByUpdatedAtDesc(prev.map(c => c.id === resp.summary.id ? resp.summary : c)));
        } catch (err) {
          console.error('Failed to persist error message', err);
        }
        toast({ title: 'Agent error', description: errorMsg, variant: 'destructive' });
        return;
      }
    };
    
    try {
      await streamInference(userId, conversationId, history, onEvent, signal);
    } catch (err) {
      console.error('Stream error', err);
      toast({ title: 'Stream error', description: 'The agent stream ended unexpectedly.', variant: 'destructive' });
    }
  }
}
