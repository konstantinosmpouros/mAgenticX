import { useCallback, useMemo, useState } from "react";

import { compactConversation, undoCompaction } from "@/shared/lib/api";
import type { ContextCompactionControl, MessageOut, RunContextUsage } from "@/shared/lib/types";
import { toast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { formatCompactTokens } from "@/shared/lib/utils";
import { MANUAL_COMPACTION_MIN_PERCENT } from "@/features/chat/lib/contextUsage";

type SetConversationMessages = (updater: (prev: MessageOut[]) => MessageOut[]) => void;

/** How long the "Compacted · Undo" toast stays up. The bridge honours an undo
 *  for longer; the toast is the only place it is offered. */
const UNDO_TOAST_MS = 10_000;

/**
 * Compact the conversation from the composer's context ring (plan 34).
 *
 * A click compacts after the visible branch's latest answer: the bridge asks the
 * agent to summarize everything but the last exchange or two, and records the
 * compaction on that answer — which comes back and replaces the local copy, so
 * the divider and the ring's new figure follow from the data. A toast offers
 * Undo while nothing was sent after it.
 *
 * Always the branch on screen: the answer compacted after is the last message
 * of the visible branch. Available only when that is the agent's finished
 * answer, no run is busy, the agent compacts at all (its answers carry a
 * compaction point — LangGraph agents never do), and the context is past
 * MANUAL_COMPACTION_MIN_PERCENT of the window.
 */
export function useConversationCompaction({
  userId,
  conversationId,
  activeMessages,
  context,
  busy,
  setConversationMessages,
}: {
  userId: string | null;
  conversationId: string | null;
  activeMessages: MessageOut[];
  context: RunContextUsage | null;
  busy: boolean;
  setConversationMessages: SetConversationMessages;
}): ContextCompactionControl | null {
  // Keyed by conversation so switching chats mid-compaction never shows the
  // divider (or holds the composer) in the wrong one.
  const [running, setRunning] = useState<{ conversationId: string; messageId: string } | null>(null);

  const leaf = activeMessages.length ? activeMessages[activeMessages.length - 1] : null;
  const compactingMessageId =
    running && running.conversationId === conversationId ? running.messageId : null;

  const disabledReason = useMemo(() => {
    if (busy) return "Wait for the answer to finish to compact.";
    if (!context?.compactionPercent) return "This agent doesn't compact its context.";
    if (!leaf || leaf.sender !== "ai" || leaf.error) return "You can compact after the agent's answer.";
    if (leaf.streamingStatus && leaf.streamingStatus !== "completed") return "You can compact after a finished answer.";
    // A manual compaction keeps the latest exchange; with only that one on the
    // branch on screen there is nothing older to summarize.
    if (activeMessages.length <= 2) return "There is nothing older than the latest exchange to compact yet.";
    if ((context.percent ?? 0) <= MANUAL_COMPACTION_MIN_PERCENT) {
      return `Compacting is available once the context passes ${MANUAL_COMPACTION_MIN_PERCENT}%.`;
    }
    return null;
  }, [activeMessages.length, busy, context?.compactionPercent, context?.percent, leaf]);

  const replaceMessage = useCallback(
    (updated: MessageOut) =>
      setConversationMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m))),
    [setConversationMessages],
  );

  const undo = useCallback(
    async (targetConversationId: string, messageId: string) => {
      if (!userId) return;
      try {
        replaceMessage(await undoCompaction(userId, targetConversationId, messageId));
        toast({ title: "Compaction undone", variant: "default", duration: 3000 });
      } catch (error) {
        toastError(toast, "Could not undo the compaction", error);
      }
    },
    [replaceMessage, userId],
  );

  const compact = useCallback(() => {
    if (!userId || !conversationId || !leaf || disabledReason || compactingMessageId) return;
    const target = { conversationId, messageId: leaf.id };
    setRunning(target);
    void (async () => {
      try {
        const outcome = await compactConversation(userId, target.conversationId, target.messageId);
        if (outcome.status === "nothing_to_compact") {
          toast({
            title: "Nothing to compact yet",
            description: "The whole conversation fits in the part that is always kept.",
            variant: "info",
          });
          return;
        }
        replaceMessage(outcome.message);
        const freed = outcome.message.compaction?.freed ?? 0;
        toast({
          title: freed > 0 ? `Compacted · ${formatCompactTokens(freed)} tokens freed` : "Compacted",
          variant: "default",
          duration: UNDO_TOAST_MS,
          action: { label: "Undo", onClick: () => void undo(target.conversationId, target.messageId) },
        });
      } catch (error) {
        toastError(toast, "Could not compact the conversation", error);
      } finally {
        setRunning((current) => (current === target ? null : current));
      }
    })();
  }, [compactingMessageId, conversationId, disabledReason, leaf, replaceMessage, undo, userId]);

  if (!userId || !conversationId) return null;
  return {
    status: compactingMessageId ? "compacting" : "idle",
    disabledReason: compactingMessageId ? "Compacting…" : disabledReason,
    compactingMessageId,
    compact,
  };
}
