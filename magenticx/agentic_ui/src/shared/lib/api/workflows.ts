/**
 * Workflows API (plan 38) — the user's workflow definitions, the node
 * catalogue, and runs: their pages, detail (events included), start, resume,
 * cancel, and the live event stream.
 *
 * Definitions are the agents service's, proxied by the bridge; runs are the
 * bridge's own. Every response is mapped through the schemas in `../schemas`,
 * whose output matches the types in `types/workflows.ts` (the return types
 * below are what keeps the two in step).
 */
import type {
  Workflow,
  WorkflowApprovalDecision,
  WorkflowSpec,
  WorkflowValidation,
  WorkflowNodeKindInfo,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunEvent,
  WorkflowRunPage,
  WorkflowRunStreamFrame,
  WorkflowSchedule,
} from "../types";
import { requestJson, requestRaw, requestVoid } from "../http";
import {
  WorkflowCatalogSchema,
  WorkflowListSchema,
  WorkflowRunDetailSchema,
  WorkflowRunPageSchema,
  WorkflowRunSchema,
  WorkflowRunStartedSchema,
  WorkflowSchema,
  WorkflowScheduleSchema,
  WorkflowValidationSchema,
  toWorkflowRunStreamFrame,
} from "../schemas";
import { WORKFLOW_RUNS_BASE_PATH, WORKFLOWS_BASE_PATH } from "./paths";

/** Safety valve for `getWorkflowRunDetail`'s paging: 200 pages of 5000 events. */
const MAX_DETAIL_PAGES = 200;

const enc = encodeURIComponent;
const workflowUrl = (userId: string, workflowId: string) =>
  `${WORKFLOWS_BASE_PATH}/${enc(userId)}/${enc(workflowId)}`;
const runUrl = (userId: string, runId: string) =>
  `${WORKFLOW_RUNS_BASE_PATH}/${enc(userId)}/${enc(runId)}`;

export async function listWorkflows(userId: string): Promise<Workflow[]> {
  return requestJson(`${WORKFLOWS_BASE_PATH}/${enc(userId)}`, {
    schema: WorkflowListSchema,
    fallbackMessage: "Your workflows could not be loaded.",
  });
}

export async function getWorkflow(userId: string, workflowId: string): Promise<Workflow> {
  return requestJson(workflowUrl(userId, workflowId), {
    schema: WorkflowSchema,
    fallbackMessage: "The workflow could not be loaded.",
  });
}

/** The node kinds (labels, groups, branches, config JSON Schemas). */
export async function getWorkflowCatalog(): Promise<WorkflowNodeKindInfo[]> {
  return requestJson(`${WORKFLOWS_BASE_PATH}/catalog`, {
    schema: WorkflowCatalogSchema,
    fallbackMessage: "The workflow catalog could not be loaded.",
  });
}

/**
 * Create a workflow from a spec (201). An invalid spec is a 422 whose
 * `ApiError.detailObject.errors` lists every issue (`toWorkflowValidationIssues`).
 */
export async function createWorkflow(userId: string, spec: WorkflowSpec): Promise<Workflow> {
  return requestJson(`${WORKFLOWS_BASE_PATH}/${enc(userId)}`, {
    method: "POST",
    csrf: true,
    body: { spec },
    schema: WorkflowSchema,
    fallbackMessage: "The workflow could not be created.",
  });
}

/**
 * Save a workflow's spec. A new version is added only when the spec changed;
 * the returned `latestVersionNo` says which version is current. 422 as create.
 */
export async function updateWorkflow(
  userId: string,
  workflowId: string,
  spec: WorkflowSpec,
): Promise<Workflow> {
  return requestJson(workflowUrl(userId, workflowId), {
    method: "PUT",
    csrf: true,
    body: { spec },
    schema: WorkflowSchema,
    fallbackMessage: "The workflow could not be saved.",
  });
}

/** Delete a workflow and its run history (live runs are cancelled first, server-side). */
export async function deleteWorkflow(userId: string, workflowId: string): Promise<void> {
  await requestVoid(workflowUrl(userId, workflowId), {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "The workflow could not be deleted.",
  });
}

/**
 * Pause a workflow's schedule (its `trigger.schedule` start node keeps it;
 * it just stops firing). Idempotent; a finished schedule stays finished. 404
 * when the workflow has no schedule.
 */
export async function pauseWorkflowSchedule(
  userId: string,
  workflowId: string,
): Promise<WorkflowSchedule> {
  return requestJson(`${workflowUrl(userId, workflowId)}/schedule/pause`, {
    method: "POST",
    csrf: true,
    schema: WorkflowScheduleSchema,
    fallbackMessage: "The schedule could not be paused.",
  });
}

