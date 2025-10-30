import { useEffect, useRef } from 'react';
import type { MessageOut, ConversationDetail } from "@/lib/types";
import { likeMessage as apiLikeMessage, dislikeMessage as apiDislikeMessage } from "@/lib/api";

type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

export const createFeedbackHandlers = ({
  userId,
  authToken,
  currentConversation,
  setConversationMessages,
}: {
  userId: string | null;
  authToken: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
}) => {
  const handleLike = async (message: MessageOut) => {
    if (!userId || !currentConversation || !authToken) return;
    try {
      const updated = await apiLikeMessage(userId, currentConversation.id, message.id, authToken);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (_) {}
  };

  const handleDislike = async (message: MessageOut) => {
    if (!userId || !currentConversation || !authToken) return;
    try {
      const updated = await apiDislikeMessage(userId, currentConversation.id, message.id, authToken);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (_) {}
  };

  return { handleLike, handleDislike };
};

// Sticky user action bar that stays visible for a short period
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
