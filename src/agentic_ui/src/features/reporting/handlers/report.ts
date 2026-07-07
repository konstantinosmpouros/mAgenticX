import { reportConversation } from "@/shared/lib/api";
import type { ConversationDetail, ConversationReportPayload, ConversationSummary, MessageOut } from "@/shared/lib/types";
import type { Dispatch, SetStateAction } from "react";

type ToastHandler = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

type ReportDialogOptions = {
  messageId?: string | null;
  messagePreview?: string | null;
  title?: string | null;
};

const mergeConversationSummary = (
  items: ConversationSummary[],
  summary: ConversationSummary,
) => items.map((conversation) => (conversation.id === summary.id ? { ...conversation, ...summary } : conversation));

type ReportHandlersCtx = {
  userId: string | null;
  conversations: ConversationSummary[];
  currentConversation: ConversationDetail | null;
  reportTargetConversationId: string | null;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setArchivedConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setIsReportDialogOpen: Dispatch<SetStateAction<boolean>>;
  setReportTargetConversationId: Dispatch<SetStateAction<string | null>>;
  setReportTargetMessageId: Dispatch<SetStateAction<string | null>>;
  setReportTargetMessagePreview: Dispatch<SetStateAction<string | null>>;
  setReportConversationTitle: Dispatch<SetStateAction<string | null>>;
  setIsSubmittingReport: Dispatch<SetStateAction<boolean>>;
  toast: ToastHandler;
  persistUIState: () => void;
};

export function createReportHandlers(ctx: ReportHandlersCtx) {
  const {
    userId,
    conversations,
    currentConversation,
    reportTargetConversationId,
    setConversations,
    setArchivedConversations,
    setCurrentConversation,
    setIsReportDialogOpen,
    setReportTargetConversationId,
    setReportTargetMessageId,
    setReportTargetMessagePreview,
    setReportConversationTitle,
    setIsSubmittingReport,
    toast,
    persistUIState,
  } = ctx;

  const closeReportDialog = () => {
    setIsReportDialogOpen(false);
    setReportTargetConversationId(null);
    setReportTargetMessageId(null);
    setReportTargetMessagePreview(null);
    setReportConversationTitle(null);
    setIsSubmittingReport(false);
  };

  const openReportDialog = (conversationId: string, options?: ReportDialogOptions) => {
    setReportTargetConversationId(conversationId);
    setReportTargetMessageId(options?.messageId ?? null);
    setReportTargetMessagePreview(options?.messagePreview ?? null);
    setReportConversationTitle(options?.title ?? null);
    setIsReportDialogOpen(true);
  };

  const submitConversationReport = async (
    conversationId: string,
    payload: ConversationReportPayload,
  ) => {
    if (!conversationId) {
      toast({ title: "No conversation selected", description: "Select a conversation to report first.", duration: 2000 });
      return false;
    }
    if (!userId) {
      toast({ title: "Not signed in", description: "You need to be signed in to report conversations.", duration: 2000 });
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
      toast({
        title: payload.messageId ? "Response reported" : "Conversation reported",
        description: payload.messageId
          ? "Thanks. We saved this response report for review."
          : "Thanks. We saved this conversation report for review.",
        duration: 2400,
      });
      persistUIState();
      return true;
    } catch (error) {
      console.error("Failed to report conversation:", error);
      toast({ title: "Failed to submit report", description: "There was an error submitting the report. Please try again.", variant: "destructive", duration: 3000 });
      return false;
    }
  };

  const handleReportConversationFromSidebar = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation || conversation.isReported) {
      return;
    }
    openReportDialog(conversationId, { title: conversation.title ?? null });
  };

  const handleReportCurrentConversation = () => {
    if (!currentConversation?.id || currentConversation.isReported) {
      return;
    }
    openReportDialog(currentConversation.id, { title: currentConversation.title ?? null });
  };

  const handleReportAiMessage = (message: MessageOut) => {
    if (!currentConversation?.id || currentConversation.isReported) {
      return;
    }
    openReportDialog(currentConversation.id, {
      messageId: message.id,
      messagePreview: message.content ?? null,
      title: currentConversation.title ?? null,
    });
  };

  const handleSubmitConversationReport = async (payload: ConversationReportPayload) => {
    if (!reportTargetConversationId) {
      return;
    }
    setIsSubmittingReport(true);
    const success = await submitConversationReport(reportTargetConversationId, payload);
    setIsSubmittingReport(false);
    if (success) {
      closeReportDialog();
    }
  };

  return {
    closeReportDialog,
    openReportDialog,
    submitConversationReport,
    handleReportConversationFromSidebar,
    handleReportCurrentConversation,
    handleReportAiMessage,
    handleSubmitConversationReport,
  };
}
