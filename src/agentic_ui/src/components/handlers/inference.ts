import { createConversation, addMessageToConversation, transcribeDictation } from '@/lib/api';
import { convertFileAttachments, sortByUpdatedAtDesc } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment } from '@/lib/types';
import { streamAguiRun } from './agui';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { DictationStatus } from '@/components/chat/ChatInputBar';

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
  setCurrentMessage: Dispatch<SetStateAction<string>>;
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
  setDictationStatus: Dispatch<SetStateAction<DictationStatus>>;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  streamAbortRef: MutableRefObject<AbortController | null>;
};

export function createInferenceHandlers(ctx: InferenceCtx) {
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
    setDictationStatus,
    textareaRef,
    streamAbortRef,
  } = ctx;

  const resolveLastPersistedMessageId = () => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      const id = candidate?.id;
      if (!id) continue;
      if (String(id).startsWith('temp-')) continue;
      return id;
    }
    return null;
  };

  const handleSendMessage = async () => {
    const currentMessage = ctx.currentMessage;

    if (!currentMessage && attachments.length === 0) return;
    if (ctx.isSendingMessage) return;
    
    // Validate attachments upfront
    if (attachments.length) {
      const sizeErr = validateAttachmentsForUpload(attachments);
      if (sizeErr) {
        toast({ title: 'Attachment too large', description: sizeErr, variant: 'destructive' });
        return;
      }
    }
    
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again to continue.', variant: 'destructive' });
      return;
    }

    // Mark sending state
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
    
    const lastPersistedMessageId = resolveLastPersistedMessageId();
    const activePathIds = messages.map((msg) => msg.id);

    // Show user's message immediately (with AttachmentOut shape)
    const tempId = `temp-${Date.now()}`;
    const tempParentId = messages.length === 0 ? null : lastPersistedMessageId;
    const tempMessage: MessageOut = {
      id: tempId,
      sender: 'user',
      type: attachments.length > 0 ? 'file' : 'text',
      content: currentMessage || undefined,
      parentMessageId: tempParentId ?? undefined,
      created_at: new Date(),
      updated_at: new Date(),
      attachments: tempAttachmentsOut as any,
    };
    setMessages(prev => [...prev, tempMessage]);
    setCurrentMessage('');
    setAttachments([]);
    if (setShowAiTransition) setShowAiTransition(true);
    
    try {
      // Create new conversation if needed
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
            parentMessageId: null,
          },
        };
        
        const response = await createConversation(userId!, conversationPayload);
        setCurrentConversation(response.detail);
        
        // Replace temp  message with authoritative messages from server
        setMessages(() => response.detail.messages);
        setConversations(prev => sortByUpdatedAtDesc([response.summary, ...prev]));
        if (setShowAiTransition) setShowAiTransition(true);
        
        // Start streaming inference
        const detailMessages = response.detail.messages || [];
        const replyParentMessageId = detailMessages.length ? detailMessages[detailMessages.length - 1]?.id : undefined;
        if (!replyParentMessageId) {
          throw new Error('Conversation missing first message id.');
        }

        if (streamAbortRef.current) streamAbortRef.current.abort();
        streamAbortRef.current = new AbortController();
        await streamAguiRun({
          userId: userId!,
          conversationId: response.detail.id,
          replyParentMessageId,
          uiBranchPath: response.detail.messages.map((m) => m.id),
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          signal: streamAbortRef.current.signal,
        });
      }

      // Existing conversation: send message normally
      else {
        if (!lastPersistedMessageId) {
          throw new Error('Unable to determine parent message for the new entry.');
        }
        const messagePayload: MessageIn = {
          parentMessageId: lastPersistedMessageId,
          sender: 'user',
          type: attachments.length > 0 ? 'file' : 'text',
          content: currentMessage || undefined,
          attachments: apiAttachments,
        };
        
        const response = await addMessageToConversation(userId!, currentConversation!.id, messagePayload);
        // Replace temp message with API message
        setMessages(prev => prev.map(m => (m.id === tempId ? response.message : m)));
        
        // Touch currentConversation timestamps minimally
        setCurrentConversation(prev =>
          prev ? { ...prev, updated_at: new Date(response.summary.updated_at) } : prev
        );
        // Update sidebar summary and keep ordering
        setConversations(prev => sortByUpdatedAtDesc(prev.map(conv => (conv.id === response.summary.id ? response.summary : conv))));
        if (setShowAiTransition) setShowAiTransition(true);
        const replyParentMessageId = response.message.id;

        if (streamAbortRef.current) streamAbortRef.current.abort();
        streamAbortRef.current = new AbortController();
        await streamAguiRun({
          userId: userId!,
          conversationId: currentConversation!.id,
          replyParentMessageId,
          uiBranchPath: [...activePathIds, response.message.id],
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          signal: streamAbortRef.current.signal,
        });
      }
    } catch (error) {
      // Handle errors: show toast and remove temp message
      console.error('Failed to send message:', error);
      toast({ title: 'Error', description: 'Failed to send message. Please try again.', variant: 'destructive' });
      // Remove any temp message if present
      setMessages((prev) => prev.filter((m) => !String(m.id).startsWith('temp-')));
    } finally {
      streamAbortRef.current = null;
      setIsSendingMessage(false);
      if (setShowAiTransition) setShowAiTransition(false);
    }
  };
  // Handler to abort ongoing streaming
  const handleStopStreaming = () => {
    const controller = streamAbortRef.current;
    if (controller) {
      controller.abort();
      streamAbortRef.current = null;
      setIsSendingMessage(false);
      setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
      if (setShowAiTransition) setShowAiTransition(false);
    }
  };

  const handleDictationStatusChange = (status: DictationStatus) => {
    setDictationStatus((prev) => (prev === status ? prev : status));
  };

  const handleDictationSubmit = async (audioBlob: Blob) => {
    if (!userId) {
      toast({
        title: 'Authentication required',
        description: 'Please sign in again to continue.',
        variant: 'destructive',
      });
      setDictationStatus('idle');
      return;
    }

    setDictationStatus('submitting');
    try {
      const mime = audioBlob.type || 'audio/webm';
      const [, rawExt = 'webm'] = mime.split('/');
      const ext = rawExt.split(';')[0] || rawExt || 'webm';
      const filename = `dictation-${Date.now()}.${ext}`;
      const transcript = await transcribeDictation(userId, audioBlob, filename);
      const trimmedTranscript = transcript.trim();

      if (!trimmedTranscript) {
        toast({
          title: 'No speech detected',
          description: 'The transcription was empty. Please try recording again.',
          variant: 'destructive',
        });
      } else {
        setCurrentMessage((prev) => {
          if (!prev) return trimmedTranscript;
          const needsSeparator = !/\s$/.test(prev);
          return `${prev}${needsSeparator ? ' ' : ''}${trimmedTranscript}`;
        });
        textareaRef?.current?.focus();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice transcription failed. Please try again.';
      toast({
        title: 'Dictation failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setDictationStatus('idle');
    }
  };

  return { handleSendMessage, handleStopStreaming, handleDictationSubmit, handleDictationStatusChange };
}







