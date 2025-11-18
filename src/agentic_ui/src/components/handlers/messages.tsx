import { useEffect, useRef, useMemo, useCallback } from 'react';
import type { FC, Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { MessageOut, ConversationDetail, ThinkingState, MessageIn } from "@/lib/types";
import { likeMessage as apiLikeMessage, dislikeMessage as apiDislikeMessage, addMessageToConversation } from "@/lib/api";
import { sortByUpdatedAtDesc } from "@/lib/utils";
import { streamAguiRun } from "./agui";


// ------------------------------------------------------------------------------
// Feedback Handlers
// ------------------------------------------------------------------------------
type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

export const createFeedbackHandlers = ({
  userId,
  currentConversation,
  setConversationMessages,
  toast,
}: {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) => {
  const handleLike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      const updated = await apiLikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (error) {
      console.error('Failed to like message:', error);
      toast?.({
        title: 'Could not send feedback',
        description: 'Please try again in a moment.',
        variant: 'destructive',
        duration: 2500,
      });
    }
  };

  const handleDislike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      const updated = await apiDislikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (error) {
      console.error('Failed to dislike message:', error);
      toast?.({
        title: 'Could not send feedback',
        description: 'Please try again in a moment.',
        variant: 'destructive',
        duration: 2500,
      });
    }
  };

  return { handleLike, handleDislike };
};


// ------------------------------------------------------------------------------
// Sticky user action bar that stays visible for a short period
// ------------------------------------------------------------------------------
export function createStickyUserBarHandlers(ctx: { setStickyUserBarId: (id: string | null) => void }) {
  const { setStickyUserBarId } = ctx;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const flashUserActionBar = (id: string, ms = 3000) => {
    setStickyUserBarId(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStickyUserBarId(null), ms);
  };

  return { flashUserActionBar };
}


// ------------------------------------------------------------------------------
// Branch selection handlers
// ------------------------------------------------------------------------------
type BranchSelections = Record<string, number>;

type BranchingHandlersCtx = {
  messages?: MessageOut[];
  branchSelections: BranchSelections;
  setBranchSelections: Dispatch<SetStateAction<BranchSelections>>;
  rootKey?: string;
};

export function useBranchingHandlers({
  messages,
  branchSelections,
  setBranchSelections,
  rootKey = '__root__',
}: BranchingHandlersCtx) {
  const { activeMessages, branchChildrenMap } = useMemo(() => {
    const allMessages = messages ?? [];
    if (!allMessages.length) {
      return {
        activeMessages: [] as MessageOut[],
        branchChildrenMap: {} as Record<string, MessageOut[]>,
      };
    }

    const byParent = new Map<string | null, MessageOut[]>();
    for (const message of allMessages) {
      const key = message.parentMessageId ?? null;
      if (!byParent.has(key)) {
        byParent.set(key, []);
      }
      byParent.get(key)!.push(message);
    }

    const selectChild = (parentId: string | null, options: MessageOut[]) => {
      if (!options.length) return undefined;
      const selectionKey = parentId ?? rootKey;
      const desiredIndex = branchSelections[selectionKey] ?? 0;
      const clampedIndex = Math.min(Math.max(desiredIndex, 0), options.length - 1);
      return options[clampedIndex];
    };

    const visited = new Set<string>();
    const activePath: MessageOut[] = [];
    const traverse = (node?: MessageOut) => {
      if (!node || visited.has(node.id)) return;
      visited.add(node.id);
      activePath.push(node);
      const children = byParent.get(node.id) ?? [];
      if (!children.length) return;
      traverse(selectChild(node.id, children));
    };

    const roots = byParent.get(null) ?? [];
    const rootNode = selectChild(null, roots) ?? roots[0];
    if (rootNode) {
      traverse(rootNode);
    }

    const branchRecord: Record<string, MessageOut[]> = {};
    byParent.forEach((value, key) => {
      branchRecord[key ?? rootKey] = value;
    });

    return {
      activeMessages: activePath.length ? activePath : allMessages,
      branchChildrenMap: branchRecord,
    };
  }, [messages, branchSelections, rootKey]);

  const handleBranchSelectionChange = useCallback(
    (parentId: string | null, index: number) => {
      setBranchSelections(prev => {
        const key = parentId ?? rootKey;
        if (prev[key] === index) return prev;
        return { ...prev, [key]: index };
      });
    },
    [setBranchSelections, rootKey]
  );

  const activeBranchPath = useMemo(
    () => (activeMessages ?? []).map((msg) => msg.id),
    [activeMessages]
  );

  return { activeMessages, branchChildrenMap, handleBranchSelectionChange, activeBranchPath };
}


// ------------------------------------------------------------------------------
// UI Handlers (copy + image preview)
// ------------------------------------------------------------------------------
type UIHandlersCtx = {
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  setCopiedId: (id: string | null) => void;
  setSelectedImage?: (value: string | null) => void;
};

export function createUIHandlers(ctx: UIHandlersCtx) {
  const { toast, setCopiedId, setSelectedImage } = ctx;

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const handleImageClick = (imageUrl: string) => {
    setSelectedImage?.(imageUrl);
  };

  const handleCloseImagePreview = () => {
    setSelectedImage?.(null);
  };

  return { handleCopy, handleImageClick, handleCloseImagePreview };
}


