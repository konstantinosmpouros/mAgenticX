import { Building2 } from 'lucide-react';
import { getConversationDetail, deleteConversation, getConversations, renameConversation, archiveConversation, unarchiveConversation, reportConversation, getArchivedConversations } from '@/lib/api';
import type { Dispatch, SetStateAction } from 'react';
import type { Agent, ConversationDetail, ConversationReportPayload, ConversationSummary, MessageOut } from '@/lib/types';

// Conversation handlers own chat navigation and sidebar state:
// selecting threads, clearing the current chat, pagination, and row-level mutations.
export type ConversationMessagesUpdater =
  | MessageOut[]
  | ((prev: MessageOut[]) => MessageOut[]);

export type SetConversationMessages = (updater: ConversationMessagesUpdater) => void;

export function createConversationMessageSetter({
  agents,
  selectedAgent,
  isPrivateMode,
  setCurrentConversation,
}: {
  agents: Agent[];
  selectedAgent: string;
  isPrivateMode: boolean;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
}): SetConversationMessages {
  return (updater) => {
    setCurrentConversation((prev) => {
      const prevMessages = prev?.messages ?? [];
      const nextMessages =
        typeof updater === 'function'
          ? updater(prevMessages)
          : updater;

      if (prev) {
        // Existing conversation detail only needs its message list swapped in place.
        return { ...prev, messages: nextMessages };
      }
      if (nextMessages.length === 0) return prev;

      // Optimistic flows can need a temporary conversation shell before the server detail arrives.
      const agentMeta = agents.find((agent) => agent.id === selectedAgent);
      const now = new Date();
      return {
        id: '',
        agent:
          agentMeta ?? {
            id: selectedAgent,
            name: agentMeta?.name || 'Unknown agent',
            description: agentMeta?.description ?? '',
            icon: agentMeta?.icon ?? Building2,
            version: agentMeta?.version,
            isActive: agentMeta?.isActive ?? true,
          },
        title: '',
        isPrivate: isPrivateMode,
        created_at: now,
        updated_at: now,
        messages: nextMessages,
      };
    });
  };
}

type ConversationsCtx = {
  userId: string | null;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  currentConversation: ConversationDetail | null;
  handleStopStreaming?: () => void;
  agents: Agent[];
  setInactiveAgentFallback: (agent: Agent | null) => void;

  convPage: number;
  setConvPage: Dispatch<SetStateAction<number>>;
  convHasMore: boolean;
  setConvHasMore: Dispatch<SetStateAction<boolean>>;
  convIsLoadingMore: boolean;
  setConvIsLoadingMore: Dispatch<SetStateAction<boolean>>;
  pageSize: number;
  setArchivedConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  archivedConvPage: number;
  setArchivedConvPage: Dispatch<SetStateAction<number>>;
  archivedConvHasMore: boolean;
  setArchivedConvHasMore: Dispatch<SetStateAction<boolean>>;
  archivedConvIsLoading: boolean;
  setArchivedConvIsLoading: Dispatch<SetStateAction<boolean>>;
  archivedPageSize: number;

  setLoadingConversation: (v: boolean) => void;
  setIsClearing: (v: boolean) => void;
  setSelectedAgent: (v: string) => void;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setIsPrivateMode: (v: boolean) => void;
  setExpandedThinking: (v: Record<string, boolean>) => void;
  setAttachments: (v: File[] | ((prev: File[]) => File[])) => void;
  setCurrentMessage: (v: string) => void;
  setThinkingState?: (v: any) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  onSearch?: () => void;
  persistUIState: () => void;
};

const LOAD_MORE_DELAY_MS = 1200;

