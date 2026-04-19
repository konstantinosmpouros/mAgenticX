import { useMemo, useCallback } from 'react';
import type { FC, Dispatch, SetStateAction } from 'react';
import type { MessageOut, ConversationDetail, ThinkingState } from "@/lib/types";
import { likeMessage as apiLikeMessage, dislikeMessage as apiDislikeMessage } from "@/lib/api";

// Message handlers cover chat actions that stay within the current UI shell
// and do not start a brand new inference pipeline.


// ------------------------------------------------------------------------------
// Feedback Handlers
// ------------------------------------------------------------------------------
type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

export const createFeedbackHandlers = ({
  userId,
  currentConversation,
  setConversationMessages,
  toast,
}: {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  setConversationMessages: SetConversationMessages;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) => {
  const handleLike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      // Swap only the touched message so feedback updates without reloading the whole thread.
      const updated = await apiLikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (error) {
      console.error('Failed to like message:', error);
      toast?.({
        title: 'Could not send feedback',
        description: 'Please try again in a moment.',
        variant: 'destructive',
        duration: 2500,
      });
    }
  };

  const handleDislike = async (message: MessageOut) => {
    if (!userId || !currentConversation) return;
    try {
      // Like/dislike share the same local update pattern; only the API endpoint differs.
      const updated = await apiDislikeMessage(userId, currentConversation.id, message.id);
      setConversationMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (error) {
      console.error('Failed to dislike message:', error);
      toast?.({
        title: 'Could not send feedback',
        description: 'Please try again in a moment.',
        variant: 'destructive',
        duration: 2500,
      });
    }
  };

  return { handleLike, handleDislike };
};



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
    // Return stable empty collections so callers do not need null checks.
    if (!allMessages.length) {
      return {
        activeMessages: [] as MessageOut[],
        branchChildrenMap: {} as Record<string, MessageOut[]>,
      };
    }

    const byParent = new Map<string | null, MessageOut[]>();
    for (const message of allMessages) {
      // Group siblings by parent id so branch selectors can be resolved at every node.
      const key = message.parentMessageId ?? null;
      if (!byParent.has(key)) {
        byParent.set(key, []);
      }
      byParent.get(key)!.push(message);
    }

    const selectChild = (parentId: string | null, options: MessageOut[]) => {
      if (!options.length) return undefined;
      // Clamp persisted selection indices so retries/deletes cannot push us out of range.
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
      // Only follow the currently selected branch child so the UI renders one linear path.
      traverse(selectChild(node.id, children));
    };

    const roots = byParent.get(null) ?? [];
    // Root selection supports alternate first-message branches too.
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
        // Preserve referential equality when the selection is unchanged.
        if (prev[key] === index) return prev;
        return { ...prev, [key]: index };
      });
    },
    [setBranchSelections, rootKey]
  );

  const activeBranchPath = useMemo(
    () => (activeMessages ?? []).map((msg) => msg.id),
    [activeMessages]
  );

  return { activeMessages, branchChildrenMap, handleBranchSelectionChange, activeBranchPath };
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
      // Track which row was copied so the UI can show transient success state on that message only.
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const handleImageClick = (imageUrl: string) => {
    // The preview modal is driven entirely by the currently selected image url.
    setSelectedImage?.(imageUrl);
  };

  const handleCloseImagePreview = () => {
    // Clearing the selected url is enough to close the shared preview surface.
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
  activeBranchPath?: string[];
};

const isBranchPathVisible = (branchPath?: string[], activePath?: string[]) => {
  if (!branchPath || branchPath.length === 0) return true;
  if (!activePath || activePath.length < branchPath.length) return false;
  for (let i = 0; i < branchPath.length; i += 1) {
    // The transition dot should only appear on the branch currently rendered in the body.
    if (branchPath[i] !== activePath[i]) {
      return false;
    }
  }
  return true;
};

export function createAiTransitionHandlers(ctx: AiTransitionHandlersCtx) {
  const { showAiTransition, thinkingState, activeBranchPath } = ctx;

  const AiTransitionIndicator: FC = () => {
    const branchVisible = isBranchPathVisible(thinkingState?.branchPath, activeBranchPath);
    // Hide the bridge dot once real thinking starts or once the user is looking at a different branch.
    if (!showAiTransition || thinkingState?.isActive || !branchVisible) {
      return null;
    }

    return (
      <div className="flex justify-start pl-2">
        <div className="size-3 rounded-full bg-white/90 shadow-sm transform-gpu motion-safe:animate-pulse-scale" />
      </div>
    );
  };

  return { AiTransitionIndicator };
}
