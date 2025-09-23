import { getConversationDetail, deleteConversation } from '@/lib/api';
import type { ConversationDetail, ConversationSummary } from '@/lib/types';

type ConversationsCtx = {
  userId: string | null;
  conversations: ConversationSummary[];
  setConversations: (updater: (prev: ConversationSummary[]) => ConversationSummary[]) => void;
  currentConversation: ConversationDetail | null;

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
};

export function createConversationHandlers(ctx: ConversationsCtx) {
  const {
    userId,
    conversations,
    setConversations,
    currentConversation,
    setLoadingConversation,
    setIsClearing,
    setSelectedAgent,
    setCurrentConversation,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    toast,
  } = ctx;

  const clearChatAndStopThinking = () => {
    setIsClearing(true);
    setTimeout(() => {
      ctx.setThinkingState?.(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage('');
      setCurrentConversation(null);
      setIsPrivateMode(false);
      setTimeout(() => setIsClearing(false), 150);
    }, 200);
  };

  const handleTitleClick = () => {
    clearChatAndStopThinking();
  };

  const handleNewChat = () => {
    clearChatAndStopThinking();
  };

  const handleConversationSelect = async (conversation: ConversationSummary) => {
    if (!userId || (ctx as any).loadingConversation) return;
    setLoadingConversation(true);
    setIsClearing(true);

    setTimeout(async () => {
      try {
        const conversationDetail = await getConversationDetail(userId, conversation.id);
        setTimeout(() => {
          setSelectedAgent(conversationDetail.agentId);
          setCurrentConversation(conversationDetail);
          setIsPrivateMode(conversationDetail.isPrivate || false);
          setIsClearing(false);
        }, 100);
      } catch (error) {
        console.error('Failed to load conversation:', error);
        toast({ title: 'Failed to load conversation', description: 'There was an error loading the conversation. Please try again.', variant: 'destructive', duration: 3000 });
        setSelectedAgent(conversation.agentId);
        const fallbackDetail: ConversationDetail = {
          ...conversation,
          created_at: new Date(conversation.created_at) as any,
          updated_at: new Date(conversation.updated_at) as any,
          messages: [],
        } as any;
        setCurrentConversation(fallbackDetail);
        setIsPrivateMode(conversation.isPrivate || false);
        setIsClearing(false);
      } finally {
        setLoadingConversation(false);
      }
    }, 300);
  };

  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!userId) return;
    try {
      await deleteConversation(userId, conversationId);
      setConversations(conversations.filter(c => c.id !== conversationId) as any);
      if (conversationId === currentConversation?.id) clearChatAndStopThinking();
      toast({ title: 'Conversation deleted', description: 'The conversation has been removed from your history', duration: 2000 });
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast({ title: 'Failed to delete conversation', description: 'There was an error deleting the conversation. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };

  return { handleConversationSelect, handleDeleteConversation, handleNewChat, handleTitleClick, clearChatAndStopThinking };
}

