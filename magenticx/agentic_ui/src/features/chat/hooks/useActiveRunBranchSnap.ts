import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  branchSelectionsForMessage,
  isPageReload,
  loadBranchSelections,
  reconcileBranchSelections,
  saveBranchSelections,
  type BranchSelections,
} from "@/features/chat/lib/branchMemory";
import type { ConversationDetail, InferenceRun } from "@/shared/lib/types";

type UseActiveRunBranchSnapOptions = {
  currentConversation: ConversationDetail | null;
  activeConversationRun: InferenceRun | null | undefined;
  deriveBranchSelectionsForActiveRun: (detail: ConversationDetail) => Record<string, number> | null;
  branchSelections: BranchSelections;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;
};

/** A reload restores the branch once: the first conversation shown after it. */
let reloadRestorePending = isPageReload();

/** Test seam: start as a fresh page load (`reload` = whether it was a reload). */
export function resetBranchEntryForTests(reload: boolean): void {
  reloadRestorePending = reload;
}

/**
 * Picks the branch a conversation opens on, and remembers it for a reload.
 *
 * On entering a conversation, once its messages are in, in this order:
 *   1. a reload of the tab: the branch the user was reading before it;
 *   2. an active run: that run's branch;
 *   3. background tasks still working: the branch of the answer that started
 *      the latest of them (`activeTaskMessageId`);
 *   4. the branch last read in this tab, else the default.
 *
 * It owns BOTH the reset-on-conversation-change and the snaps. Sequencing them
 * in one effect means the reset can never clobber a fresh snap. Session
 * restore is covered: the detail can arrive before useInferenceRuns has
 * hydrated `runsByConversation`, so a later pass snaps once the run appears
 * (2 outranks 3 and 4, never 1). The once-per-run latch keeps the snap from
 * overriding the user's manual branch navigation.
 */
export function useActiveRunBranchSnap({
  currentConversation,
  activeConversationRun,
  deriveBranchSelectionsForActiveRun,
  branchSelections,
  setBranchSelections,
}: UseActiveRunBranchSnapOptions) {
  const snappedRunIdRef = useRef<string | null>(null);
  const lastSnapConvIdRef = useRef<string | null>(null);
  // Whether this entry's branch has been chosen (needs the messages).
  const entryDoneRef = useRef(false);
  // This entry is the first conversation after a reload of the tab.
  const entryIsReloadRef = useRef(false);
  // The entry's branch came from the reload: an active run must not move it.
  const keepRestoredRef = useRef(false);
  // The previous conversation's selections, still in state for a render after
  // the switch: never remembered under the new conversation's id.
  const staleSelectionsRef = useRef<BranchSelections | null>(null);

  useEffect(() => {
    const convId = currentConversation?.id ?? null;
    const convChanged = convId !== lastSnapConvIdRef.current;
    if (convChanged) {
      lastSnapConvIdRef.current = convId;
      snappedRunIdRef.current = null;
      entryDoneRef.current = false;
      keepRestoredRef.current = false;
      staleSelectionsRef.current = branchSelections;
      entryIsReloadRef.current = Boolean(convId) && reloadRestorePending;
      if (convId) reloadRestorePending = false;
    }
    if (!currentConversation || !convId) {
      if (convChanged) setBranchSelections({});
      return;
    }
    const messages = currentConversation.messages ?? [];
    const entering = !entryDoneRef.current && messages.length > 0;
    // What is in state now is about to be replaced by the entry's choice.
    if (entering) staleSelectionsRef.current = branchSelections;

    if (entering && entryIsReloadRef.current) {
      const stored = loadBranchSelections(convId);
      if (stored) {
        entryDoneRef.current = true;
        keepRestoredRef.current = true;
        setBranchSelections(reconcileBranchSelections(messages, stored));
        return;
      }
    }

    if (
      !keepRestoredRef.current &&
      activeConversationRun &&
      snappedRunIdRef.current !== activeConversationRun.id
    ) {
      const derived = deriveBranchSelectionsForActiveRun(currentConversation);
      if (derived) {
        snappedRunIdRef.current = activeConversationRun.id;
        entryDoneRef.current = true;
        setBranchSelections((prev) => {
          if (convChanged || entering) return derived;
          const aligned = Object.entries(derived).every(([key, value]) => prev[key] === value);
          return aligned ? prev : { ...prev, ...derived };
        });
        return;
      }
    }

    if (entering) {
      entryDoneRef.current = true;
      const taskBranch = currentConversation.hasActiveTasks
        ? branchSelectionsForMessage(messages, currentConversation.activeTaskMessageId)
        : null;
      if (taskBranch) {
        setBranchSelections(taskBranch);
        return;
      }
      const stored = loadBranchSelections(convId);
      setBranchSelections(stored ? reconcileBranchSelections(messages, stored) : {});
      return;
    }
    if (convChanged) setBranchSelections({});
    // `branchSelections` is read only to note the stale value on a switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentConversation,
    activeConversationRun,
    deriveBranchSelectionsForActiveRun,
    setBranchSelections,
  ]);

  // Remember the branch on screen, per conversation, for a reload.
  useEffect(() => {
    const convId = currentConversation?.id ?? null;
    if (!convId || convId.startsWith("shared:") || !entryDoneRef.current) return;
    if (branchSelections === staleSelectionsRef.current) return;
    staleSelectionsRef.current = null;
    saveBranchSelections(convId, branchSelections);
  }, [branchSelections, currentConversation?.id]);
}
