import { getConversationDetail, deleteConversation, getConversations, renameConversation } from '@/lib/api';
import type { Dispatch, SetStateAction } from 'react';
import type { Agent, ConversationDetail, ConversationSummary } from '@/lib/types';

type ConversationsCtx = {
  userId: string | null;
  conversations: ConversationSummary[];
  setConversations: (updater: (prev: ConversationSummary[]) => ConversationSummary[]) => void;
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

  setLoadingConversation: (v: boolean) => void;
  setIsClearing: (v: boolean) => void;
  setSelectedAgent: (v: string) => void;
  setCurrentConversation: (v: ConversationDetail | null) => void;
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

export function createConversationHandlers(ctx: ConversationsCtx) {
  const {
    userId,
    conversations,
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
    handleStopStreaming?.();
    setIsClearing(true);
    const defaultAgentId =
      agents.find((agent) => agent.isActive)?.id ?? agents[0]?.id ?? "";
    setInactiveAgentFallback(null);
    setTimeout(() => {
      ctx.setThinkingState?.(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage('');
      setCurrentConversation(null);
      setIsPrivateMode(false);
      if (!options?.preserveAgent && defaultAgentId) {
        setSelectedAgent(defaultAgentId);
      }
      setTimeout(() => setIsClearing(false), 150);
      persistUIState();
    }, 200);
  };


  const handleTitleClick = () => {
    clearChatAndStopThinking();
  };


  const handleNewChat = () => {
    clearChatAndStopThinking();
  };


  const handleConversationSelect = async (conversation: ConversationSummary) => {
    handleStopStreaming?.();
    if (!userId || (ctx as any).loadingConversation) return;
    const CLEAR_DELAY_MS = 200;
    setIsClearing(true);
    setInactiveAgentFallback(null);
    setTimeout(() => setLoadingConversation(true), CLEAR_DELAY_MS);

    setTimeout(async () => {
      try {
        const conversationDetail = await getConversationDetail(userId, conversation.id);
        setTimeout(() => {
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
      await new Promise<void>((resolve) => setTimeout(resolve, LOAD_MORE_DELAY_MS));
      if (!items || items.length === 0) {
        setConvHasMore(false);
      } else {
        setConversations(prev => {
          const ids = new Set(prev.map(c => c.id));
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
      setConversations(conversations.filter(c => c.id !== conversationId) as any);
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
        const toTime = (value: string) => {
          const ts = new Date(value).getTime();
          return Number.isFinite(ts) ? ts : 0;
        };
        const updated = prev.map((c) =>
          c.id === summary.id ? { ...c, ...summary } : c
        );
        // Keep the list sorted by recent updates so the renamed chat stays current.
        return [...updated].sort(
          (a, b) => toTime(b.updated_at) - toTime(a.updated_at)
        );
      });
      setCurrentConversation(prev => {
        if (!prev || prev.id !== summary.id) return prev;
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


  const handleArchiveConversation = (conversationId?: string | null) => {
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to archive first.', duration: 2000 });
      return;
    }
    toast({ title: 'Archive coming soon', description: 'Conversation archiving is not available yet.', duration: 2500 });
  };


  const handleReportConversation = (conversationId?: string | null) => {
    if (!conversationId) {
      toast({ title: 'No conversation selected', description: 'Select a conversation to report first.', duration: 2000 });
      return;
    }
    toast({ title: 'Report coming soon', description: 'Conversation reporting will be available soon.', duration: 2500 });
  };


  const handleArchiveCurrentConversation = () => {
    handleArchiveConversation(currentConversation?.id);
  };


  const handleReportCurrentConversation = () => {
    handleReportConversation(currentConversation?.id);
  };


  const handleOpenSearch = () => {
    if (ctx.onSearch) {
      ctx.onSearch();
      return;
    }
    toast({
      title: 'Conversation search coming soon',
      description: 'We’re building a smarter search experience.',
      duration: 2500,
    });
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
    handleReportConversation,
    handleArchiveCurrentConversation,
    handleReportCurrentConversation,
    handleOpenSearch,
  };
}

