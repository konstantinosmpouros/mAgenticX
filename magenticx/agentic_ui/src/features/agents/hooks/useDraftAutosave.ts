import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentDraft } from "@/shared/lib/types";
import {
  clearStoredDraft,
  draftStorageKey,
  readStoredDraft,
  writeStoredDraft,
  type StoredDraft,
} from "@/features/agents/lib/draftStorage";
import { draftSignature } from "@/features/agents/hooks/useAgentDraft";

const AUTOSAVE_DELAY_MS = 700;

/**
 * Autosave the draft while it has unsaved changes, and offer what an earlier
 * visit left behind. A draft with no changes stores nothing: opening a page
 * (or a starter template) and leaving it untouched leaves no trace.
 *
 * On open, a stored draft that differs from what the page starts with becomes
 * `offer` (the "Restore unsaved changes from 10:42?" banner); one identical to
 * it is just cleared. Nothing is written until the offer is answered, so
 * declining it never races a write of the fresh draft, and the stored copy
 * survives until then. `clear` runs after a save and on Discard.
 */
export function useDraftAutosave({
  userId,
  agentId,
  draft,
  dirty,
  initial,
  enabled = true,
  offerStored = true,
}: {
  userId: string | null;
  agentId: string | null;
  draft: AgentDraft;
  dirty: boolean;
  /** What the page starts with, to tell a real leftover from a copy of it. */
  initial: AgentDraft;
  enabled?: boolean;
  /** Offer what an earlier visit stored (not when the page opens on other work, an import). */
  offerStored?: boolean;
}) {
  const key = userId ? draftStorageKey(userId, agentId) : null;
  const [offer, setOffer] = useState<StoredDraft | null>(() => {
    if (!key || !enabled || !offerStored) return null;
    const stored = readStoredDraft(key);
    if (!stored) return null;
    if (draftSignature(stored.draft) === draftSignature(initial)) {
      clearStoredDraft(key);
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
    if (!key || !enabled || offerOpen.current) return;
    if (!dirty) {
      if (wrote.current) {
        clearStoredDraft(key);
        wrote.current = false;
      }
      return;
    }
    const timer = window.setTimeout(() => {
      writeStoredDraft(key, draft);
      wrote.current = true;
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, enabled, dirty, draft]);

  const clear = useCallback(() => {
    if (key) clearStoredDraft(key);
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
