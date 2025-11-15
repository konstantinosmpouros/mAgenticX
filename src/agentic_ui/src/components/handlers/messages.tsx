import { useEffect, useRef, useMemo, useCallback } from 'react';
import type { FC, Dispatch, SetStateAction } from 'react';
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
// Branch selection handlers
// ------------------------------------------------------------------------------
type BranchSelections = Record<string, number>;

type BranchingHandlersCtx = {
  messages?: MessageOut[];
  branchSelections: BranchSelections;
  setBranchSelections: Dispatch<SetStateAction<BranchSelections>>;
  rootKey?: string;
};

export function useBranchingHandlers({
  messages,
  branchSelections,
  setBranchSelections,
  rootKey = '__root__',
}: BranchingHandlersCtx) {
  const { activeMessages, branchChildrenMap } = useMemo(() => {
    const allMessages = messages ?? [];
    if (!allMessages.length) {
      return {
        activeMessages: [] as MessageOut[],
        branchChildrenMap: {} as Record<string, MessageOut[]>,
      };
    }

    const byParent = new Map<string | null, MessageOut[]>();
    for (const message of allMessages) {
      const key = message.parentMessageId ?? null;
      if (!byParent.has(key)) {
        byParent.set(key, []);
      }
      byParent.get(key)!.push(message);
    }

    const selectChild = (parentId: string | null, options: MessageOut[]) => {
      if (!options.length) return undefined;
      const selectionKey = parentId ?? rootKey;
      const desiredIndex = branchSelections[selectionKey] ?? 0;
      const clampedIndex = Math.min(Math.max(desiredIndex, 0), options.length - 1);
      return options[clampedIndex];
    };

    const visited = new Set<string>();
    const activePath: MessageOut[] = [];
    const traverse = (node?: MessageOut) => {
      if (!node || visited.has(node.id)) return;
      visited.add(node.id);
      activePath.push(node);
      const children = byParent.get(node.id) ?? [];
      if (!children.length) return;
      traverse(selectChild(node.id, children));
    };

    const roots = byParent.get(null) ?? [];
    const rootNode = selectChild(null, roots) ?? roots[0];
    if (rootNode) {
      traverse(rootNode);
    }

    const branchRecord: Record<string, MessageOut[]> = {};
    byParent.forEach((value, key) => {
      branchRecord[key ?? rootKey] = value;
    });

    return {
      activeMessages: activePath.length ? activePath : allMessages,
      branchChildrenMap: branchRecord,
    };
  }, [messages, branchSelections, rootKey]);

  const handleBranchSelectionChange = useCallback(
    (parentId: string | null, index: number) => {
      setBranchSelections(prev => {
        const key = parentId ?? rootKey;
        if (prev[key] === index) return prev;
        return { ...prev, [key]: index };
      });
    },
    [setBranchSelections, rootKey]
  );

  return { activeMessages, branchChildrenMap, handleBranchSelectionChange };
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
