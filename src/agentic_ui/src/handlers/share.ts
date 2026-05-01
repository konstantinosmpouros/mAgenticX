import { getConversationDetail, getSharedConversationLinks, revokeSharedConversationLink, shareConversation } from "@/lib/api";
import type { ConversationDetail, ConversationShareListItem, ConversationShareMode, MessageOut } from "@/lib/types";
import type { Dispatch, SetStateAction } from "react";

type ToastHandler = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export const defaultShareExpiresAt = () => {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
};

type ShareConversationHandlersCtx = {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  activeMessages: MessageOut[];
  shareDialogUrl: string | null;
  shareTargetMessage: MessageOut | null;
  shareMode: ConversationShareMode;
  shareForceFullConversation: boolean;
  shareExpiresAt: Date | null;
  isCreatingShareLink: boolean;
  setShareDialogUrl: Dispatch<SetStateAction<string | null>>;
  setShareTargetMessage: Dispatch<SetStateAction<MessageOut | null>>;
  setShareMode: Dispatch<SetStateAction<ConversationShareMode>>;
  setShareForceFullConversation: Dispatch<SetStateAction<boolean>>;
  setShareExpiresAt: Dispatch<SetStateAction<Date | null>>;
  setIsCreatingShareLink: Dispatch<SetStateAction<boolean>>;
  setIsShareCopyPulse: Dispatch<SetStateAction<boolean>>;
  toast: ToastHandler;
  onShareCreated?: (shareUrl: string) => void;
};

export function createShareConversationHandlers(ctx: ShareConversationHandlersCtx) {
  const {
    userId,
    currentConversation,
    activeMessages,
    shareDialogUrl,
    shareTargetMessage,
    shareMode,
    shareForceFullConversation,
    shareExpiresAt,
    isCreatingShareLink,
    setShareDialogUrl,
    setShareTargetMessage,
    setShareMode,
    setShareForceFullConversation,
    setShareExpiresAt,
    setIsCreatingShareLink,
    setIsShareCopyPulse,
    toast,
    onShareCreated,
  } = ctx;

  const handleShareConversation = async (message: MessageOut, mode: ConversationShareMode = "full", expiresAt?: Date | null) => {
    if (!userId || !currentConversation?.id) {
      toast({ title: "No conversation selected", description: "Open a conversation before sharing.", duration: 2000 });
      return;
    }
    if (message.sender !== "ai") {
      toast({ title: "Unable to share", description: "Only AI messages can create a share link.", variant: "destructive", duration: 2500 });
      return;
    }

    try {
      const share = await shareConversation(userId, currentConversation.id, message.id, mode, expiresAt);
      const absoluteUrl =
        typeof window !== "undefined"
          ? new URL(share.shareUrl, window.location.origin).toString()
          : share.shareUrl;
      onShareCreated?.(absoluteUrl);
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(absoluteUrl);
      }
      toast({
        title: "Share link ready",
        description:
          mode === "message"
            ? "The selected response link was copied to your clipboard."
            : mode === "branch"
              ? "The thread-up-to-response link was copied to your clipboard."
              : "The full conversation link was copied to your clipboard.",
        duration: 2600,
      });
    } catch (error) {
      console.error("Failed to share conversation:", error);
      toast({
        title: "Failed to share conversation",
        description: error instanceof Error ? error.message : "Please try again in a moment.",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  const closeShareDialog = () => {
    setShareDialogUrl(null);
    setShareTargetMessage(null);
    setShareMode("full");
    setShareForceFullConversation(false);
    setShareExpiresAt(defaultShareExpiresAt());
    setIsCreatingShareLink(false);
    setIsShareCopyPulse(false);
  };

  const copyShareDialogUrl = () => {
    if (!shareDialogUrl) return;
    void navigator.clipboard?.writeText(shareDialogUrl);
    setIsShareCopyPulse(true);
    toast({ title: "Share link copied", duration: 1800 });
  };

  const openShareDialog = (message: MessageOut) => {
    setShareDialogUrl(null);
    setShareTargetMessage(message);
    setShareMode("full");
    setShareForceFullConversation(false);
    setShareExpiresAt(defaultShareExpiresAt());
    setIsCreatingShareLink(false);
    setIsShareCopyPulse(false);
  };

  const openFullConversationShareDialog = () => {
    if (!currentConversation?.id || currentConversation.id.startsWith("shared:")) {
      toast({
        title: "Unable to share",
        description: "Open one of your conversations before sharing.",
        variant: "destructive",
        duration: 2500,
      });
      return;
    }

    const shareTarget = [...activeMessages]
      .reverse()
      .find((message) => (
        message.sender === "ai" &&
        !String(message.id).startsWith("temp-") &&
        (Boolean(message.content?.trim()) || (message.attachments?.length ?? 0) > 0)
      ));

    if (!shareTarget) {
      toast({
        title: "Unable to share yet",
        description: "Wait for an AI response before sharing the full conversation.",
        variant: "destructive",
        duration: 2500,
      });
      return;
    }

    setShareDialogUrl(null);
    setShareTargetMessage(shareTarget);
    setShareMode("full");
    setShareForceFullConversation(true);
    setShareExpiresAt(defaultShareExpiresAt());
    setIsCreatingShareLink(false);
    setIsShareCopyPulse(false);
  };

  const handleShareModeChange = (mode: ConversationShareMode) => {
    if (shareForceFullConversation) return;
    setShareMode(mode);
    setShareDialogUrl(null);
    setIsShareCopyPulse(false);
  };

  const handleShareExpiresAtChange = (value: Date | null) => {
    setShareExpiresAt(value);
    setShareDialogUrl(null);
    setIsShareCopyPulse(false);
  };

  const handleCreateShareLink = async () => {
    if (!shareTargetMessage || isCreatingShareLink) return;
    setIsCreatingShareLink(true);
    await handleShareConversation(
      shareTargetMessage,
      shareForceFullConversation ? "full" : shareMode,
      shareExpiresAt,
    );
    setIsCreatingShareLink(false);
  };

  return {
    handleShareConversation,
    closeShareDialog,
    copyShareDialogUrl,
    openShareDialog,
    openFullConversationShareDialog,
    handleShareModeChange,
    handleShareExpiresAtChange,
    handleCreateShareLink,
  };
}

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
  toast: ToastHandler;
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
