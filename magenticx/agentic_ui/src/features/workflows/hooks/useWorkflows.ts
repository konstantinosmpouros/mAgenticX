import { useCallback, useEffect, useRef, useState } from "react";

import { listWorkflows } from "@/shared/lib/api";
import type { Workflow, WorkflowSchedule } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";

/**
 * The signed-in user's workflows (summaries: no spec), for the sidebar's
 * Workflows section and anything else that lists them.
 *
 * Loaded once per user and again whenever the tab comes back into view — a
 * workflow created through the API (or, later, the builder in another tab)
 * shows up without a reload. `refresh` reloads on demand. `isLoading` is the
 * first load only, so a background reload never flashes a skeleton.
 * `setSchedule` swaps one workflow's schedule in place — a pause / resume,
 * shown before (and corrected by) the server's answer.
 */
export function useWorkflows(): {
  workflows: Workflow[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  setSchedule: (workflowId: string, schedule: WorkflowSchedule | null) => void;
} {
  const userId = useWorkflowUserId();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped per load: only the newest response may land (a user switch, a fast refresh).
  const generationRef = useRef(0);

  const load = useCallback(
    async (showLoading: boolean) => {
      const generation = ++generationRef.current;
      if (!userId) {
        setWorkflows([]);
        setError(null);
        setIsLoading(false);
        return;
      }
      if (showLoading) setIsLoading(true);
      try {
        const next = await listWorkflows(userId);
        if (generation !== generationRef.current) return;
        setWorkflows(next);
        setError(null);
      } catch (err) {
        if (generation !== generationRef.current) return;
        setError(err instanceof Error ? err.message : "Your workflows could not be loaded.");
      } finally {
        if (generation === generationRef.current) setIsLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    setWorkflows([]);
    void load(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      // Drop any response still in flight for this user.
      generationRef.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  const setSchedule = useCallback((workflowId: string, schedule: WorkflowSchedule | null) => {
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === workflowId ? { ...workflow, schedule } : workflow,
      ),
    );
  }, []);

  return { workflows, isLoading, error, refresh, setSchedule };
}
