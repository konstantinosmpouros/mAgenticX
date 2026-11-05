import { useCallback, useEffect, useState } from "react";

import { getWorkflowCatalog } from "@/shared/lib/api";
import type { WorkflowNodeKindInfo } from "@/shared/lib/types";

/**
 * The node catalogue for the builder's palette and forms
 * (`GET /v1/workflows/catalog`). Unlike the view, the builder cannot work
 * without it, so a failure is reported (`error`) with a `retry`.
 */
export function useWorkflowCatalog(): {
  catalog: WorkflowNodeKindInfo[];
  isLoading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [catalog, setCatalog] = useState<WorkflowNodeKindInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getWorkflowCatalog()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "The step catalogue could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { catalog, isLoading, error, retry };
}
