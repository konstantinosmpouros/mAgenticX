import type { MessageOut, ConversationDetail } from "@/lib/types";
import { likeMessage as apiLikeMessage, dislikeMessage as apiDislikeMessage } from "@/lib/api";

type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

export const createFeedbackHandlers = ({
  userId,
  currentConversation,
  setConversationMessages,
}: {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
}) => {
  const handleLike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      const updated = await apiLikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (_) {}
  };

  const handleDislike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      const updated = await apiDislikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (_) {}
  };

  return { handleLike, handleDislike };
};
