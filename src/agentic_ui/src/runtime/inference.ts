import { createConversation, addMessageToConversation, continueSharedConversation } from '@/lib/api';
import type { PlanSnapshot } from '@/lib/agui';
import { convertFileAttachments, sortByUpdatedAtDesc } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment, ToolPreference, InferenceRunStartResponse } from '@/lib/types';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { updateSession } from '@/lib/authStorage';

// Inference handlers own every flow that starts an agent run:
// send, edit-submit, retry, and stop-streaming.
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
  streamAbortRef: MutableRefObject<AbortController | null>;
  persistUIState?: () => void;
  onPlanSnapshot?: (plan: PlanSnapshot) => void;
  resetActivePlan?: () => void;
  beginInferenceRun: (
    conversationId: string,
    request: { parentMessageId: string; messagePath: string[]; enabledTools?: ToolPreference[] },
  ) => Promise<InferenceRunStartResponse>;
  stopActiveInferenceRun?: () => void | Promise<void>;
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
  beginInferenceRun: (
    conversationId: string,
    request: { parentMessageId: string; messagePath: string[]; enabledTools?: ToolPreference[] },
  ) => Promise<InferenceRunStartResponse>;
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
  beginInferenceRun: (
    conversationId: string,
    request: { parentMessageId: string; messagePath: string[]; enabledTools?: ToolPreference[] },
  ) => Promise<InferenceRunStartResponse>;
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
    streamAbortRef,
    enabledTools,
    sharedConversationToken,
    persistUIState,
    onPlanSnapshot,
    resetActivePlan,
    beginInferenceRun,
    stopActiveInferenceRun,
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

        await beginInferenceRun(response.detail.id, {
          parentMessageId: replyParentMessageId,
          messagePath: detailMessages.map((m) => m.id),
          enabledTools,
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

        await beginInferenceRun(response.detail.id, {
          parentMessageId: replyParentMessageId,
          messagePath: detailMessages.map((m) => m.id),
          enabledTools,
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

        await beginInferenceRun(currentConversation!.id, {
          parentMessageId: replyParentMessageId,
          messagePath: [...activePathIds, response.message.id],
          enabledTools,
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
    void stopActiveInferenceRun?.();
    setIsSendingMessage(false);
    setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
    if (setShowAiTransition) setShowAiTransition(false);
    resetActivePlan?.();
  };


  return { handleSendMessage, handleStopStreaming };
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
    beginInferenceRun,
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

      const baseMessages = [...allMessages, newMessage];
      // Build the exact branch lineage the streamed AI reply should appear under.
      const parentPath = buildPathToMessage(baseMessages, parentId);
      await beginInferenceRun(currentConversation.id, {
        parentMessageId: newMessage.id,
        messagePath: [...parentPath, newMessage.id],
        enabledTools,
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
    beginInferenceRun,
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
      if (setShowAiTransition) setShowAiTransition(true);
      const parentPath = buildPathToMessage(allMessages, parentId);
      await beginInferenceRun(currentConversation.id, {
        parentMessageId: parentId,
        messagePath: parentPath,
        enabledTools,
      });
      setBranchSelections((prev) => ({
        ...prev,
        [parentKey]: siblingCount,
      }));
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
