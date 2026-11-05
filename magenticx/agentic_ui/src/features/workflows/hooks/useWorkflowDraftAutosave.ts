import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkflowSpec } from "@/shared/lib/types";
import { sameSpec } from "@/features/workflows/lib/builder/draft";
import {
  clearWorkflowDraft,
  readWorkflowDraft,
  workflowDraftKey,
  writeWorkflowDraft,
  type StoredWorkflowDraft,
} from "@/features/workflows/lib/builder/draftStorage";

const AUTOSAVE_DELAY_MS = 700;

/**
 * Autosave the workflow draft while it has unsaved changes, and offer what an
 * earlier visit left behind — the agent builder's `useDraftAutosave`, for a
 * spec. A draft with no changes stores nothing: opening a workflow (or a new
 * one) and leaving it untouched leaves no trace.
 *
 * On open, a stored draft that differs from what the builder starts with
 * becomes `offer` (the "Restore unsaved changes from 10:42?" banner); one
 * identical to it is just cleared. Nothing is written until the offer is
 * answered, so the stored copy survives until then. `clear` runs after a save,
 * a delete, and on Discard.
 */
export function useWorkflowDraftAutosave({
  userId,
  workflowId,
  spec,
  dirty,
  initial,
}: {
  userId: string | null;
  /** The saved workflow; null for a new one (its draft is stored as `new`). */
  workflowId: string | null;
  spec: WorkflowSpec;
  dirty: boolean;
  /** What the builder starts with, to tell a real leftover from a copy of it. */
  initial: WorkflowSpec;
}) {
  const key = userId ? workflowDraftKey(userId, workflowId) : null;
  const [offer, setOffer] = useState<StoredWorkflowDraft | null>(() => {
    if (!key) return null;
    const stored = readWorkflowDraft(key);
    if (!stored) return null;
    if (sameSpec(stored.spec, initial)) {
      clearWorkflowDraft(key);
      return null;
    }
    return stored;
  });

  const offerOpen = useRef(offer !== null);
  offerOpen.current = offer !== null;
  // Whether this visit stored a draft: edits undone back to the start leave
  // nothing to continue, so that copy goes — but never one an earlier visit left.
  const wrote = useRef(false);

  useEffect(() => {
    if (!key || offerOpen.current) return;
    if (!dirty) {
      if (wrote.current) {
        clearWorkflowDraft(key);
        wrote.current = false;
      }
      return;
    }
    const timer = window.setTimeout(() => {
      writeWorkflowDraft(key, spec);
      wrote.current = true;
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, dirty, spec]);

  const clear = useCallback(() => {
    wrote.current = false;
    if (key) clearWorkflowDraft(key);
  }, [key]);

  /** Close the banner; `discard` also forgets the stored draft. */
  const dismiss = useCallback(
    ({ discard }: { discard: boolean }) => {
      setOffer(null);
      if (discard) clear();
    },
    [clear],
  );

  return { offer, dismiss, clear };
}
