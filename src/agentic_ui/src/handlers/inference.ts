import { createConversation, addMessageToConversation, continueSharedConversation, transcribeDictation } from '@/lib/api';
import type { PlanSnapshot } from '@/lib/agui';
import { convertFileAttachments, sortByUpdatedAtDesc } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment, ToolPreference } from '@/lib/types';
import { streamAguiRun } from './agui';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { DictationStatus } from '@/components/chat/ChatInputBar';
import { updateSession } from '@/lib/authStorage';

// Inference handlers own every flow that starts an agent run:
// send, edit-submit, retry, stop-streaming, and speech-to-text input.
type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

// Input-bar send flow dependencies.
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
  enabledTools?: ToolPreference[];
  sharedConversationToken?: string;
  
  // setters
  setMessages: (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
  setCurrentMessage: Dispatch<SetStateAction<string>>;
  setAttachments: (v: File[] | ((prev: File[]) => File[])) => void;
  setIsSendingMessage: (v: boolean) => void;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
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
  persistUIState?: () => void;
  onPlanSnapshot?: (plan: PlanSnapshot) => void;
  resetActivePlan?: () => void;
};

// Edit flow dependencies for turning a user message edit into a fresh branch.
type MessageEditHandlersCtx = {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
  setCurrentConversation: (updater: any) => void;
  setConversations: (updater: (prev: any[]) => any[]) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  setThinkingState: (updater: any) => void;
  setShowAiTransition?: (v: boolean) => void;
  streamAbortRef: MutableRefObject<AbortController | null>;
  rootBranchKey: string;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;
  setIsSendingMessage?: (value: boolean) => void;
  enabledTools?: ToolPreference[];
  persistUIState?: () => void;
  onPlanSnapshot?: (plan: PlanSnapshot) => void;
  resetActivePlan?: () => void;
};

// Retry flow dependencies for starting a fresh AI sibling under the same parent prompt.
type RetryHandlersCtx = {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
  setCurrentConversation: (updater: any) => void;
  setConversations: (updater: (prev: any[]) => any[]) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  setThinkingState: (updater: any) => void;
  setShowAiTransition?: (v: boolean) => void;
  streamAbortRef: MutableRefObject<AbortController | null>;
  rootBranchKey: string;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;
  setIsSendingMessage?: (value: boolean) => void;
  enabledTools?: ToolPreference[];
  persistUIState?: () => void;
  onPlanSnapshot?: (plan: PlanSnapshot) => void;
  resetActivePlan?: () => void;
};

// Resolve the lineage from the root message to a specific node.
// Streaming needs this so optimistic UI state matches the branch that the backend is answering on.
const buildPathToMessage = (messages: MessageOut[], messageId: string | null): string[] => {
  if (!messageId) return [];
  const map = new Map(messages.map((m) => [m.id, m]));
  const path: string[] = [];
  let current: MessageOut | undefined = map.get(messageId);
  while (current) {
    path.unshift(current.id);
    if (!current.parentMessageId) {
      break;
    }
    current = map.get(current.parentMessageId);
  }
  return path;
};

