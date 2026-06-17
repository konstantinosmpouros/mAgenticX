import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ConversationDetail, InferenceRun } from "@/lib/types";

type UseActiveRunBranchSnapOptions = {
  currentConversation: ConversationDetail | null;
  activeConversationRun: InferenceRun | null | undefined;
  deriveBranchSelectionsForActiveRun: (detail: ConversationDetail) => Record<string, number> | null;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;
};

// Owns BOTH the reset-on-conversation-change and the snap-to-the-active-run's-
// branch. Sequencing them in one effect means the reset can never clobber a
// fresh snap (they were previously two competing effects firing in the same
// commit, where the reset won). Clearing the run latch on conversation change
// also lets re-entering a still-active conversation re-snap to its branch.
// Covers session-restore, where the conversation detail arrives before
// useInferenceRuns has hydrated `runsByConversation`: the first pass resets to
// an empty map and a later pass snaps once the run appears. The once-per-run
// latch keeps the snap from overriding the user's manual branch navigation.
export function useActiveRunBranchSnap({
  currentConversation,
  activeConversationRun,
  deriveBranchSelectionsForActiveRun,
  setBranchSelections,
}: UseActiveRunBranchSnapOptions) {
  const snappedRunIdRef = useRef<string | null>(null);
  const lastSnapConvIdRef = useRef<string | null>(null);

  useEffect(() => {
    const convId = currentConversation?.id ?? null;
    const convChanged = convId !== lastSnapConvIdRef.current;
    if (convChanged) {
      lastSnapConvIdRef.current = convId;
      snappedRunIdRef.current = null;
    }
    if (
      currentConversation &&
      activeConversationRun &&
      snappedRunIdRef.current !== activeConversationRun.id
    ) {
      const derived = deriveBranchSelectionsForActiveRun(currentConversation);
      if (derived) {
        snappedRunIdRef.current = activeConversationRun.id;
        setBranchSelections((prev) => {
          if (convChanged) return derived;
          const aligned = Object.entries(derived).every(([key, value]) => prev[key] === value);
          return aligned ? prev : { ...prev, ...derived };
        });
        return;
      }
    }
    if (convChanged) {
      setBranchSelections({});
    }
  }, [currentConversation, activeConversationRun, deriveBranchSelectionsForActiveRun, setBranchSelections]);
}
