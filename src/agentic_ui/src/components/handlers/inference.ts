import { createConversation, addMessageToConversation } from '@/lib/api';
import { convertFileAttachments, sortByUpdatedAtDesc } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment } from '@/lib/types';
import { streamAguiRun } from './agui';

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
        await streamAguiRun({
          userId: userId!,
          conversationId: response.detail.id,
          history,
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          signal: currentStreamAbort.signal,
        });
        currentStreamAbort = null;

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
        await streamAguiRun({
          userId: userId!,
          conversationId: currentConversation!.id,
          history,
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          signal: currentStreamAbort.signal,
        });
        currentStreamAbort = null;
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      toast({ title: 'Error', description: 'Failed to send message. Please try again.', variant: 'destructive' });
      // Remove any temp message if present
      setMessages((prev) => prev.filter((m) => !String(m.id).startsWith('temp-')));
      if (setShowAiTransition) setShowAiTransition(false);
      currentStreamAbort = null;
    }
    setIsSendingMessage(false);
  };

  const handleStopStreaming = () => {
    if (currentStreamAbort) {
      currentStreamAbort.abort();
      currentStreamAbort = null;
      setIsSendingMessage(false);
      setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
      if (setShowAiTransition) setShowAiTransition(false);
    }
  };

  return { handleSendMessage, handleStopStreaming };
}
