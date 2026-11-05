import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelWorkflowRun,
  getWorkflowRunDetail,
  resumeWorkflowRun,
  streamWorkflowRunEvents,
} from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import type {
  WorkflowApprovalDecision,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunStreamFrame,
  WorkflowRunView,
} from "@/shared/lib/types";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";
import {
  applyEvents,
  emptyRunView,
  reduceRunEvents,
  settleOpenExecutions,
} from "@/features/workflows/lib/runReducer";
import { isActiveRunStatus } from "@/features/workflows/lib/runStatus";

/** Live events are folded in small batches: one render per burst, not per token. */
const FLUSH_MS = 60;
/** Reconnect delays after the stream drops while the run is still active; the last repeats. */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

const EMPTY_INPUTS: Record<string, unknown> = {};

const readable = (err: unknown, fallback: string): Error =>
  new Error(err instanceof Error && err.message ? err.message : fallback);

/** Sleep that ends early (resolving) when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * One run, followed live.
 *
 * Loads the run's detail (every event page) and folds the events with the run
 * reducer. While the run is *active* (queued or running) it follows the event
 * stream from `view.lastSeq`, folding events as they arrive and taking each
 * status frame as the run's new status; a dropped stream reconnects (backing
 * off) from the last applied seq, and the stream is closed once the run pauses
 * for an approval or ends. `isLive` is true while that stream is being
 * followed.
 *
 * `resume` answers the approval a waiting run is paused on and `cancel` stops
 * the run; both take the run the bridge returns as the new status (a resumed
 * run is running again, so following restarts) and reject with a readable
 * `Error`. A run that ended without an event saying so (cancelled, or failed
 * by the bridge) has its still-open executions settled in `view`, and the
 * bridge's error becomes `view.runError`.
 *
 * `runId` null: nothing is loaded and the view is empty.
 */
export function useWorkflowRun(runId: string | null): {
  run: WorkflowRun | null;
  inputs: Record<string, unknown>;
  view: WorkflowRunView;
  isLive: boolean;
  error: string | null;
  resume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const userId = useWorkflowUserId();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [inputs, setInputs] = useState<Record<string, unknown>>(EMPTY_INPUTS);
  const [view, setView] = useState<WorkflowRunView>(emptyRunView);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The fold as of the last flush (the stream reconnects from its lastSeq) and
  // the run's latest status, readable from the stream loop without re-running it.
  const viewRef = useRef<WorkflowRunView>(view);
  const statusRef = useRef<WorkflowRun["status"] | null>(null);

  const acceptRun = useCallback((next: WorkflowRun) => {
    statusRef.current = next.status;
    setRun(next);
  }, []);

  // Load the detail whenever the run (or user) changes.
  useEffect(() => {
    const reset = emptyRunView();
    viewRef.current = reset;
    statusRef.current = null;
    setView(reset);
    setRun(null);
    setInputs(EMPTY_INPUTS);
    setError(null);
    setIsLive(false);
    if (!userId || !runId) return;
    let cancelled = false;
    getWorkflowRunDetail(userId, runId)
      .then((detail) => {
        if (cancelled) return;
        const folded = reduceRunEvents(detail.events);
        viewRef.current = folded;
        setView(folded);
        setInputs(detail.inputs);
        acceptRun(detail.run);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "The run could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [userId, runId, acceptRun]);

  // Follow the event stream while the run is active.
  const follow = isActiveRunStatus(run?.status) && run?.id === runId;
  useEffect(() => {
    if (!follow || !userId || !runId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let pending: WorkflowRunEvent[] = [];
    let flushTimer: number | null = null;

    const flush = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0 || signal.aborted) return;
      const batch = pending;
      pending = [];
      viewRef.current = applyEvents(viewRef.current, batch);
      setView(viewRef.current);
    };

    const onFrame = (frame: WorkflowRunStreamFrame) => {
      if (signal.aborted) return;
      if (frame.type === "event") {
        pending.push(frame.event);
        if (flushTimer === null) flushTimer = window.setTimeout(flush, FLUSH_MS);
        return;
      }
      // Status frames bracket the events: apply what came before, then the status.
      flush();
      acceptRun(frame.run);
    };

    void (async () => {
      setIsLive(true);
      let attempt = 0;
      while (!signal.aborted) {
        const before = viewRef.current.lastSeq;
        try {
          await streamWorkflowRunEvents(userId, runId, viewRef.current.lastSeq, onFrame, signal);
          flush();
        } catch (err) {
          flush();
          if (signal.aborted) break;
          // The run is gone (or not ours): retrying cannot help.
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            setError(err.message);
            break;
          }
        }
        // Closed with the run paused or over: nothing more to follow.
        if (signal.aborted || !isActiveRunStatus(statusRef.current)) break;
        // Dropped while still active: reconnect from the last applied seq.
        attempt = viewRef.current.lastSeq > before ? 0 : attempt + 1;
        await pause(
          RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)],
          signal,
        );
      }
      if (!signal.aborted) setIsLive(false);
    })();

    return () => {
      controller.abort();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      setIsLive(false);
    };
  }, [follow, userId, runId, acceptRun]);

  const resume = useCallback(
    async (decision: WorkflowApprovalDecision, comment?: string) => {
      if (!userId || !runId) throw new Error("No run to answer.");
      try {
        acceptRun(await resumeWorkflowRun(userId, runId, decision, comment));
      } catch (err) {
        throw readable(err, "The approval could not be sent.");
      }
    },
    [userId, runId, acceptRun],
  );

  const cancel = useCallback(async () => {
    if (!userId || !runId) throw new Error("No run to cancel.");
    try {
      acceptRun(await cancelWorkflowRun(userId, runId));
    } catch (err) {
      throw readable(err, "The run could not be cancelled.");
    }
  }, [userId, runId, acceptRun]);

  // A run that ended without an event saying so: settle what it left open.
  const settledView = useMemo(() => {
    if (run?.status === "cancelled") return settleOpenExecutions(view, "cancelled");
    if (run?.status === "failed") {
      const settled = settleOpenExecutions(view, "failed");
      return settled.runError || !run.error
        ? settled
        : { ...settled, runError: { message: run.error, code: null } };
    }
    return view;
  }, [run?.status, run?.error, view]);

  return { run, inputs, view: settledView, isLive, error, resume, cancel };
}