const getConversationUpdatedTime = (value: string | Date | undefined | null) => {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const sortConversationSummaries = (items: ConversationSummary[]) =>
  [...items].sort(
    (a, b) => getConversationUpdatedTime(b.updated_at) - getConversationUpdatedTime(a.updated_at)
  );

const mergeConversationSummary = (
  items: ConversationSummary[],
  summary: ConversationSummary,
) => items.map((conversation) => (conversation.id === summary.id ? { ...conversation, ...summary } : conversation));

export function createConversationHandlers(ctx: ConversationsCtx) {
  const {
    userId,
    setConversations,
    currentConversation,
    handleStopStreaming,
    agents,
    setInactiveAgentFallback,
    convPage,
    setConvPage,
    convHasMore,
    setConvHasMore,
    convIsLoadingMore,
    setConvIsLoadingMore,
    pageSize,
    setArchivedConversations,
    archivedConvPage,
    setArchivedConvPage,
    archivedConvHasMore,
    setArchivedConvHasMore,
    archivedConvIsLoading,
    setArchivedConvIsLoading,
    archivedPageSize,
    setLoadingConversation,
    setIsClearing,
    setSelectedAgent,
    setCurrentConversation,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    toast,
    persistUIState,
  } = ctx;


  const clearChatAndStopThinking = (options?: { preserveAgent?: boolean }) => {
    // Reuse one reset path so "new chat", delete-current, and title click behave identically.
    handleStopStreaming?.();
    setIsClearing(true);
    const defaultAgentId =
      agents.find((agent) => agent.isActive)?.id ?? agents[0]?.id ?? "";
    setInactiveAgentFallback(null);
    setTimeout(() => {
      // Clear all transient chat state after the transition begins so the UI can animate cleanly.
      ctx.setThinkingState?.(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage('');
      setCurrentConversation(null);
      setIsPrivateMode(false);
      if (!options?.preserveAgent && defaultAgentId) {
        setSelectedAgent(defaultAgentId);
      }
      // Clear the transition flag shortly after the state swap to avoid abrupt layout jumps.
      setTimeout(() => setIsClearing(false), 150);
      persistUIState();
    }, 200);
  };


  const handleTitleClick = () => {
    // The title acts as a shortcut back to the empty-state composer.
    clearChatAndStopThinking();
  };


  const handleNewChat = () => {
    // "New chat" intentionally shares the exact same reset contract.
    clearChatAndStopThinking();
  };


  const handleConversationSelect = async (conversation: ConversationSummary) => {
    handleStopStreaming?.();
    if (!userId || (ctx as any).loadingConversation) return;
    const CLEAR_DELAY_MS = 200;
    setIsClearing(true);
    setInactiveAgentFallback(null);
    // Delay the loader slightly so the old conversation can fade out before the new one mounts.
    setTimeout(() => setLoadingConversation(true), CLEAR_DELAY_MS);

    setTimeout(async () => {
      try {
        const conversationDetail = await getConversationDetail(userId, conversation.id);
        setTimeout(() => {
          // Apply the fetched detail only after the old chat has visually cleared.
          setSelectedAgent(conversationDetail.agent?.id || "");
          setCurrentConversation(conversationDetail);
          setIsPrivateMode(conversationDetail.isPrivate || false);
          setIsClearing(false);
          setLoadingConversation(false);
          persistUIState();
        }, CLEAR_DELAY_MS);
      } catch (error) {
        console.error('Failed to load conversation:', error);
        toast({ title: 'Failed to load conversation', description: 'There was an error loading the conversation. Please try again.', variant: 'destructive', duration: 3000 });
        setSelectedAgent(conversation.agent?.id || "");
        // Fall back to the summary row so the user still lands on a consistent conversation shell.
        const fallbackDetail: ConversationDetail = {
          ...conversation,
          created_at: new Date(conversation.created_at) as any,
          updated_at: new Date(conversation.updated_at) as any,
          messages: [],
        } as any;
        setCurrentConversation(fallbackDetail);
        setIsPrivateMode(conversation.isPrivate || false);
        setIsClearing(false);
        setLoadingConversation(false);
        persistUIState();
      }
    }, CLEAR_DELAY_MS);
  };


  const handleLoadMoreConversations = async () => {
    if (!userId || convIsLoadingMore || !convHasMore) return;
    setConvIsLoadingMore(true);
    try {
      const nextPage = convPage + 1;
      const items = await getConversations(userId, nextPage, pageSize);
      // Smooth the loading affordance even when the backend responds almost instantly.
      await new Promise<void>((resolve) => setTimeout(resolve, LOAD_MORE_DELAY_MS));
      if (!items || items.length === 0) {
        setConvHasMore(false);
      } else {
        setConversations(prev => {
          const ids = new Set(prev.map(c => c.id));
          // Defend against overlap between pages when recent mutations reorder the server list.
          const dedup = items.filter(item => !ids.has(item.id));
          return [...prev, ...dedup];
        });
        persistUIState();
        setConvPage(nextPage);
        if (items.length < pageSize) {
          setConvHasMore(false);
        }
      }
    } catch (error) {
      console.error('Failed to load more conversations:', error);
      setConvHasMore(false);
    } finally {
      setTimeout(() => setConvIsLoadingMore(false), 120);
    }
  };


  const handleDeleteConversation = async (conversationId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (!userId) return;
    try {
      await deleteConversation(userId, conversationId);
      // Remove the row locally as soon as the delete succeeds so sidebar and detail stay aligned.
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (conversationId === currentConversation?.id) clearChatAndStopThinking();
      toast({ title: 'Conversation deleted', description: 'The conversation has been removed from your history', duration: 2000 });
      persistUIState();
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast({ title: 'Failed to delete conversation', description: 'There was an error deleting the conversation. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };


  const handleDeleteCurrentConversation = () => {
    if (!currentConversation?.id) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to delete first.', duration: 2000 });
      return;
    }
    // Route toolbar deletion through the shared delete logic.
    void handleDeleteConversation(currentConversation.id);
  };


  const handleRenameConversation = async (conversationId: string, newTitle: string) => {
    const trimmed = (newTitle || "").trim();
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to rename first.', duration: 2000 });
      return;
    }
    if (!trimmed) {
      toast({ title: 'Title required', description: 'Please enter a new title to rename this conversation.', duration: 2000 });
      return;
    }
    if (!userId) {
      toast({ title: 'Not signed in', description: 'You need to be signed in to rename conversations.', duration: 2000 });
      return;
    }
    try {
      const summary = await renameConversation(userId, conversationId, trimmed);
      setConversations(prev => {
        const updated = prev.map((c) =>
          c.id === summary.id ? { ...c, ...summary } : c
        );
        // Keep the list sorted by recent updates so the renamed chat stays current.
        return sortConversationSummaries(updated);
      });
      setCurrentConversation(prev => {
        if (!prev || prev.id !== summary.id) return prev;
        // Mirror the rename into the open detail view without forcing a refetch.
        return {
          ...prev,
          title: summary.title ?? prev.title,
          updated_at: new Date(summary.updated_at),
          agent: summary.agent ?? prev.agent,
        };
      });
      persistUIState();
    } catch (error) {
      console.error('Failed to rename conversation:', error);
      toast({
        title: 'Failed to rename conversation',
        description: 'There was an error renaming the conversation. Please try again.',
        variant: 'destructive',
        duration: 3000,
      });
    }
  };


  const handleArchiveConversation = async (conversationId?: string | null) => {
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to archive first.', duration: 2000 });
      return;
    }
    if (!userId) {
      toast({ title: 'Not signed in', description: 'You need to be signed in to archive conversations.', duration: 2000 });
      return;
    }
    try {
      const summary = await archiveConversation(userId, conversationId);
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      setArchivedConversations(prev => {
        const next = prev.filter((conversation) => conversation.id !== summary.id);
        return [summary, ...next];
      });
      if (conversationId === currentConversation?.id) {
        clearChatAndStopThinking();
      }
      toast({ title: 'Conversation archived', description: 'The conversation has been moved out of the sidebar.', duration: 2200 });
      persistUIState();
    } catch (error) {
      console.error('Failed to archive conversation:', error);
      toast({ title: 'Failed to archive conversation', description: 'There was an error archiving the conversation. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };


  const handleUnarchiveConversation = async (conversationId?: string | null) => {
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to unarchive first.', duration: 2000 });
      return;
    }
    if (!userId) {
      toast({ title: 'Not signed in', description: 'You need to be signed in to unarchive conversations.', duration: 2000 });
      return;
    }
    try {
      const summary = await unarchiveConversation(userId, conversationId);
      setArchivedConversations(prev => prev.filter((conversation) => conversation.id !== conversationId));
      setConversations(prev => {
        const next = prev.filter((conversation) => conversation.id !== summary.id);
        return sortConversationSummaries([summary, ...next]);
      });
      setCurrentConversation(prev => {
        if (!prev || prev.id !== summary.id) return prev;
        return {
          ...prev,
          title: summary.title ?? prev.title,
          updated_at: new Date(summary.updated_at),
          agent: summary.agent ?? prev.agent,
          isArchived: false,
          archivedAt: null,
        };
      });
      toast({ title: 'Conversation unarchived', description: 'The conversation is back in the sidebar.', duration: 2200 });
      persistUIState();
    } catch (error) {
      console.error('Failed to unarchive conversation:', error);
      toast({ title: 'Failed to unarchive conversation', description: 'There was an error unarchiving the conversation. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };


  const handleArchiveCurrentConversation = () => {
    // Keep current-thread actions as thin wrappers over the shared row-level handlers.
    void handleArchiveConversation(currentConversation?.id);
  };


  const handleUnarchiveCurrentConversation = () => {
    // Keep current-thread actions as thin wrappers over the shared row-level handlers.
    void handleUnarchiveConversation(currentConversation?.id);
  };

  const submitConversationReport = async (
    conversationId: string,
    payload: ConversationReportPayload,
  ) => {
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to report first.', duration: 2000 });
      return false;
    }
    if (!userId) {
      toast({ title: 'Not signed in', description: 'You need to be signed in to report conversations.', duration: 2000 });
      return false;
    }
    try {
      const summary = await reportConversation(userId, conversationId, payload);
      setConversations((prev) => mergeConversationSummary(prev, summary));
      setArchivedConversations((prev) => mergeConversationSummary(prev, summary));
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== summary.id) return prev;
        return {
          ...prev,
          title: summary.title ?? prev.title,
          updated_at: new Date(summary.updated_at),
          agent: summary.agent ?? prev.agent,
          isReported: true,
          reportedAt: summary.reportedAt ?? prev.reportedAt ?? new Date(),
        };
      });
      toast({ title: 'Report submitted', description: 'Thanks. We saved your report for review.', duration: 2400 });
      persistUIState();
      return true;
    } catch (error) {
      console.error('Failed to report conversation:', error);
      toast({ title: 'Failed to submit report', description: 'There was an error submitting the report. Please try again.', variant: 'destructive', duration: 3000 });
      return false;
    }
  };


  const handleOpenSearch = () => {
    if (ctx.onSearch) {
      ctx.onSearch();
      return;
    }
    // If the host shell has no search surface yet, fall back to a product placeholder toast.
    toast({
      title: 'Conversation search coming soon',
      description: 'We’re building a smarter search experience.',
      duration: 2500,
    });
  };


  const loadArchivedConversationPage = async (page: number, options?: { reset?: boolean }) => {
    if (!userId || archivedConvIsLoading) {
      return;
    }

    setArchivedConvIsLoading(true);
    try {
      const items = await getArchivedConversations(userId, page, archivedPageSize);
      setArchivedConversations((prev) => {
        const base = options?.reset ? [] : prev;
        const seen = new Set(base.map((conversation) => conversation.id));
        const nextItems = items.filter((conversation) => !seen.has(conversation.id));
        return [...base, ...nextItems];
      });
      setArchivedConvPage(page);
      setArchivedConvHasMore(items.length >= archivedPageSize);
    } catch (error) {
      console.error('Failed to load archived conversations:', error);
      toast({
        title: 'Failed to load archived chats',
        description: 'There was an error loading archived conversations. Please try again.',
        variant: 'destructive',
        duration: 3000,
      });
      if (options?.reset) {
        setArchivedConversations([]);
      }
      setArchivedConvHasMore(false);
    } finally {
      setArchivedConvIsLoading(false);
    }
  };


  const refreshArchivedConversations = async () => {
    setArchivedConvPage(1);
    setArchivedConvHasMore(true);
    setArchivedConversations([]);
    await loadArchivedConversationPage(1, { reset: true });
  };


  const handleLoadMoreArchivedConversations = async () => {
    if (!archivedConvHasMore || archivedConvIsLoading) {
      return;
    }
    await loadArchivedConversationPage(archivedConvPage + 1);
  };


  return {
    handleConversationSelect,
    handleDeleteConversation,
    handleNewChat,
    handleTitleClick,
    handleLoadMoreConversations,
    clearChatAndStopThinking,
    handleDeleteCurrentConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleArchiveCurrentConversation,
    handleUnarchiveCurrentConversation,
    submitConversationReport,
    handleOpenSearch,
    loadArchivedConversationPage,
    refreshArchivedConversations,
    handleLoadMoreArchivedConversations,
  };
}

