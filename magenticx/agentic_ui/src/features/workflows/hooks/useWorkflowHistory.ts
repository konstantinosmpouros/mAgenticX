import { useCallback, useEffect, useRef, useState } from "react";

import { getWorkflowVersion, listWorkflowVersions, restoreWorkflowVersion } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { toWorkflowValidationIssues } from "@/shared/lib/schemas";
import { toastError } from "@/shared/lib/toast";
import { toast } from "@/shared/hooks/use-toast";
import type { Workflow, WorkflowVersionDetail, WorkflowVersionSummary } from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";

/** Why a restore was refused, with the server's issues when it sent them (a 422). */
export type WorkflowRestoreFailure = { versionNo: number; message: string; issues: string[] };

export type WorkflowHistoryHandlers = {
  /** The kept versions loaded so far, newest first; null until the first page answers. */
  versions: WorkflowVersionSummary[] | null;
  loading: boolean;
  /** The list could not be loaded; the panel offers a retry. */
  error: string | null;
  reload: () => Promise<void>;
  /** Older versions are left to load ("Show older versions"). */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;

  /** Versions loaded whole, by number (a kept version never changes). */
  details: Record<number, WorkflowVersionDetail>;
  failedVersions: ReadonlySet<number>;
  loadVersion: (versionNo: number) => Promise<void>;

  restoringVersion: number | null;
  restoreFailure: WorkflowRestoreFailure | null;
  clearRestoreFailure: () => void;
  /** Resolves to the workflow as restored (its newest version), or null when refused. */
  restore: (versionNo: number) => Promise<Workflow | null>;
};

/** A 422's issues as lines, each led by its step's id when it names one. */
const issuesOf = (error: unknown): string[] => {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
  return toWorkflowValidationIssues(error.detailObject?.errors).map((issue) =>
    issue.nodeId ? `${issue.nodeId}: ${issue.message}` : issue.message,
  );
};

/**
 * One workflow's kept versions for the builder's History panel (the agent
 * history's `useAgentHistory`, for workflows): the list a page at a time,
 * each version's spec loaded on demand and kept by number, and restoring one.
 *
 * Nothing loads until `enabled` (the panel is open on a saved workflow), so
 * opening the builder costs no history request. A restore is a save on the
 * server — the old spec becomes a NEW version — so after one the list is
 * read again from the top and the caller gets the workflow to load.
 */
export function useWorkflowHistory({
  workflowId,
  enabled,
}: {
  workflowId: string | null;
  enabled: boolean;
}): WorkflowHistoryHandlers {
  const userId = useWorkflowUserId();
  const [versions, setVersions] = useState<WorkflowVersionSummary[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<number, WorkflowVersionDetail>>({});
  const [failedVersions, setFailedVersions] = useState<Set<number>>(new Set());
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<WorkflowRestoreFailure | null>(null);
  // Refs, not state, for the in-flight guards: two clicks in one tick both read
  // the same un-rendered state and would each fire a request.
  const detailsInFlight = useRef<Set<number>>(new Set());
  const restoreInFlight = useRef(false);
  // Answers for another workflow (or user) than the current one are dropped.
  const scopeKey = `${userId}::${workflowId}`;
  const scope = useRef(scopeKey);

  const reload = useCallback(async () => {
    if (!enabled || !userId || !workflowId) return;
    const mine = `${userId}::${workflowId}`;
    setLoading(true);
    try {
      const page = await listWorkflowVersions(userId, workflowId);
      if (scope.current !== mine) return;
      setVersions(page.items);
      setNextBefore(page.nextBefore);
      setError(null);
    } catch (err) {
      if (scope.current !== mine) return;
      setError(err instanceof Error && err.message ? err.message : "Could not load the history.");
    } finally {
      if (scope.current === mine) setLoading(false);
    }
  }, [enabled, userId, workflowId]);

  // A new workflow or user: nothing from the previous one may show.
  useEffect(() => {
    scope.current = scopeKey;
    setVersions(null);
    setNextBefore(null);
    setError(null);
    setDetails({});
    setFailedVersions(new Set());
    setRestoringVersion(null);
    setRestoreFailure(null);
    detailsInFlight.current = new Set();
    restoreInFlight.current = false;
  }, [scopeKey]);

  // The first page once the panel opens (and again when it opens anew after a
  // save elsewhere: the list may have grown).
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const loadMore = useCallback(async () => {
    if (!enabled || !userId || !workflowId || nextBefore === null || loadingMore) return;
    const mine = `${userId}::${workflowId}`;
    setLoadingMore(true);
    try {
      const page = await listWorkflowVersions(userId, workflowId, nextBefore);
      if (scope.current !== mine) return;
      setVersions((current) => {
        const known = new Set((current ?? []).map((v) => v.versionNo));
        return [...(current ?? []), ...page.items.filter((v) => !known.has(v.versionNo))];
      });
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (scope.current === mine) toastError(toast, "Could not load older versions", err);
    } finally {
      if (scope.current === mine) setLoadingMore(false);
    }
  }, [enabled, userId, workflowId, nextBefore, loadingMore]);

  const loadVersion = useCallback(
    async (versionNo: number) => {
      if (!userId || !workflowId) return;
      if (details[versionNo] || detailsInFlight.current.has(versionNo)) return;
      const mine = `${userId}::${workflowId}`;
      detailsInFlight.current.add(versionNo);
      setFailedVersions((prev) => {
        if (!prev.has(versionNo)) return prev;
        const next = new Set(prev);
        next.delete(versionNo);
        return next;
      });
      try {
        const detail = await getWorkflowVersion(userId, workflowId, versionNo);
        if (scope.current !== mine) return;
        setDetails((prev) => ({ ...prev, [versionNo]: detail }));
      } catch (err) {
        if (scope.current !== mine) return;
        setFailedVersions((prev) => new Set(prev).add(versionNo));
        toastError(toast, `Could not load version ${versionNo}`, err);
      } finally {
        detailsInFlight.current.delete(versionNo);
      }
    },
    [userId, workflowId, details],
  );

  const restore = useCallback(
    async (versionNo: number): Promise<Workflow | null> => {
      if (!userId || !workflowId || restoreInFlight.current) return null;
      restoreInFlight.current = true;
      setRestoringVersion(versionNo);
      setRestoreFailure(null);
      try {
        const workflow = await restoreWorkflowVersion(userId, workflowId, versionNo);
        await reload();
        return workflow;
      } catch (err) {
        const issues = issuesOf(err);
        if (issues.length) {
          // A 422: the version no longer passes today's checks. Shown in the
          // panel, issue by issue — a toast would cut the list short.
          setRestoreFailure({
            versionNo,
            message: err instanceof Error && err.message ? err.message : "This version is invalid.",
            issues,
          });
        } else {
          toastError(toast, `Could not restore version ${versionNo}`, err);
        }
        return null;
      } finally {
        restoreInFlight.current = false;
        setRestoringVersion(null);
      }
    },
    [userId, workflowId, reload],
  );

  const clearRestoreFailure = useCallback(() => setRestoreFailure(null), []);

  return {
    versions,
    loading,
    error,
    reload,
    hasMore: nextBefore !== null,
    loadingMore,
    loadMore,
    details,
    failedVersions,
    loadVersion,
    restoringVersion,
    restoreFailure,
    clearRestoreFailure,
    restore,
  };
}
