import { useCallback, useEffect, useState } from "react";

import { useBranchingHandlers } from "@/features/chat/handlers/messages";
import { useStickyUserBarEffect } from "@/features/chat/hooks/useChatEffects";
import type { ConversationDetail, ThinkingState } from "@/shared/lib/types";

/**
 * Branch key for messages with no parent. Shared with `useInferenceRuns`, which
 * hardcodes the same literal when it derives a run's branch — keep them in step.
 */
export const ROOT_BRANCH_KEY = "__root__";

type UseMessageInteractionOptions = {
  currentConversation: ConversationDetail | null;
};

/**
 * The per-message interaction layer: which branch of the tree is on screen, what
 * is being edited, and the transient per-message affordances (thinking block
 * expanded, copy flash, read-aloud, the sticky user action bar).
 *
 * These live together because they are all keyed by message and all reset on a
 * conversation change — and because the branch selection is the input to
 * `useBranchingHandlers`, whose `activeMessages` output is what almost everything
 * downstream actually renders and sends.
 *
 * The run-progress signals (`thinkingState`, `showAiTransition`) are here too,
 * even though they are *written* by the inference layer. They have to be declared
 * before `useInferenceRuns` can be given their setters, and they are read
 * per-message alongside everything else here.
 */
export function useMessageInteraction({ currentConversation }: UseMessageInteractionOptions) {
  // messageId -> explicitly expanded/collapsed. Absent means "use the block's
  // own default", which is why toggling reads the previous value rather than
  // flipping a boolean that may never have been set.
  const [expandedThinking, setExpandedThinking] = useState<{ [key: string]: boolean }>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [showAiTransition, setShowAiTransition] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  const [stickyUserBarId, setStickyUserBarId] = useState<string | null>(null);
  const { flashUserActionBar } = useStickyUserBarEffect({ setStickyUserBarId });

  // parentId -> index of the selected child.
  const [branchSelections, setBranchSelections] = useState<Record<string, number>>({});

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [editingBusy, setEditingBusy] = useState(false);

  const { activeMessages, branchChildrenMap, handleBranchSelectionChange, activeBranchPath } =
    useBranchingHandlers({
      messages: currentConversation?.messages,
      branchSelections,
      setBranchSelections,
      rootKey: ROOT_BRANCH_KEY,
    });

  // Everything keyed to the conversation you were just looking at, dropped when
  // you leave it.
  //
  // The edit draft, because the message id it belongs to does not exist in the
  // next conversation. And the transition dot, because it is a single flag
  // rather than per-conversation state: leaving a conversation mid-run used to
  // carry it along, so the dot pulsed under the last message of whatever
  // conversation you opened next. Clearing here is safe — `useInferenceRuns`
  // re-raises it from the incoming conversation's own active run, if it has one.
  useEffect(() => {
    setEditingMessageId(null);
    setEditingDraft("");
    setEditingBusy(false);
    setShowAiTransition(false);
  }, [currentConversation?.id]);

  // The transition dot bridges DB persistence and the agent's first real signal.
  // Once thinking is live the dot has been superseded.
  useEffect(() => {
    if (thinkingState?.isActive) setShowAiTransition(false);
  }, [thinkingState?.isActive]);

  const toggleThinking = useCallback((messageId: string, next?: boolean) => {
    setExpandedThinking((prev) => ({
      ...prev,
      [messageId]: next ?? !prev[messageId],
    }));
  }, []);

  return {
    // thinking / run progress
    expandedThinking,
    setExpandedThinking,
    toggleThinking,
    thinkingState,
    setThinkingState,
    showAiTransition,
    setShowAiTransition,
    // per-message affordances
    copiedId,
    setCopiedId,
    speakingMessageId,
    setSpeakingMessageId,
    stickyUserBarId,
    flashUserActionBar,
    setStickyUserBarId,
    // branching
    branchSelections,
    setBranchSelections,
    activeMessages,
    branchChildrenMap,
    handleBranchSelectionChange,
    activeBranchPath,
    // editing
    editingMessageId,
    setEditingMessageId,
    editingDraft,
    setEditingDraft,
    editingBusy,
    setEditingBusy,
  };
}
