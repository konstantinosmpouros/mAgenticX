import { getInferenceStartErrorCopy } from './inferenceErrors';
import { convertFileAttachments } from '@/shared/lib/utils';
import { validateAttachmentsForUpload } from '@/shared/lib/uploadGuards';
import type {
  Agent,
  ConversationDetail,
  MessageIn,
  MessageOut,
  FileAttachment,
  InferenceStartRequest,
  InferenceStartResponse,
} from '@/shared/lib/types';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { updateSession } from '@/shared/lib/authStorage';

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
  isSendingMessage?: boolean;  sharedConversationToken?: string;
  
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
  beginInferenceRun: (request: InferenceStartRequest) => Promise<InferenceStartResponse>;
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
  setIsSendingMessage?: (value: boolean) => void;  persistUIState?: () => void;
  beginInferenceRun: (request: InferenceStartRequest) => Promise<InferenceStartResponse>;
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
  setIsSendingMessage?: (value: boolean) => void;  persistUIState?: () => void;
  beginInferenceRun: (request: InferenceStartRequest) => Promise<InferenceStartResponse>;
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
    streamAbortRef,    sharedConversationToken,
    persistUIState,
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
    setIsSendingMessage(true);
    // Selected agent metadata is only needed if this send creates a brand new conversation.
    const currentAgent = agents.find(a => a.id === selectedAgent);
    
    // Prepare attachments once for the backend-owned start flow.
    const messageAttachments: FileAttachment[] = attachments.map(file => ({
      file,
      url: isImageFile(file) ? getImageUrl(file) : '',
      name: file.name,
      type: file.type,
    }));
    const apiAttachments = await convertFileAttachments(messageAttachments);
    
    const lastPersistedMessageId = resolveLastPersistedMessageId();

    setCurrentMessage('');
    setAttachments([]);

    // Optimistic echo (ChatGPT-style): the user's bubble renders the instant
    // they hit send — before the /start round-trip — with the transition dot
    // pulsing under it. The temp row is replaced wholesale when the server
    // detail lands; on a brand-new chat the message setter builds a temporary
    // conversation shell (empty id) so the hero view swaps immediately too.
    const now = new Date();
    const tempId = `temp-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tempMessage: MessageOut = {
      id: tempId,
      parentMessageId: lastPersistedMessageId,
      sender: 'user',
      content: currentMessage || undefined,
      created_at: now,
      updated_at: now,
      attachments: apiAttachments.map((att, index) => ({
        id: `${tempId}-att-${index}`,
        name: att.name,
        mime: att.mime,
        size: att.size,
        timestamp: now,
        data: att.dataB64,
      })),
    };
    setMessages((prev) => [...prev, tempMessage]);
    // Show the transition dot until the agent's FIRST real signal arrives over
    // the run WebSocket (thinking/tool/content) — not merely until /start returns.
    if (setShowAiTransition) setShowAiTransition(true);

    try {
      // Create new conversation if needed
      if (messages.length === 0) {
        if (!currentAgent) {
          throw new Error('No agent selected for new conversation.');
        }
        await beginInferenceRun({
          mode: "new",
          agentId: currentAgent.id,
          isPrivate: isPrivateMode,
          message: {
            sender: 'user',
            content: currentMessage || undefined,
            attachments: apiAttachments,
            parentMessageId: null,
          },        });
        persistUIState?.();
      }

      // Full shared conversation: first reply imports the share into the user's workspace.
      else if (sharedConversationToken && currentConversation?.id === `shared:${sharedConversationToken}`) {
        const response = await beginInferenceRun({
          mode: "shared_continue",
          sharedConversationToken,
          message: {
            parentMessageId: null,
            sender: 'user',
            content: currentMessage || undefined,
            attachments: apiAttachments,
          },        });
        setCurrentConversation(response.detail);
        setMessages(() => response.detail.messages);
        updateSession({ lastConversationId: response.detail.id });
        persistUIState?.();
      }

      // Existing conversation: send message normally
      else {
        if (!currentConversation) {
          throw new Error('No active conversation for this send.');
        }
        if (!lastPersistedMessageId) {
          throw new Error('Unable to determine parent message for the new entry.');
        }
        const messagePayload: MessageIn = {
          parentMessageId: lastPersistedMessageId,
          sender: 'user',
          content: currentMessage || undefined,
          attachments: apiAttachments,
        };
        
        await beginInferenceRun({
          mode: "send",
          // Per-message agent: this turn goes to the currently-selected agent
          // (falling back to the conversation's last-used agent).
          agentId: currentAgent?.id ?? currentConversation.agent.id,
          conversationId: currentConversation.id,
          parentMessageId: lastPersistedMessageId,
          messagePath: buildPathToMessage(currentConversation.messages ?? messages, lastPersistedMessageId),
          message: messagePayload,        });
        persistUIState?.();
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      // Roll back the optimistic echo so no phantom message survives the failure:
      // drop the temp row, dissolve a temporary conversation shell (empty id)
      // back to the hero view, and put the draft back so nothing the user typed
      // is lost.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setCurrentConversation((prev) => (prev && !prev.id ? null : prev));
      setCurrentMessage(currentMessage);
      setAttachments(attachments);
      if (setShowAiTransition) setShowAiTransition(false);
      const copy = getInferenceStartErrorCopy(error, {
        title: 'Error',
        description: 'Failed to send message. Please try again.',
      });
      toast({ ...copy, variant: 'destructive' });
    } finally {
      // Always release the shared streaming state, even if the failure happened
      // before streaming began. The transition dot is deliberately NOT cleared
      // here on success — it lives until the first agent frame (applyRunEvent).
      streamAbortRef.current = null;
      setIsSendingMessage(false);
    }
  };


  // Handler to abort ongoing streaming
  const handleStopStreaming = () => {
    void stopActiveInferenceRun?.();
    setIsSendingMessage(false);
    setThinkingState((prev: any) => prev ? { ...prev, isActive: false, isDone: true, endTime: Date.now() } : prev);
    if (setShowAiTransition) setShowAiTransition(false);
  };


  return { handleSendMessage, handleStopStreaming };
}


// Editing a user message creates a new user branch and immediately starts a fresh AI run beneath it.
export function createMessageEditHandlers(ctx: MessageEditHandlersCtx) {
  const {
    userId,
    currentConversation,
    toast,
    setShowAiTransition,
    rootBranchKey,
    setBranchSelections,
    setIsSendingMessage,    persistUIState,
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
      setIsSendingMessage?.(true);
      const payload: MessageIn = {
        sender: 'user',
        parentMessageId: parentId,
        content: trimmed,
      };

      if (setShowAiTransition) setShowAiTransition(true);
      await beginInferenceRun({
        mode: 'edit',
        conversationId: currentConversation.id,
        targetMessageId,
        message: payload,      });

      // Switch the visible branch selection to the newly created edited sibling.
      setBranchSelections((prev) => ({
        ...prev,
        [parentKey]: siblingCount,
      }));
      persistUIState?.();
    } catch (error) {
      console.error('Failed to submit edited message', error);
      if (setShowAiTransition) setShowAiTransition(false);
      const copy = getInferenceStartErrorCopy(error, {
        title: 'Failed to edit message',
        description: 'Please try again in a moment.',
      });
      toast({ ...copy, variant: 'destructive' });
      throw error;
    } finally {
      // Edit submission owns the send/loading flags just like the main composer
      // send flow. On success the transition dot stays up until the first agent
      // frame (cleared in applyRunEvent), so it is only reset here on error.
      setIsSendingMessage?.(false);
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
    toast,
    setShowAiTransition,
    rootBranchKey,
    setBranchSelections,
    setIsSendingMessage,    persistUIState,
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
      setIsSendingMessage?.(true);
      if (setShowAiTransition) setShowAiTransition(true);
      const parentPath = buildPathToMessage(allMessages, parentId);
      await beginInferenceRun({
        mode: 'retry',
        conversationId: currentConversation.id,
        targetMessageId: message.id,
        messagePath: parentPath,      });
      setBranchSelections((prev) => ({
        ...prev,
        [parentKey]: siblingCount,
      }));
      persistUIState?.();
    } catch (error) {
      console.error('Failed to retry AI message', error);
      if (setShowAiTransition) setShowAiTransition(false);
      const copy = getInferenceStartErrorCopy(error, {
        title: 'Failed to retry message',
        description: 'Please try again in a moment.',
      });
      toast({ ...copy, variant: 'destructive' });
    } finally {
      // Retry owns the same send/loading cleanup contract as send and edit-submit;
      // the transition dot persists on success until the first agent frame.
      setIsSendingMessage?.(false);
    }
  };

  return { handleRetryAiMessage };
}
