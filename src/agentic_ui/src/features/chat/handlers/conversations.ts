import { Building2 } from 'lucide-react';
import { getConversationDetail, deleteConversation, getConversations, renameConversation, archiveConversation, unarchiveConversation, getArchivedConversations, forkConversation } from '@/shared/lib/api';
import type { Dispatch, SetStateAction } from 'react';
import type { Agent, ConversationDetail, ConversationSummary, MessageOut } from '@/shared/lib/types';

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
  // The URL is the single source of truth for which conversation is shown.
  // Selecting / creating / clearing a conversation only changes the route;
  // a generation-guarded effect in ChatPage loads the conversation for the
  // current route. Never block navigation on in-flight loads or animations.
  navigate: (to: string) => void;

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
  setSelectedAgent: (v: string) => void;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setBranchSelections?: Dispatch<SetStateAction<Record<string, number>>>;
  setIsPrivateMode: (v: boolean) => void;
  setAttachments: (v: File[] | ((prev: File[]) => File[])) => void;
  setCurrentMessage: (v: string) => void;
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

export function createConversationHandlers(ctx: ConversationsCtx) {
  const {
    userId,
    setConversations,
    currentConversation,
    navigate,
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
    setSelectedAgent,
    setCurrentConversation,
    setBranchSelections,
    setIsPrivateMode,
    setAttachments,
    setCurrentMessage,
    toast,
    persistUIState,
  } = ctx;


  // Going back to the empty new-chat state is just navigating to root. The
  // URL-driven load effect in ChatPage erases conversation state when there is
  // no :conversationId in the route — no timers, no animation gating.
  const clearChatAndStopThinking = () => {
    navigate('/');
  };


  const handleTitleClick = () => {
    // The title acts as a shortcut back to the empty-state composer.
    navigate('/');
  };


  const handleNewChat = () => {
    // "New chat" === navigate to root (empty state).
    navigate('/');
  };


  // Selecting a conversation only changes the URL. The generation-guarded load
  // effect in ChatPage fetches it; the latest navigation always wins, so this
  // is safe to call rapidly / mid-animation (the bug that caused the prior
  // revert was a blocking `if (loadingConversation) return` guard here).
  const handleConversationSelect = (conversation: ConversationSummary) => {
    navigate('/c/' + conversation.id);
  };


  const handleForkConversation = async (message: MessageOut) => {
    if (!userId || !currentConversation?.id) {
      toast({ title: 'No conversation selected', description: 'Open a conversation before forking.', duration: 2000 });
      return;
    }
    if (message.sender !== 'ai') {
      toast({ title: 'Unable to fork', description: 'Only AI messages can start a fork.', variant: 'destructive', duration: 2500 });
      return;
    }

    try {
      setLoadingConversation(true);
      const summary = await forkConversation(userId, currentConversation.id, message.id);
      setConversations(prev => sortConversationSummaries([summary, ...prev.filter(c => c.id !== summary.id)]));

      // Seed the fetched detail so the route's load effect short-circuits
      // (currentConversation.id === :conversationId) instead of refetching,
      // then push the new conversation's URL.
      const detail = await getConversationDetail(userId, summary.id);
      setSelectedAgent(detail.agent?.id || "");
      setCurrentConversation(detail);
      setIsPrivateMode(detail.isPrivate || false);
      setBranchSelections?.({});
      setCurrentMessage('');
      setAttachments([]);
      navigate('/c/' + summary.id);
      toast({ title: 'Conversation forked', duration: 2000 });
      persistUIState();
    } catch (error) {
      console.error('Failed to fork conversation:', error);
      toast({
        title: 'Failed to fork conversation',
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
        variant: 'destructive',
        duration: 3000,
      });
    } finally {
      setLoadingConversation(false);
    }
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
    handleOpenSearch,
    handleForkConversation,
    loadArchivedConversationPage,
    refreshArchivedConversations,
    handleLoadMoreArchivedConversations,
  };
}