// ------------------------------------------------------------------------------
// AI Transition Indicator
// ------------------------------------------------------------------------------
type AiTransitionHandlersCtx = {
  showAiTransition: boolean;
  thinkingState: ThinkingState | null;
  activeBranchPath?: string[];
};

const isBranchPathVisible = (branchPath?: string[], activePath?: string[]) => {
  if (!branchPath || branchPath.length === 0) return true;
  if (!activePath || activePath.length < branchPath.length) return false;
  for (let i = 0; i < branchPath.length; i += 1) {
    if (branchPath[i] !== activePath[i]) {
      return false;
    }
  }
  return true;
};

export function createAiTransitionHandlers(ctx: AiTransitionHandlersCtx) {
  const { showAiTransition, thinkingState, activeBranchPath } = ctx;

  const AiTransitionIndicator: FC = () => {
    const branchVisible = isBranchPathVisible(thinkingState?.branchPath, activeBranchPath);
    if (!showAiTransition || thinkingState?.isActive || !branchVisible) {
      return null;
    }

    return (
      <div className="flex justify-start pl-2">
        <div className="size-3 rounded-full bg-white/90 shadow-sm transform-gpu motion-safe:animate-pulse-scale" />
      </div>
    );
  };

  return { AiTransitionIndicator };
}


// ------------------------------------------------------------------------------
// Message Edit Handlers
// ------------------------------------------------------------------------------
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
};


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
  } = ctx;

  const handleSubmitMessageEdit = async ({
    targetMessageId,
    newContent,
  }: {
    targetMessageId: string;
    newContent: string;
  }) => {
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
    const siblingCount = allMessages.filter((m) => (m.parentMessageId ?? null) === parentId).length;

    try {
      setIsSendingMessage?.(true);
      const payload: MessageIn = {
        sender: 'user',
        type: 'text',
        parentMessageId: parentId,
        content: trimmed,
      };

      const response = await addMessageToConversation(userId, currentConversation.id, payload);
      const newMessage = response.message;

      setConversationMessages((prev) => [...prev, newMessage]);

      setCurrentConversation((prev: ConversationDetail | null) =>
        prev ? { ...prev, updated_at: new Date(response.summary.updated_at) } : prev,
      );
      setConversations((prev) =>
        sortByUpdatedAtDesc(prev.map((conv) => (conv.id === response.summary.id ? response.summary : conv))),
      );

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
      const branchMessagePath = [...parentPath, newMessage.id];

      await streamAguiRun({
        userId,
        conversationId: currentConversation.id,
        replyParentMessageId: newMessage.id,
        uiBranchPath: branchMessagePath,
        setMessages: setConversationMessages,
        setThinkingState,
        setCurrentConversation,
        setConversations,
        toast,
        setShowAiTransition,
        signal: streamAbortRef.current.signal,
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
      setIsSendingMessage?.(false);
      if (setShowAiTransition) setShowAiTransition(false);
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
    const targetId = editingMessageId;
    const draftSnapshot = editingDraft;
    setEditingBusy(true);
    setEditingMessageId(null);
    setEditingDraft("");
    try {
      await handleSubmitMessageEdit({
        targetMessageId: targetId,
        newContent: draftSnapshot,
      });
    } catch (error) {
      // Restore editing state if submission failed so the user can try again
      setEditingMessageId(targetId);
      setEditingDraft(draftSnapshot);
      throw error;
    } finally {
      setEditingBusy(false);
    }
  };

  return { handleSubmitMessageEdit, handleConfirmEditMessage };
}

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
};

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
  } = ctx;

  const handleRetryAiMessage = async (message: MessageOut) => {
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
    const tempId = `retry-${Date.now()}`;

    const placeholder: MessageOut = {
      id: tempId,
      sender: 'ai',
      type: 'text',
      content: '',
      parentMessageId: parentId ?? undefined,
      created_at: new Date(),
      updated_at: new Date(),
      attachments: [],
    } as MessageOut;

    const parentKey = parentId ?? rootBranchKey;

    try {
      setIsSendingMessage?.(true);
      setConversationMessages((prev) => [...prev, placeholder]);
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
      const uiBranchPath = [...parentPath, tempId];

      await streamAguiRun({
        userId,
        conversationId: currentConversation.id,
        replyParentMessageId: parentId,
        uiBranchPath,
        serverBranchPath: parentPath,
        setMessages: setConversationMessages,
        setThinkingState,
        setCurrentConversation,
        setConversations,
        toast,
        setShowAiTransition,
        signal: streamAbortRef.current.signal,
        prefillMessageId: tempId,
      });
    } catch (error) {
      console.error('Failed to retry AI message', error);
      setConversationMessages((prev) => prev.filter((m) => m.id !== tempId));
      toast({
        title: 'Failed to retry message',
        description: 'Please try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setIsSendingMessage?.(false);
      if (setShowAiTransition) setShowAiTransition(false);
    }
  };

  return { handleRetryAiMessage };
}
