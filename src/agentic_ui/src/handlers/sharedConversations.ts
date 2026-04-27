import { getConversationDetail, getSharedConversationLinks, revokeSharedConversationLink } from "@/lib/api";
import type { ConversationDetail, ConversationShareListItem } from "@/lib/types";
import type { Dispatch, SetStateAction } from "react";

type SharedConversationHandlersCtx = {
  userId: string | null;
  sharedConversationsPage: number;
  sharedConversationsHasMore: boolean;
  sharedConversationsLoading: boolean;
  pageSize: number;
  setSharedConversations: Dispatch<SetStateAction<ConversationShareListItem[]>>;
  setSharedConversationsPage: Dispatch<SetStateAction<number>>;
  setSharedConversationsHasMore: Dispatch<SetStateAction<boolean>>;
  setSharedConversationsLoading: Dispatch<SetStateAction<boolean>>;
  closeProfilePanel: () => void;
  setLoadingConversation: (value: boolean) => void;
  setSelectedAgent: (value: string) => void;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setIsPrivateMode: (value: boolean) => void;
  setExpandedThinking: (value: Record<string, boolean>) => void;
  setAttachments: (value: File[] | ((prev: File[]) => File[])) => void;
  setCurrentMessage: (value: string) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  persistUIState: () => void;
};

export function createSharedConversationHandlers(ctx: SharedConversationHandlersCtx) {
  const {
    userId,
    sharedConversationsPage,
    sharedConversationsHasMore,
    sharedConversationsLoading,
    pageSize,
    setSharedConversations,
    setSharedConversationsPage,
    setSharedConversationsHasMore,
    setSharedConversationsLoading,
    closeProfilePanel,
    setLoadingConversation,
    setSelectedAgent,
    setCurrentConversation,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    toast,
    persistUIState,
  } = ctx;

  const loadSharedConversationPage = async (page: number, options?: { reset?: boolean }) => {
    if (!userId || sharedConversationsLoading) return;

    setSharedConversationsLoading(true);
    try {
      const items = await getSharedConversationLinks(userId, page, pageSize);
      setSharedConversations((prev) => {
        const base = options?.reset ? [] : prev;
        const seen = new Set(base.map((share) => share.id));
        return [...base, ...items.filter((share) => !seen.has(share.id))];
      });
      setSharedConversationsPage(page);
      setSharedConversationsHasMore(items.length >= pageSize);
    } catch (error) {
      console.error("Failed to load shared conversations:", error);
      toast({
        title: "Failed to load shared links",
        description: "There was an error loading shared conversations. Please try again.",
        variant: "destructive",
        duration: 3000,
      });
      if (options?.reset) setSharedConversations([]);
      setSharedConversationsHasMore(false);
    } finally {
      setSharedConversationsLoading(false);
    }
  };

  const refreshSharedConversations = async () => {
    setSharedConversationsPage(1);
    setSharedConversationsHasMore(true);
    setSharedConversations([]);
    await loadSharedConversationPage(1, { reset: true });
  };

  const handleLoadMoreSharedConversations = async () => {
    if (!sharedConversationsHasMore || sharedConversationsLoading) return;
    await loadSharedConversationPage(sharedConversationsPage + 1);
  };

  const handleOpenSharedConversation = async (share: ConversationShareListItem) => {
    if (!userId) return;
    closeProfilePanel();
    setLoadingConversation(true);
    try {
      const detail = await getConversationDetail(userId, share.conversationId);
      setSelectedAgent(detail.agent?.id || "");
      setCurrentConversation(detail);
      setIsPrivateMode(detail.isPrivate || false);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage("");
      persistUIState();
    } catch (error) {
      console.error("Failed to open shared conversation source:", error);
      toast({
        title: "Failed to open conversation",
        description: "The original conversation could not be loaded.",
        variant: "destructive",
        duration: 3000,
      });
    } finally {
      setLoadingConversation(false);
    }
  };

  const handleRevokeSharedConversation = async (share: ConversationShareListItem) => {
    if (!userId || share.status !== "active") return;
    try {
      await revokeSharedConversationLink(userId, share.conversationId, share.id);
      const revokedAt = new Date();
      setSharedConversations((prev) =>
        prev.map((item) =>
          item.id === share.id
            ? { ...item, isActive: false, status: "revoked", revokedAt }
            : item,
        ),
      );
      toast({ title: "Share link revoked", description: "That link can no longer be accessed.", duration: 2200 });
    } catch (error) {
      console.error("Failed to revoke shared conversation:", error);
      toast({
        title: "Failed to revoke link",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  return {
    refreshSharedConversations,
    handleLoadMoreSharedConversations,
    handleOpenSharedConversation,
    handleRevokeSharedConversation,
  };
}
