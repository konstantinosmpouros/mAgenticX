/**
 * The workflow run reducer (plan 38 §3.6): one pure fold of a run's ordered
 * AG-UI event log into the view the workflow page renders — one *execution*
 * per time a node ran (so a loop shows `poll#1`, `poll#2`, …), plus the run's
 * final output or error.
 *
 * Replay and live use the same fold: the run detail's events go through
 * `applyEvents(emptyRunView(), events)`, and each live batch from the event
 * stream through `applyEvents(view, batch)`. Events at or below `view.lastSeq`
 * are dropped, so a reconnect that replays a few already-applied events (or a
 * detail page overlapping the stream) can never double-count.
 *
 * The event shapes come from the engine (`agents/harness/workflows/nodes/base.py`,
 * `harness/workflows/events.py`, `harness/agui/emitter.py`): every node event
 * carries the run envelope, which the bridge lifts onto the event row as
 * `nodeId` / `executionId` / `parentExecutionId`. A node's events, in order:
 *
 *   STEP_STARTED → CUSTOM workflow.node_input → (TOOL_CALL_* / TEXT_MESSAGE_*)
 *   → CUSTOM workflow.node_output → STATE_DELTA → STEP_FINISHED
 *
 * An approval node instead stops after `HITL_INTERRUPT`; on resume the bridge
 * writes a `bridge.approval_decision` marker on the same execution and the
 * engine re-runs that execution from STEP_STARTED (same `executionId`) — so it
 * stays ONE execution here, reset to running, with the new events appended.
 */
import type {
  WorkflowApprovalDecision,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowPendingApproval,
  WorkflowRunEvent,
  WorkflowRunView,
  WorkflowToolCall,
} from "@/shared/lib/types";

/** Custom event names the reducer reads (engine + bridge). */
export const NODE_INPUT_EVENT = "workflow.node_input";
export const NODE_OUTPUT_EVENT = "workflow.node_output";
export const HITL_INTERRUPT_EVENT = "HITL_INTERRUPT";
export const APPROVAL_DECISION_EVENT = "bridge.approval_decision";

const DECISIONS: readonly WorkflowApprovalDecision[] = ["approve", "reject"];
/** Execution states that are not settled yet. */
const OPEN_STATUSES: ReadonlySet<WorkflowExecutionStatus> = new Set(["running", "waiting"]);

