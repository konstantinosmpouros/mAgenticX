import { useEffect, useRef } from 'react';
import type { FC } from 'react';
import type { MessageOut, ConversationDetail, ThinkingState } from "@/lib/types";
import { likeMessage as apiLikeMessage, dislikeMessage as apiDislikeMessage } from "@/lib/api";


// ------------------------------------------------------------------------------
// Feedback Handlers
// ------------------------------------------------------------------------------
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
};

export function createAiTransitionHandlers(ctx: AiTransitionHandlersCtx) {
  const { showAiTransition, thinkingState } = ctx;

  const AiTransitionIndicator: FC = () => {
    if (!showAiTransition || thinkingState?.isActive) return null;

    return (
      <div className="flex justify-start pl-2">
        <div className="size-3 rounded-full bg-white/90 shadow-sm transform-gpu motion-safe:animate-pulse-scale" />
      </div>
    );
  };

  return { AiTransitionIndicator };
}
