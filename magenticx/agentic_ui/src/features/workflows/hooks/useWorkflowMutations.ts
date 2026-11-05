import { useCallback } from "react";

import { createWorkflow, deleteWorkflow, updateWorkflow } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { toWorkflowValidationIssues } from "@/shared/lib/schemas";
import type { Workflow, WorkflowSpec, WorkflowValidationIssue } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";

export type WorkflowSaveResult =
  | { ok: true; workflow: Workflow }
  /** The server refused the spec (422): its issues, to place on the canvas. */
  | { ok: false; invalid: WorkflowValidationIssue[]; message: string }
  | { ok: false; invalid: null; message: string; error: unknown };

/**
 * The builder's writes: create, save (a new version only if the spec changed)
 * and delete, as the signed-in user. A save never throws: a 422 comes back
 * with the validator's issues, anything else with its message.
 */
export function useWorkflowMutations() {
  const userId = useWorkflowUserId();

  const save = useCallback(
    async (workflowId: string | null, spec: WorkflowSpec): Promise<WorkflowSaveResult> => {
      if (!userId) {
        return { ok: false, invalid: null, message: "You're signed out.", error: null };
      }
      try {
        const workflow = workflowId
          ? await updateWorkflow(userId, workflowId, spec)
          : await createWorkflow(userId, spec);
        return { ok: true, workflow };
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
          const invalid = toWorkflowValidationIssues(error.detailObject?.errors);
          if (invalid.length) return { ok: false, invalid, message: error.message };
        }
        const message = error instanceof Error ? error.message : "The workflow could not be saved.";
        return { ok: false, invalid: null, message, error };
      }
    },
    [userId],
  );

  const remove = useCallback(
    async (workflowId: string): Promise<void> => {
      if (!userId) throw new Error("You're signed out.");
      await deleteWorkflow(userId, workflowId);
    },
    [userId],
  );

  return { save, remove };
}
