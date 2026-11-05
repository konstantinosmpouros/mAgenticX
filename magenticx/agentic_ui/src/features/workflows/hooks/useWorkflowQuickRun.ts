import { useCallback } from "react";

import { getWorkflow, startWorkflowRun } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import type { WorkflowQuickRunResult } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";
import { needsRunInputs } from "@/features/workflows/lib/inputs";
import { LIVE_RUN_MESSAGE } from "@/features/workflows/lib/runStatus";

/**
 * "Run now" from outside the workflow view (the Automations page's workflow
 * cards). The list holds summaries without a spec, so the workflow is read
 * first: with no required inputs a run starts straight away with none
 * (`{ started: true, runId }`); otherwise — or when the spec cannot be read —
 * nothing starts (`{ started: false }`) and the caller opens the workflow
 * view, whose Run dialog asks for them.
 *
 * Every failure rejects with a plain `Error` whose message can be shown as is
 * (a 409 — a run already in progress — included).
 */
export function useWorkflowQuickRun(): (workflowId: string) => Promise<WorkflowQuickRunResult> {
  const userId = useWorkflowUserId();
  return useCallback(
    async (workflowId: string): Promise<WorkflowQuickRunResult> => {
      if (!userId) throw new Error("Sign in to run workflows.");
      const workflow = await getWorkflow(userId, workflowId);
      if (!workflow.spec || needsRunInputs(workflow.spec.inputs)) return { started: false };
      try {
        const runId = await startWorkflowRun(userId, workflowId, {});
        return { started: true, runId };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409)
          throw new Error(err.detail || LIVE_RUN_MESSAGE);
        throw new Error(
          err instanceof Error && err.message ? err.message : "The run could not be started.",
        );
      }
    },
    [userId],
  );
}