// Main entry point for the composer. This wires optimistic user messages,
// placeholder AI rows, and the AG-UI stream into one send pipeline.
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
    enabledTools,
    sharedConversationToken,
    persistUIState,
    onPlanSnapshot,
    resetActivePlan,
  } = ctx;


  const resolveLastPersistedMessageId = () => {
    // Ignore optimistic temp rows when selecting the parent for a new server-side message.
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

    // Ignore empty sends and duplicate submissions while another send is still in flight.
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
    resetActivePlan?.();
    setIsSendingMessage(true);
    // Selected agent metadata is only needed if this send creates a brand new conversation.
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
    // Capture the active path before mutating state so follow-up streaming stays on the visible branch.
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
      rawEvents: [],
      plan: undefined,
      subagents: undefined,
    };
    setMessages(prev => [...prev, tempMessage]);
    setCurrentMessage('');
    setAttachments([]);
    // Show the transition dot while we wait for the backend to start emitting real AG-UI events.
    if (setShowAiTransition) setShowAiTransition(true);
    
    try {
      // Create new conversation if needed
      if (messages.length === 0) {
        if (!currentAgent) {
          throw new Error('No agent selected for new conversation.');
        }
        const conversationPayload: ConversationIn = {
          agentId: currentAgent.id,
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
        persistUIState?.();
        if (setShowAiTransition) setShowAiTransition(true);
        
        // Start streaming inference
        const detailMessages = response.detail.messages || [];
        const replyParentMessageId = detailMessages.length ? detailMessages[detailMessages.length - 1]?.id : undefined;
        if (!replyParentMessageId) {
          throw new Error('Conversation missing first message id.');
        }

        // Create a persisted AI placeholder first so the stream can progressively update the real target row.
        const placeholderPayload: MessageIn = {
          sender: 'ai',
          type: 'text',
          parentMessageId: replyParentMessageId,
          content: '',
        };
        const placeholderResp = await addMessageToConversation(userId!, response.detail.id, placeholderPayload);
        setMessages(prev => [...prev, placeholderResp.message]);
        setCurrentConversation(prev =>
          prev ? { ...prev, updated_at: new Date(placeholderResp.summary.updated_at) } : prev
        );
        setConversations(prev =>
          sortByUpdatedAtDesc(prev.map(conv => (conv.id === placeholderResp.summary.id ? placeholderResp.summary : conv)))
        );
        persistUIState?.();
        // The branch path includes the just-created user row and the staged AI placeholder.
        const branchPath = [...detailMessages.map((m) => m.id), placeholderResp.message.id];

        // Abort any stale controller before creating the stream tied to this send.
        if (streamAbortRef.current) streamAbortRef.current.abort();
        streamAbortRef.current = new AbortController();
        await streamAguiRun({
          userId: userId!,
          conversationId: response.detail.id,
          replyParentMessageId,
          uiBranchPath: branchPath,
          prefillMessageId: placeholderResp.message.id,
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          signal: streamAbortRef.current.signal,
          enabledTools,
          persistUIState,
          onPlanSnapshot,
        });
      }

      // Full shared conversation: first reply imports the share into the user's workspace.
      else if (sharedConversationToken && currentConversation?.id === `shared:${sharedConversationToken}`) {
        const messagePayload: MessageIn = {
          parentMessageId: null,
          sender: 'user',
          type: attachments.length > 0 ? 'file' : 'text',
          content: currentMessage || undefined,
          attachments: apiAttachments,
        };

        const response = await continueSharedConversation(sharedConversationToken, messagePayload);
        setCurrentConversation(response.detail);
        updateSession({ lastConversationId: response.detail.id });
        setMessages(() => response.detail.messages);
        setConversations(prev => sortByUpdatedAtDesc([response.summary, ...prev]));
        persistUIState?.();
        if (setShowAiTransition) setShowAiTransition(true);

        const detailMessages = response.detail.messages || [];
        const replyParentMessageId = detailMessages.length ? detailMessages[detailMessages.length - 1]?.id : undefined;
        if (!replyParentMessageId) {
          throw new Error('Conversation missing imported reply id.');
        }

        const placeholderPayload: MessageIn = {
          sender: 'ai',
          type: 'text',
          parentMessageId: replyParentMessageId,
          content: '',
        };
        const placeholderResp = await addMessageToConversation(userId!, response.detail.id, placeholderPayload);
        setMessages(prev => [...prev, placeholderResp.message]);
        setCurrentConversation(prev =>
          prev ? { ...prev, updated_at: new Date(placeholderResp.summary.updated_at) } : prev
        );
        setConversations(prev =>
          sortByUpdatedAtDesc(prev.map(conv => (conv.id === placeholderResp.summary.id ? placeholderResp.summary : conv)))
        );
        persistUIState?.();

        const branchPath = [...detailMessages.map((m) => m.id), placeholderResp.message.id];

        if (streamAbortRef.current) streamAbortRef.current.abort();
        streamAbortRef.current = new AbortController();
        await streamAguiRun({
          userId: userId!,
          conversationId: response.detail.id,
          replyParentMessageId,
          uiBranchPath: branchPath,
          prefillMessageId: placeholderResp.message.id,
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          enabledTools,
          signal: streamAbortRef.current.signal,
          persistUIState,
          onPlanSnapshot,
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
        persistUIState?.();
        if (setShowAiTransition) setShowAiTransition(true);
        const replyParentMessageId = response.message.id;

        // As with new conversations, stream into a persisted placeholder instead of a purely local row.
        const placeholderPayload: MessageIn = {
          sender: 'ai',
          type: 'text',
          parentMessageId: replyParentMessageId,
          content: '',
        };
        const placeholderResp = await addMessageToConversation(userId!, currentConversation!.id, placeholderPayload);
        setMessages(prev => [...prev, placeholderResp.message]);
        setCurrentConversation(prev =>
          prev ? { ...prev, updated_at: new Date(placeholderResp.summary.updated_at) } : prev
        );
        setConversations(prev =>
          sortByUpdatedAtDesc(prev.map(conv => (conv.id === placeholderResp.summary.id ? placeholderResp.summary : conv)))
        );
        persistUIState?.();
        // Append the new user message and AI placeholder to the current visible branch path.
        const branchPath = [...activePathIds, response.message.id, placeholderResp.message.id];

        if (streamAbortRef.current) streamAbortRef.current.abort();
        streamAbortRef.current = new AbortController();
        await streamAguiRun({
          userId: userId!,
          conversationId: currentConversation!.id,
          replyParentMessageId,
          uiBranchPath: branchPath,
          prefillMessageId: placeholderResp.message.id,
          setMessages,
          setThinkingState,
          setCurrentConversation,
          setConversations,
          toast,
          setShowAiTransition,
          enabledTools,
          signal: streamAbortRef.current.signal,
          persistUIState,
          onPlanSnapshot,
        });
      }
    } catch (error) {
      // Handle errors: show toast and remove temp message
      console.error('Failed to send message:', error);
      toast({ title: 'Error', description: 'Failed to send message. Please try again.', variant: 'destructive' });
      // Remove optimistic rows so a failed send does not leave stray temp items in the thread.
      setMessages((prev) => prev.filter((m) => !String(m.id).startsWith('temp-')));
    } finally {
      // Always release the shared streaming state, even if the failure happened before streaming began.
      streamAbortRef.current = null;
      setIsSendingMessage(false);
      if (setShowAiTransition) setShowAiTransition(false);
      resetActivePlan?.();
    }
  };


  // Handler to abort ongoing streaming
  const handleStopStreaming = () => {
    const controller = streamAbortRef.current;
    if (controller) {
      // Aborting the controller stops both the SSE stream and any UI waiting state tied to it.
      controller.abort();
      streamAbortRef.current = null;
      setIsSendingMessage(false);
      // Mark the thinking state as finished so the UI does not remain stuck in a live reasoning posture.
      setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
      if (setShowAiTransition) setShowAiTransition(false);
      resetActivePlan?.();
    }
  };


  // Handler to update dictation status
  const handleDictationStatusChange = (status: DictationStatus) => {
    // Avoid redundant state writes because the recorder can emit the same status repeatedly.
    setDictationStatus((prev) => (prev === status ? prev : status));
  };


  // Handler to submit dictation audio
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
      // Preserve the browser-provided extension when possible so the backend can sniff audio reliably.
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
        // Append the transcript to any existing draft instead of replacing in-progress typed input.
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


// Editing a user message creates a new user branch and immediately starts a fresh AI run beneath it.
export function createMessageEditHandlers(ctx: MessageEditHandlersCtx) {
  const {
    userId,
    currentConversation,
    setConversationMessages,
    setCurrentConversation,
    setConversations,
    toast,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    rootBranchKey,
    setBranchSelections,
    setIsSendingMessage,
    enabledTools,
    persistUIState,
    onPlanSnapshot,
    resetActivePlan,
  } = ctx;


  const handleSubmitMessageEdit = async ({
    targetMessageId,
    newContent,
  }: {
    targetMessageId: string;
    newContent: string;
  }) => {
    // Edits must become real persisted user messages so branch history stays recoverable across refreshes.
    if (!userId) {
      toast({
        title: 'Authentication required',
        description: 'Please sign in again to continue.',
        variant: 'destructive',
      });
      throw new Error('User is not authenticated');
    }
    if (!currentConversation) {
      toast({
        title: 'No conversation selected',
        description: 'Select a conversation before editing messages.',
        variant: 'destructive',
      });
      throw new Error('No active conversation');
    }

    const trimmed = newContent.trim();
    if (!trimmed) {
      toast({
        title: 'Message cannot be empty',
        description: 'Add some text before submitting your edit.',
        variant: 'destructive',
      });
      throw new Error('Empty edit content');
    }

    const allMessages = currentConversation.messages ?? [];
    const target = allMessages.find((m) => m.id === targetMessageId);
    // Only user-authored messages can be edited into a new branch.
    if (!target || target.sender !== 'user') {
      toast({
        title: 'Unable to edit message',
        description: 'Only existing user messages can be edited.',
        variant: 'destructive',
      });
      throw new Error('Invalid target message');
    }

    const parentId = target.parentMessageId ?? null;
    const parentKey = parentId ?? rootBranchKey;
    // The new edit becomes the newest sibling under the original parent.
    const siblingCount = allMessages.filter((m) => (m.parentMessageId ?? null) === parentId).length;

    try {
      resetActivePlan?.();
      setIsSendingMessage?.(true);
      const payload: MessageIn = {
        sender: 'user',
        type: 'text',
        parentMessageId: parentId,
        content: trimmed,
      };

      const response = await addMessageToConversation(userId, currentConversation.id, payload);
      const newMessage = response.message;

      // Append the edited user message as a new branch sibling rather than mutating historical content.
      setConversationMessages((prev) => [...prev, newMessage]);

      setCurrentConversation((prev: ConversationDetail | null) =>
        prev ? { ...prev, updated_at: new Date(response.summary.updated_at) } : prev,
      );
      setConversations((prev) =>
        sortByUpdatedAtDesc(prev.map((conv) => (conv.id === response.summary.id ? response.summary : conv))),
      );
      persistUIState?.();

      // Switch the visible branch selection to the newly created edited sibling.
      setBranchSelections((prev) => ({
        ...prev,
        [parentKey]: siblingCount,
      }));

      if (setShowAiTransition) setShowAiTransition(true);

      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
      }
      streamAbortRef.current = new AbortController();
      const baseMessages = [...allMessages, newMessage];
      // Build the exact branch lineage the streamed AI reply should appear under.
      const parentPath = buildPathToMessage(baseMessages, parentId);
      const aiPlaceholderPayload: MessageIn = {
        sender: 'ai',
        type: 'text',
        parentMessageId: newMessage.id,
        content: '',
      };
      const aiPlaceholderResp = await addMessageToConversation(userId, currentConversation.id, aiPlaceholderPayload);
      setConversationMessages((prev) => [...prev, aiPlaceholderResp.message]);
      setCurrentConversation((prev: ConversationDetail | null) =>
        prev ? { ...prev, updated_at: new Date(aiPlaceholderResp.summary.updated_at) } : prev,
      );
      setConversations((prev) =>
        sortByUpdatedAtDesc(prev.map((conv) => (conv.id === aiPlaceholderResp.summary.id ? aiPlaceholderResp.summary : conv))),
      );
      persistUIState?.();
      const branchMessagePath = [...parentPath, newMessage.id, aiPlaceholderResp.message.id];

      // Stream the AI reply directly into the staged placeholder for this edited branch.
      await streamAguiRun({
        userId,
        conversationId: currentConversation.id,
        replyParentMessageId: newMessage.id,
        uiBranchPath: branchMessagePath,
        prefillMessageId: aiPlaceholderResp.message.id,
        enabledTools,
        setMessages: setConversationMessages,
        setThinkingState,
        setCurrentConversation,
        setConversations,
        toast,
        setShowAiTransition,
        signal: streamAbortRef.current.signal,
        persistUIState,
        onPlanSnapshot,
      });
    } catch (error) {
      console.error('Failed to submit edited message', error);
      toast({
        title: 'Failed to edit message',
        description: 'Please try again in a moment.',
        variant: 'destructive',
      });
      throw error;
    } finally {
      // Edit submission owns the send/loading flags just like the main composer send flow.
      setIsSendingMessage?.(false);
      if (setShowAiTransition) setShowAiTransition(false);
      resetActivePlan?.();
    }
  };


  const handleConfirmEditMessage = async ({
    editingMessageId,
    editingDraft,
    setEditingMessageId,
    setEditingDraft,
    setEditingBusy,
  }: {
    editingMessageId: string | null;
    editingDraft: string;
    setEditingMessageId: Dispatch<SetStateAction<string | null>>;
    setEditingDraft: Dispatch<SetStateAction<string>>;
    setEditingBusy: Dispatch<SetStateAction<boolean>>;
  }) => {
    if (!editingMessageId) return;
    // Snapshot local edit state up front so we can restore it if persistence or streaming fails.
    const targetId = editingMessageId;
    const draftSnapshot = editingDraft;
    setEditingBusy(true);
    setEditingMessageId(null);
    setEditingDraft('');
    try {
      await handleSubmitMessageEdit({
        targetMessageId: targetId,
        newContent: draftSnapshot,
      });
    } catch (error) {
      // Restore the draft so the user can immediately retry or adjust the edit.
      setEditingMessageId(targetId);
      setEditingDraft(draftSnapshot);
      throw error;
    } finally {
      setEditingBusy(false);
    }
  };


  return { handleSubmitMessageEdit, handleConfirmEditMessage };
}


// Retrying an AI message does not create a new user message; it creates a new AI sibling under the same parent prompt.
export function createRetryHandlers(ctx: RetryHandlersCtx) {
  const {
    userId,
    currentConversation,
    setConversationMessages,
    setCurrentConversation,
    setConversations,
    toast,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    rootBranchKey,
    setBranchSelections,
    setIsSendingMessage,
    enabledTools,
    persistUIState,
    onPlanSnapshot,
    resetActivePlan,
  } = ctx;

  const handleRetryAiMessage = async (message: MessageOut) => {
    // Retries only make sense for assistant messages because the parent prompt already exists.
    if (message.sender !== 'ai') return;
    if (!userId) {
      toast({
        title: 'Authentication required',
        description: 'Please sign in again to continue.',
        variant: 'destructive',
      });
      return;
    }
    if (!currentConversation) {
      toast({
        title: 'No conversation selected',
        description: 'Select a conversation before retrying responses.',
        variant: 'destructive',
      });
      return;
    }

    const parentId = message.parentMessageId ?? null;
    if (!parentId) {
      toast({
        title: 'Unable to retry response',
        description: 'This message is missing a parent prompt.',
        variant: 'destructive',
      });
      return;
    }

    const allMessages = currentConversation.messages ?? [];
    const siblingCount = allMessages.filter((m) => (m.parentMessageId ?? null) === parentId).length;
    const parentKey = parentId ?? rootBranchKey;

    try {
      resetActivePlan?.();
      setIsSendingMessage?.(true);
      // Stage a new persisted AI placeholder that the retry stream will update in place.
      const aiPlaceholderPayload: MessageIn = {
        sender: 'ai',
        type: 'text',
        parentMessageId: parentId,
        content: '',
      };
      const aiPlaceholderResp = await addMessageToConversation(userId, currentConversation.id, aiPlaceholderPayload);
      setConversationMessages((prev) => [...prev, aiPlaceholderResp.message]);
      setCurrentConversation((prev: ConversationDetail | null) =>
        prev ? { ...prev, updated_at: new Date(aiPlaceholderResp.summary.updated_at) } : prev,
      );
      setConversations((prev) =>
        sortByUpdatedAtDesc(prev.map((conv) => (conv.id === aiPlaceholderResp.summary.id ? aiPlaceholderResp.summary : conv))),
      );
      persistUIState?.();
      // Select the new AI sibling so the UI immediately points at the branch being retried.
      setBranchSelections((prev) => ({
        ...prev,
        [parentKey]: siblingCount,
      }));
      if (setShowAiTransition) setShowAiTransition(true);
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
      }
      streamAbortRef.current = new AbortController();
      const parentPath = buildPathToMessage(allMessages, parentId);
      const uiBranchPath = [...parentPath, aiPlaceholderResp.message.id];

      // `serverBranchPath` mirrors the UI path here so the backend and frontend stay on the same retry branch.
      await streamAguiRun({
        userId,
        conversationId: currentConversation.id,
        replyParentMessageId: parentId,
        uiBranchPath,
        serverBranchPath: uiBranchPath,
        setMessages: setConversationMessages,
        setThinkingState,
        setCurrentConversation,
        setConversations,
        toast,
        setShowAiTransition,
        signal: streamAbortRef.current.signal,
        prefillMessageId: aiPlaceholderResp.message.id,
        enabledTools,
        persistUIState,
        onPlanSnapshot,
      });
    } catch (error) {
      console.error('Failed to retry AI message', error);
      toast({
        title: 'Failed to retry message',
        description: 'Please try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      // Retry owns the same send/loading cleanup contract as send and edit-submit.
      setIsSendingMessage?.(false);
      if (setShowAiTransition) setShowAiTransition(false);
      resetActivePlan?.();
    }
  };

  return { handleRetryAiMessage };
}
