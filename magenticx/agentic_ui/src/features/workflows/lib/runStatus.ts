/**
 * Run-status sets, mirroring the bridge (`dialogue_bridge/utils/workflow_runs.py`):
 *
 * - **active** — a leg is (or is about to be) streaming: follow the event stream;
 * - **live** — not over yet: active, or paused on an approval (`waiting`);
 * - **terminal** — over for good.
 */
import type { WorkflowRunStatus } from "@/shared/lib/types";

export const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["queued", "running"]);
export const LIVE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "queued",
  "running",
  "waiting",
]);
export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export const isActiveRunStatus = (status: WorkflowRunStatus | null | undefined): boolean =>
  !!status && ACTIVE_RUN_STATUSES.has(status);

export const isLiveRunStatus = (status: WorkflowRunStatus | null | undefined): boolean =>
  !!status && LIVE_RUN_STATUSES.has(status);

/** What a start answered with 409 (the workflow already has a live run) reads as. */
export const LIVE_RUN_MESSAGE =
  "This workflow already has a run in progress. Wait for it to finish, or cancel it.";