/** Resume a paused schedule from its next future slot (missed slots are not backfilled). */
export async function resumeWorkflowSchedule(
  userId: string,
  workflowId: string,
): Promise<WorkflowSchedule> {
  return requestJson(`${workflowUrl(userId, workflowId)}/schedule/resume`, {
    method: "POST",
    csrf: true,
    schema: WorkflowScheduleSchema,
    fallbackMessage: "The schedule could not be resumed.",
  });
}

/** Dry-run the validator over a spec: every issue at once, nothing saved. */
export async function validateWorkflow(spec: WorkflowSpec): Promise<WorkflowValidation> {
  return requestJson(`${WORKFLOWS_BASE_PATH}/validate`, {
    method: "POST",
    csrf: true,
    body: { spec },
    schema: WorkflowValidationSchema,
    fallbackMessage: "The workflow could not be checked.",
  });
}

/** One page of a workflow's runs, newest first; pass `nextCursor` back for the next. */
export async function listWorkflowRuns(
  userId: string,
  workflowId: string,
  cursor?: string | null,
): Promise<WorkflowRunPage> {
  const query = cursor ? `?cursor=${enc(cursor)}` : "";
  return requestJson(`${workflowUrl(userId, workflowId)}/runs${query}`, {
    schema: WorkflowRunPageSchema,
    fallbackMessage: "The workflow's runs could not be loaded.",
  });
}

/**
 * A run with ALL its events: the bridge pages a long run's events
 * (`hasMoreEvents`), so this follows the pages, each from the last `seq` seen,
 * until the log is complete. The returned `hasMoreEvents` is therefore false
 * unless the safety cap was hit.
 */
export async function getWorkflowRunDetail(
  userId: string,
  runId: string,
): Promise<WorkflowRunDetail> {
  const fetchPage = (afterSeq: number) =>
    requestJson(`${runUrl(userId, runId)}${afterSeq > 0 ? `?after_seq=${afterSeq}` : ""}`, {
      schema: WorkflowRunDetailSchema,
      fallbackMessage: "The run could not be loaded.",
    });
  const first = await fetchPage(0);
  const events: WorkflowRunEvent[] = [...first.events];
  let latest = first;
  let pages = 1;
  while (latest.hasMoreEvents && latest.events.length > 0 && pages < MAX_DETAIL_PAGES) {
    latest = await fetchPage(events[events.length - 1].seq);
    events.push(...latest.events);
    pages += 1;
  }
  // The newest page carries the freshest run status.
  return { run: latest.run, inputs: first.inputs, events, hasMoreEvents: latest.hasMoreEvents };
}

/** Start a run; resolves to its id. 409 while the workflow already has a live run. */
export async function startWorkflowRun(
  userId: string,
  workflowId: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const data = await requestJson(`${workflowUrl(userId, workflowId)}/runs`, {
    method: "POST",
    csrf: true,
    body: { inputs },
    schema: WorkflowRunStartedSchema,
    fallbackMessage: "The run could not be started.",
  });
  return data.runId;
}

/** Answer the approval a `waiting` run is paused on (409 when it is not waiting). */
export async function resumeWorkflowRun(
  userId: string,
  runId: string,
  decision: WorkflowApprovalDecision,
  comment?: string,
): Promise<WorkflowRun> {
  const trimmed = comment?.trim();
  return requestJson(`${runUrl(userId, runId)}/resume`, {
    method: "POST",
    csrf: true,
    body: { decision, ...(trimmed ? { comment: trimmed } : {}) },
    schema: WorkflowRunSchema,
    fallbackMessage: "The approval could not be sent.",
  });
}

/** Cancel a queued, running or waiting run; a finished one comes back as is. */
export async function cancelWorkflowRun(userId: string, runId: string): Promise<WorkflowRun> {
  return requestJson(`${runUrl(userId, runId)}/cancel`, {
    method: "POST",
    csrf: true,
    schema: WorkflowRunSchema,
    fallbackMessage: "The run could not be cancelled.",
  });
}

/**
 * Follow a run's event stream (SSE): its status, the stored events after
 * `afterSeq`, then the live tail. Resolves when the server closes the stream
 * (the run finished or paused for an approval) and rejects on a transport
 * error; abort `signal` to stop. Reconnecting is the caller's job — it passes
 * the last `seq` it applied.
 *
 * Read with `fetch` rather than `EventSource` so the request goes through the
 * shared transport (credentials, the silent 401 refresh-and-retry) like every
 * other call. `: keep-alive` comments and `id:` lines are skipped: the seq is in
 * the event itself.
 */
export async function streamWorkflowRunEvents(
  userId: string,
  runId: string,
  afterSeq: number,
  onFrame: (frame: WorkflowRunStreamFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await requestRaw(
    `${runUrl(userId, runId)}/events/stream?after_seq=${Math.max(0, afterSeq)}`,
    {
      accept: "text/event-stream",
      signal,
      fallbackMessage: "The run's live updates could not be opened.",
    },
  );
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const frame = toWorkflowRunStreamFrame(parsed);
    if (frame) onFrame(frame);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}
