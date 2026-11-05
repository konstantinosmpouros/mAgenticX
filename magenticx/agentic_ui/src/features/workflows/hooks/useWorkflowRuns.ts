import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listWorkflowRuns, startWorkflowRun } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import type { WorkflowRun } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";
import { LIVE_RUN_MESSAGE, isLiveRunStatus } from "@/features/workflows/lib/runStatus";

/** While a listed run is not over, the first page is re-read this often (status chips). */
const LIVE_POLL_MS = 5000;

/** Newest first, as the bridge pages them: `fresh` (a re-read first page) wins over `known`. */
function mergeRuns(fresh: WorkflowRun[], known: WorkflowRun[]): WorkflowRun[] {
  const seen = new Set(fresh.map((run) => run.id));
  return [...fresh, ...known.filter((run) => !seen.has(run.id))];
}

/**
 * One workflow's runs for the run picker: newest first, paged (`loadMore`),
 * and `startRun` to launch a new one.
 *
 * `refresh` re-reads the first page and merges it over what is loaded (older
 * pages stay). While any loaded run is still live (queued, running or waiting
 * for an approval) the first page is re-read every few seconds, so statuses in
 * the picker follow along; once all are over the polling stops.
 *
 * `startRun` resolves to the new run's id (the list is refreshed behind it).
 * A 409 — the workflow already has a live run — and every other failure reject
 * with a plain `Error` whose message can be shown as is.
 */
export function useWorkflowRuns(workflowId: string): {
  runs: WorkflowRun[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  refresh: () => void;
  startRun: (inputs: Record<string, unknown>) => Promise<string>;
} {
  const userId = useWorkflowUserId();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Any response from before a workflow/user switch is dropped.
  const scopeRef = useRef(0);
  const loadingMoreRef = useRef(false);
  // Whether a page past the first has been loaded: a first-page refresh then
  // keeps the cursor it already has instead of rewinding "load more".
  const pagedRef = useRef(false);

  const refreshFirstPage = useCallback(async () => {
    const scope = scopeRef.current;
    if (!userId || !workflowId) return;
    try {
      const page = await listWorkflowRuns(userId, workflowId);
      if (scope !== scopeRef.current) return;
      setRuns((known) => mergeRuns(page.items, known));
      if (!pagedRef.current) setNextCursor(page.nextCursor);
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load workflow runs:", err);
    }
  }, [userId, workflowId]);

  useEffect(() => {
    scopeRef.current += 1;
    pagedRef.current = false;
    loadingMoreRef.current = false;
    setRuns([]);
    setNextCursor(null);
    if (!userId || !workflowId) {
      setIsLoading(false);
      return;
    }
    const scope = scopeRef.current;
    setIsLoading(true);
    void refreshFirstPage().finally(() => {
      if (scope === scopeRef.current) setIsLoading(false);
    });
  }, [userId, workflowId, refreshFirstPage]);

  const anyLive = useMemo(() => runs.some((run) => isLiveRunStatus(run.status)), [runs]);
  useEffect(() => {
    if (!anyLive) return;
    const timer = window.setInterval(() => void refreshFirstPage(), LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyLive, refreshFirstPage]);

  const loadMore = useCallback(() => {
    if (!userId || !workflowId || !nextCursor || loadingMoreRef.current) return;
    const scope = scopeRef.current;
    loadingMoreRef.current = true;
    setIsLoading(true);
    listWorkflowRuns(userId, workflowId, nextCursor)
      .then((page) => {
        if (scope !== scopeRef.current) return;
        pagedRef.current = true;
        setRuns((known) => mergeRuns(known, page.items));
        setNextCursor(page.nextCursor);
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.error("Failed to load more workflow runs:", err);
      })
      .finally(() => {
        if (scope !== scopeRef.current) return;
        loadingMoreRef.current = false;
        setIsLoading(false);
      });
  }, [userId, workflowId, nextCursor]);

  const refresh = useCallback(() => {
    void refreshFirstPage();
  }, [refreshFirstPage]);

  const startRun = useCallback(
    async (inputs: Record<string, unknown>): Promise<string> => {
      if (!userId) throw new Error("Sign in to run workflows.");
      let runId: string;
      try {
        runId = await startWorkflowRun(userId, workflowId, inputs);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409)
          throw new Error(err.detail || LIVE_RUN_MESSAGE);
        throw new Error(
          err instanceof Error && err.message ? err.message : "The run could not be started.",
        );
      }
      void refreshFirstPage();
      return runId;
    },
    [userId, workflowId, refreshFirstPage],
  );

  return { runs, hasMore: nextCursor !== null, loadMore, isLoading, refresh, startRun };
}
