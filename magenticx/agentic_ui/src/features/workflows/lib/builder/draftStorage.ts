/**
 * The workflow builder's autosave, as the agent builder's: the draft spec in
 * `localStorage` under `workflow-draft:<userId>:<workflowId|new>`, so a closed
 * tab, a reload or a Back press does not lose unsaved edits.
 *
 * Purely a convenience: every access is wrapped, and a browser that blocks
 * storage (private mode, a full quota, a policy) simply gets no restore
 * banner. A stored entry is checked for shape before it is offered (one kept
 * before variables became implicit still is; its declared `state` is dropped).
 */
import type { WorkflowSpec } from "@/shared/lib/types";

export type StoredWorkflowDraft = { savedAt: number; spec: WorkflowSpec };

export const workflowDraftKey = (userId: string, workflowId: string | null) =>
  `workflow-draft:${userId}:${workflowId || "new"}`;

const looksLikeSpec = (value: unknown): value is WorkflowSpec => {
  if (!value || typeof value !== "object") return false;
  const spec = value as Record<string, unknown>;
  return (
    spec.version === 1 &&
    typeof spec.name === "string" &&
    Array.isArray(spec.inputs) &&
    Array.isArray(spec.nodes) &&
    Array.isArray(spec.edges)
  );
};

export function readWorkflowDraft(key: string): StoredWorkflowDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; spec?: unknown };
    if (typeof parsed?.savedAt !== "number" || !looksLikeSpec(parsed.spec)) return null;
    const { state: _state, ...spec } = parsed.spec as WorkflowSpec & { state?: unknown };
    return { savedAt: parsed.savedAt, spec };
  } catch {
    return null;
  }
}

export function writeWorkflowDraft(key: string, spec: WorkflowSpec, savedAt = Date.now()): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt, spec }));
  } catch {
    // Storage blocked or full: the builder works the same, only without a restore.
  }
}

export function clearWorkflowDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear where nothing could be stored.
  }
}
