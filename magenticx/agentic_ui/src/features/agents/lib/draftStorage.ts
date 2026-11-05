/**
 * The builder's autosave: the draft in `localStorage` under
 * `agent-draft:<userId>:<agentId|new>`, so a closed tab, a reload or a Back
 * press is not the end of an hour's work.
 *
 * Purely a convenience: every access is wrapped, and a browser that blocks
 * storage (private mode, a full quota, a policy) simply gets no restore banner.
 * A stored entry is checked for shape before it is offered — it was written by
 * some earlier build of this page, or by hand.
 */
import type { AgentDraft } from "@/shared/lib/types";

export type StoredDraft = { savedAt: number; draft: AgentDraft };

export const draftStorageKey = (userId: string, agentId: string | null) =>
  `agent-draft:${userId}:${agentId || "new"}`;

const looksLikeDraft = (value: unknown): value is AgentDraft => {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.name === "string" &&
    typeof draft.prompt === "string" &&
    typeof draft.model === "string" &&
    Array.isArray(draft.tools) &&
    Array.isArray(draft.skills) &&
    Array.isArray(draft.subagents) &&
    Array.isArray(draft.files)
  );
};

export function readStoredDraft(key: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; draft?: unknown };
    if (typeof parsed?.savedAt !== "number" || !looksLikeDraft(parsed.draft)) return null;
    return { savedAt: parsed.savedAt, draft: parsed.draft };
  } catch {
    return null;
  }
}

export function writeStoredDraft(key: string, draft: AgentDraft, savedAt = Date.now()): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt, draft }));
  } catch {
    // Storage blocked or full: the page works the same, only without a restore.
  }
}

export function clearStoredDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear where nothing could be stored.
  }
}

// The banner's time ("10:42", "Mon 10:42"): shared with the workflow builder's restore banner.
export { formatSavedAt } from "@/shared/lib/savedAt";
