import { useCallback, useEffect, useState } from "react";

import { getWorkflow, getWorkflowCatalog } from "@/shared/lib/api";
import type { Workflow, WorkflowNodeKindInfo, WorkflowSchedule } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";

/**
 * One workflow with its spec, plus the node catalogue (labels, groups and
 * branches per kind) the graph needs to draw it. Both load in parallel; the
 * catalogue is decoration, so its failure leaves it empty rather than failing
 * the view — only the workflow's own failure sets `error`. `setSchedule`
 * swaps the loaded workflow's schedule (a pause / resume from its header).
 */
export function useWorkflow(workflowId: string): {
  workflow: Workflow | null;
  catalog: WorkflowNodeKindInfo[];
  isLoading: boolean;
  error: string | null;
  setSchedule: (schedule: WorkflowSchedule | null) => void;
} {
  const userId = useWorkflowUserId();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [catalog, setCatalog] = useState<WorkflowNodeKindInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkflow(null);
    setError(null);
    if (!userId || !workflowId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const workflowRequest = getWorkflow(userId, workflowId);
    const catalogRequest = getWorkflowCatalog().catch(() => [] as WorkflowNodeKindInfo[]);
    workflowRequest
      .then((next) => {
        if (!cancelled) setWorkflow(next);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "The workflow could not be loaded.");
      });
    catalogRequest.then((next) => {
      if (!cancelled) setCatalog(next);
    });
    void Promise.allSettled([workflowRequest, catalogRequest]).then(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, workflowId]);

  const setSchedule = useCallback((schedule: WorkflowSchedule | null) => {
    setWorkflow((current) => (current ? { ...current, schedule } : current));
  }, []);

  return { workflow, catalog, isLoading, error, setSchedule };
}