/** The view of a run with no events applied. */
export function emptyRunView(): WorkflowRunView {
  return { executions: [], byNode: {}, lastSeq: 0, output: null, runError: null };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** `fetch#2` → 2; the envelope's `iteration` wins when present. */
function iterationOf(event: WorkflowRunEvent, executionId: string): number {
  const fromEnvelope = asRecord(event.payload.workflow).iteration;
  if (typeof fromEnvelope === "number" && fromEnvelope > 0) return fromEnvelope;
  const match = /#(\d+)$/.exec(executionId);
  return match ? Number(match[1]) : 1;
}

function nodeIdOf(event: WorkflowRunEvent, executionId: string): string {
  if (event.nodeId) return event.nodeId;
  const hash = executionId.lastIndexOf("#");
  return hash > 0 ? executionId.slice(0, hash) : executionId;
}

/** JSON when it parses, the raw text otherwise. */
function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A tool call's arguments from all of its TOOL_CALL_ARGS deltas so far. The
 * emitter sends `{"name", "args"}` as the delta, so that wrapper is unwrapped;
 * anything else (a model-streamed argument string) is kept as parsed.
 */
function toolArgs(events: WorkflowRunEvent[], toolCallId: string): unknown {
  const text = events
    .filter((e) => e.type === "TOOL_CALL_ARGS" && e.payload.toolCallId === toolCallId)
    .map((e) => asString(e.payload.delta) ?? "")
    .join("");
  if (!text) return null;
  const parsed = parseMaybeJson(text);
  const record = asRecord(parsed);
  if ("args" in record && "name" in record && Object.keys(record).length === 2) return record.args;
  return parsed;
}

/** The approval from a HITL_INTERRUPT's value (`value.interrupt.value`, or `value` itself). */
function approvalOf(value: unknown): WorkflowPendingApproval {
  const outer = asRecord(value);
  const interrupt = asRecord(outer.interrupt);
  const inner = "value" in interrupt ? asRecord(interrupt.value) : outer;
  const allowed = Array.isArray(inner.allowedDecisions)
    ? inner.allowedDecisions.filter((d): d is WorkflowApprovalDecision =>
        DECISIONS.includes(d as WorkflowApprovalDecision),
      )
    : [];
  return {
    message: asString(inner.message) ?? "",
    payload: inner.payload ?? null,
    allowedDecisions: allowed.length > 0 ? allowed : [...DECISIONS],
  };
}

function newExecution(event: WorkflowRunEvent, executionId: string): WorkflowExecution {
  return {
    executionId,
    nodeId: nodeIdOf(event, executionId),
    iteration: iterationOf(event, executionId),
    parentExecutionId: event.parentExecutionId,
    status: "running",
    startSeq: event.seq,
    endSeq: null,
    startedAt: event.createdAt,
    durationMs: null,
    input: null,
    output: null,
    branch: null,
    error: null,
    stateDelta: [],
    toolCalls: [],
    text: "",
    approval: null,
    events: [],
  };
}

function groupByNode(executions: WorkflowExecution[]): Record<string, WorkflowExecution[]> {
  const byNode: Record<string, WorkflowExecution[]> = {};
  for (const execution of executions) (byNode[execution.nodeId] ??= []).push(execution);
  return byNode;
}

/**
 * Fold `newEvents` into `view`, returning a new view (the input is never
 * mutated, so it is safe as React state). Events are applied in `seq` order;
 * any at or below `view.lastSeq` are skipped.
 */
export function applyEvents(
  view: WorkflowRunView,
  newEvents: readonly WorkflowRunEvent[],
): WorkflowRunView {
  const fresh = newEvents.filter((e) => e.seq > view.lastSeq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return view;

  const executions = view.executions.slice();
  const indexById = new Map(executions.map((execution, index) => [execution.executionId, index]));
  // Executions already copied in this batch: mutate those copies freely.
  const touched = new Set<number>();
  let { lastSeq, output, runError } = view;

  /** The batch's own copy of the execution, created if it is new. */
  const take = (event: WorkflowRunEvent, executionId: string): WorkflowExecution => {
    let index = indexById.get(executionId);
    if (index === undefined) {
      index = executions.push(newExecution(event, executionId)) - 1;
      indexById.set(executionId, index);
      touched.add(index);
    } else if (!touched.has(index)) {
      const current = executions[index];
      executions[index] = {
        ...current,
        stateDelta: current.stateDelta.slice(),
        toolCalls: current.toolCalls.slice(),
        events: current.events.slice(),
      };
      touched.add(index);
    }
    return executions[index];
  };

  const updateToolCall = (
    execution: WorkflowExecution,
    toolCallId: string,
    patch: (call: WorkflowToolCall) => WorkflowToolCall,
  ) => {
    let index = execution.toolCalls.findIndex((call) => call.toolCallId === toolCallId);
    if (index === -1) {
      index =
        execution.toolCalls.push({ toolCallId, name: "", args: null, result: null, error: false }) -
        1;
    }
    execution.toolCalls[index] = patch(execution.toolCalls[index]);
  };

  for (const event of fresh) {
    lastSeq = event.seq;
    const payload = event.payload;
    const customName = event.type === "CUSTOM" ? asString(payload.name) : null;

    // Run-level frames carry no execution.
    if (event.type === "RUN_FINISHED") {
      output = asRecord(payload.result).output ?? null;
      continue;
    }
    if (event.type === "RUN_ERROR") {
      runError = {
        message: asString(payload.message) ?? "The workflow failed.",
        code: asString(payload.code),
      };
      for (let i = 0; i < executions.length; i += 1) {
        if (!OPEN_STATUSES.has(executions[i].status)) continue;
        const execution = take(event, executions[i].executionId);
        execution.status = "failed";
        execution.approval = null;
      }
      continue;
    }

    const executionId =
      event.executionId ??
      (customName === HITL_INTERRUPT_EVENT
        ? asString(asRecord(asRecord(payload.value).metadata).executionId)
        : null);
    if (!executionId) continue;

    const execution = take(event, executionId);
    execution.events.push(event);

    switch (event.type) {
      case "STEP_STARTED":
        // A first start, or the resume of an interrupted execution: either way
        // it is running now and its bracket is open again.
        execution.status = "running";
        execution.endSeq = null;
        execution.approval = null;
        break;
      case "STEP_FINISHED":
        execution.status = execution.error ? "failed" : "succeeded";
        execution.endSeq = event.seq;
        break;
      case "STATE_DELTA":
        if (Array.isArray(payload.delta)) execution.stateDelta.push(...payload.delta);
        break;
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_CHUNK":
        execution.text += asString(payload.delta) ?? "";
        break;
      case "TOOL_CALL_START": {
        const toolCallId = asString(payload.toolCallId);
        if (toolCallId) {
          const name = asString(payload.toolCallName) ?? "";
          updateToolCall(execution, toolCallId, (call) => ({ ...call, name: name || call.name }));
        }
        break;
      }
      case "TOOL_CALL_ARGS": {
        const toolCallId = asString(payload.toolCallId);
        if (toolCallId) {
          const args = toolArgs(execution.events, toolCallId);
          updateToolCall(execution, toolCallId, (call) => ({ ...call, args }));
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        const toolCallId = asString(payload.toolCallId);
        if (toolCallId) {
          const content = payload.content;
          const result = typeof content === "string" ? parseMaybeJson(content) : (content ?? null);
          const error = payload.error === true;
          updateToolCall(execution, toolCallId, (call) => ({ ...call, result, error }));
        }
        break;
      }
      case "CUSTOM": {
        const value = asRecord(payload.value);
        if (customName === NODE_INPUT_EVENT) {
          execution.input = value.config ?? null;
        } else if (customName === NODE_OUTPUT_EVENT) {
          execution.output = value.output ?? null;
          execution.branch = asString(value.branch);
          execution.durationMs = typeof value.durationMs === "number" ? value.durationMs : null;
          const error = asRecord(value.error);
          if (value.error && typeof value.error === "object") {
            execution.error = {
              code: asString(error.code) ?? "internal",
              message: asString(error.message) ?? "The node failed.",
            };
            execution.status = "failed";
          } else {
            execution.error = null;
          }
        } else if (customName === HITL_INTERRUPT_EVENT) {
          execution.status = "waiting";
          execution.approval = approvalOf(payload.value);
        } else if (customName === APPROVAL_DECISION_EVENT) {
          // Answered: the engine is about to re-run this execution.
          execution.approval = null;
          if (execution.status === "waiting") execution.status = "running";
        }
        break;
      }
      default:
        // TOOL_CALL_END, TEXT_MESSAGE_START/END and anything new: kept in
        // `events` for the raw view, nothing to fold.
        break;
    }
  }

  return { executions, byNode: groupByNode(executions), lastSeq, output, runError };
}

/** Fold a whole event log from scratch. */
export function reduceRunEvents(events: readonly WorkflowRunEvent[]): WorkflowRunView {
  return applyEvents(emptyRunView(), events);
}

/**
 * Settle the executions a run left open once the run itself is over without an
 * event saying so: a cancelled run (no event is written) marks them
 * `cancelled`, a run the bridge failed (stream lost, time limit) `failed`.
 * Returns `view` itself when nothing is open.
 */
export function settleOpenExecutions(
  view: WorkflowRunView,
  status: Extract<WorkflowExecutionStatus, "failed" | "cancelled">,
): WorkflowRunView {
  if (!view.executions.some((execution) => OPEN_STATUSES.has(execution.status))) return view;
  const executions = view.executions.map((execution) =>
    OPEN_STATUSES.has(execution.status) ? { ...execution, status, approval: null } : execution,
  );
  return { ...view, executions, byNode: groupByNode(executions) };
}
