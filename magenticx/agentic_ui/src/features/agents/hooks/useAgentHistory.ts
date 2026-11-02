import { useCallback, useEffect, useRef, useState } from "react";

import { getMyAgentVersion, listMyAgentVersions, restoreMyAgentVersion } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { toastError } from "@/shared/lib/toast";
import { toast } from "@/shared/hooks/use-toast";
import type { AgentVersionDetail, AgentVersionSummary } from "@/shared/lib/types";

/** Why a restore was refused, with the server's issues when it sent them (a 422). */
export type RestoreFailure = { versionNo: number; message: string; issues: string[] };

export type AgentHistoryHandlers = {
  /** The kept versions, newest first; null until the first load answers. */
  versions: AgentVersionSummary[] | null;
  loading: boolean;
  /** The list could not be loaded; the History tab offers a retry. */
  error: string | null;
  reload: () => Promise<void>;

  details: Record<number, AgentVersionDetail>;
  isVersionLoading: (versionNo: number) => boolean;
  /** Versions whose detail failed to load, so the tab can offer a retry. */
  failedVersions: ReadonlySet<number>;
  loadVersion: (versionNo: number) => Promise<void>;

  restoringVersion: number | null;
  restoreFailure: RestoreFailure | null;
  clearRestoreFailure: () => void;
  /** Resolves true once the version is the agent again (and the list re-read). */
  restore: (versionNo: number) => Promise<boolean>;
};

/** A 422's issues as lines: `issues[].message` first, the bare `errors` otherwise. */
const issuesOf = (error: unknown): string[] => {
  const detail = error instanceof ApiError ? error.detailObject : undefined;
  if (!detail) return [];
  const issues = Array.isArray(detail.issues)
    ? detail.issues
        .map((i) =>
          i && typeof i === "object" ? String((i as { message?: unknown }).message ?? "") : "",
        )
        .filter(Boolean)
    : [];
  if (issues.length) return issues;
  return Array.isArray(detail.errors) ? detail.errors.map(String).filter(Boolean) : [];
};

/**
 * One custom agent's saved versions: the list, each version's full definition
 * (loaded on demand and kept by number — a saved version never changes), and
 * restoring one.
 *
 * Owned by the agent's page rather than the History tab, because the Overview's
 * "Version" row reads the same list: one request per page open serves both.
 * `enabled` is false for any agent that is not the user's own — nothing loads.
 *
 * A failed list load is not toasted: the page loads it in the background for
 * the Overview, and a toast on an agent's page about a tab the user never
 * opened would be noise. The History tab shows the error with a retry instead.
 */
export function useAgentHistory({
  userId,
  agentId,
  enabled,
  onRestored,
}: {
  userId: string | null;
  agentId: string;
  enabled: boolean;
  /** Re-pull whatever shows the agent (header, cards) after a restore. */
  onRestored?: () => Promise<void> | void;
}): AgentHistoryHandlers {
  const [versions, setVersions] = useState<AgentVersionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<number, AgentVersionDetail>>({});
  const [loadingVersions, setLoadingVersions] = useState<Set<number>>(new Set());
  const [failedVersions, setFailedVersions] = useState<Set<number>>(new Set());
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<RestoreFailure | null>(null);
  // Refs, not state, for the in-flight guards: two clicks in one tick both read
  // the same un-rendered state and would each fire a request.
  const detailsInFlight = useRef<Set<number>>(new Set());
  const restoreInFlight = useRef(false);
  // Answers for another agent (or user) than the current one are dropped.
  const scope = useRef(`${userId}::${agentId}`);
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  }, [onRestored]);

  const reload = useCallback(async () => {
    if (!enabled || !userId || !agentId) return;
    const mine = `${userId}::${agentId}`;
    setLoading(true);
    try {
      const list = await listMyAgentVersions(userId, agentId);
      if (scope.current !== mine) return;
      setVersions(list);
      setError(null);
    } catch (err) {
      if (scope.current !== mine) return;
      setError(err instanceof Error && err.message ? err.message : "Could not load the history.");
    } finally {
      if (scope.current === mine) setLoading(false);
    }
  }, [enabled, userId, agentId]);

  useEffect(() => {
    // A new agent or user: nothing from the previous one may show.
    scope.current = `${userId}::${agentId}`;
    setVersions(null);
    setError(null);
    setDetails({});
    setLoadingVersions(new Set());
    setFailedVersions(new Set());
    setRestoringVersion(null);
    setRestoreFailure(null);
    detailsInFlight.current = new Set();
    restoreInFlight.current = false;
    void reload();
  }, [reload, userId, agentId]);

  const isVersionLoading = useCallback(
    (versionNo: number) => loadingVersions.has(versionNo),
    [loadingVersions],
  );

  const loadVersion = useCallback(
    async (versionNo: number) => {
      if (!enabled || !userId || !agentId) return;
      if (details[versionNo] || detailsInFlight.current.has(versionNo)) return;
      const mine = `${userId}::${agentId}`;
      detailsInFlight.current.add(versionNo);
      setLoadingVersions((prev) => new Set(prev).add(versionNo));
      setFailedVersions((prev) => {
        if (!prev.has(versionNo)) return prev;
        const next = new Set(prev);
        next.delete(versionNo);
        return next;
      });
      try {
        const detail = await getMyAgentVersion(userId, agentId, versionNo);
        if (scope.current !== mine) return;
        setDetails((prev) => ({ ...prev, [versionNo]: detail }));
      } catch (err) {
        if (scope.current !== mine) return;
        setFailedVersions((prev) => new Set(prev).add(versionNo));
        toastError(toast, `Could not load version ${versionNo}`, err);
      } finally {
        detailsInFlight.current.delete(versionNo);
        if (scope.current === mine) {
          setLoadingVersions((prev) => {
            const next = new Set(prev);
            next.delete(versionNo);
            return next;
          });
        }
      }
    },
    [enabled, userId, agentId, details],
  );

  const restore = useCallback(
    async (versionNo: number): Promise<boolean> => {
      if (!enabled || !userId || !agentId || restoreInFlight.current) return false;
      restoreInFlight.current = true;
      setRestoringVersion(versionNo);
      setRestoreFailure(null);
      try {
        const agent = await restoreMyAgentVersion(userId, agentId, versionNo);
        toast({
          title: `Version ${versionNo} restored`,
          description: `${agent.name} is back to version ${versionNo}. Every other version is still in its history.`,
        });
        await Promise.all([reload(), onRestoredRef.current?.()]);
        return true;
      } catch (err) {
        const issues = issuesOf(err);
        if (issues.length) {
          // A 422: the version no longer passes today's checks. Shown in the
          // tab, issue by issue — a toast would cut the list short.
          setRestoreFailure({
            versionNo,
            message: err instanceof Error && err.message ? err.message : "This version is invalid.",
            issues,
          });
        } else {
          toastError(toast, `Could not restore version ${versionNo}`, err);
        }
        return false;
      } finally {
        restoreInFlight.current = false;
        setRestoringVersion(null);
      }
    },
    [enabled, userId, agentId, reload],
  );

  const clearRestoreFailure = useCallback(() => setRestoreFailure(null), []);

  return {
    versions,
    loading,
    error,
    reload,
    details,
    isVersionLoading,
    failedVersions,
    loadVersion,
    restoringVersion,
    restoreFailure,
    clearRestoreFailure,
    restore,
  };
}
