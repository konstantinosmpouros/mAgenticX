import { describe, expect, it } from "vitest";

import {
  applyEvents,
  emptyRunView,
  reduceRunEvents,
  settleOpenExecutions,
} from "@/features/workflows/lib/runReducer";
import type { WorkflowRunEvent } from "@/shared/lib/types";

/**
 * The workflow run reducer (plan 38 §3.6): the one fold that turns a run's
 * AG-UI event log into node executions, used for both replay and live.
 *
 * Pinned: one execution per time a node ran (a loop shows `poll#1`, `poll#2`);
 * the node bracket fills input → tool calls / text → output, branch, duration →
 * state delta → succeeded/failed; an approval pauses its execution (waiting,
 * with the question) and the resume re-runs THE SAME execution rather than
 * adding one; RUN_FINISHED carries the output and RUN_ERROR fails whatever is
 * open; folding in chunks equals folding at once, already-applied seqs are
 * dropped, and the input view is never mutated.
 */

/** Builds the event log the bridge would store for a run, seq by seq. */
function runLog() {
  const events: WorkflowRunEvent[] = [];
  let seq = 0;
  const push = (
    type: string,
    payload: Record<string, unknown>,
    executionId: string | null = null,
    parentExecutionId: string | null = null,
  ) => {
    seq += 1;
    const nodeId = executionId ? executionId.split("#")[0] : null;
    const iteration = executionId ? Number(executionId.split("#")[1]) : null;
    events.push({
      seq,
      type,
      nodeId,
      executionId,
      parentExecutionId,
      payload: {
        type,
        ...payload,
        workflow: { runId: "run-1", nodeId, executionId, parentExecutionId, iteration },
      },
      createdAt: `2026-11-04T10:00:${String(seq).padStart(2, "0")}Z`,
    });
  };
  /** A node's full bracket, as `WorkflowNode.__call__` emits it. */
  const node = (
    executionId: string,
    opts: {
      config?: unknown;
      output?: unknown;
      branch?: string | null;
      error?: { code: string; message: string } | null;
      delta?: unknown[];
      parent?: string | null;
      inner?: () => void;
    } = {},
  ) => {
    const parent = opts.parent ?? null;
    const nodeName = executionId.split("#")[0];
    push("STEP_STARTED", { stepName: nodeName }, executionId, parent);
    push(
      "CUSTOM",
      { name: "workflow.node_input", value: { config: opts.config ?? {}, iteration: 1 } },
      executionId,
      parent,
    );
    opts.inner?.();
    push(
      "CUSTOM",
      {
        name: "workflow.node_output",
        value: {
          output: opts.output ?? null,
          branch: opts.branch ?? null,
          durationMs: 12,
          error: opts.error ?? null,
        },
      },
      executionId,
      parent,
    );
    if (!opts.error) push("STATE_DELTA", { delta: opts.delta ?? [] }, executionId, parent);
    push("STEP_FINISHED", { stepName: nodeName }, executionId, parent);
  };
  return { events, push, node };
}

const byId = (view: ReturnType<typeof reduceRunEvents>, executionId: string) =>
  view.executions.find((e) => e.executionId === executionId)!;

describe("workflow run reducer", () => {
  it("folds a linear run into one execution per node, in order", () => {
    const log = runLog();
    log.push("RUN_STARTED", { threadId: "t", runId: "run-1" });
    log.node("start#1", { output: { url: "https://x" } });
    log.node("fetch#1", {
      config: { url: "https://x" },
      output: { status: 200 },
      delta: [{ op: "replace", path: "/count", value: 1 }],
      inner: () => {
        log.push("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "http_get" }, "fetch#1");
        log.push(
          "TOOL_CALL_ARGS",
          {
            toolCallId: "tc1",
            delta: JSON.stringify({ name: "http_get", args: { url: "https://x" } }),
          },
          "fetch#1",
        );
        log.push(
          "TOOL_CALL_RESULT",
          { toolCallId: "tc1", messageId: "m", content: '{"ok":true}' },
          "fetch#1",
        );
        log.push("TOOL_CALL_END", { toolCallId: "tc1" }, "fetch#1");
        log.push("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }, "fetch#1");
        log.push("TEXT_MESSAGE_CHUNK", { messageId: "m1", delta: "lo" }, "fetch#1");
      },
    });
    log.push("RUN_FINISHED", {
      threadId: "t",
      runId: "run-1",
      result: { status: "completed", output: { done: true } },
    });

    const view = reduceRunEvents(log.events);
    expect(view.executions.map((e) => e.executionId)).toEqual(["start#1", "fetch#1"]);
    expect(view.lastSeq).toBe(log.events.length);
    expect(view.output).toEqual({ done: true });
    expect(view.runError).toBeNull();

    const fetch = byId(view, "fetch#1");
    expect(fetch).toMatchObject({
      nodeId: "fetch",
      iteration: 1,
      status: "succeeded",
      input: { url: "https://x" },
      output: { status: 200 },
      durationMs: 12,
      text: "Hello",
      stateDelta: [{ op: "replace", path: "/count", value: 1 }],
      error: null,
      approval: null,
    });
    expect(fetch.toolCalls).toEqual([
      {
        toolCallId: "tc1",
        name: "http_get",
        args: { url: "https://x" },
        result: { ok: true },
        error: false,
      },
    ]);
    expect(fetch.endSeq).toBe(fetch.events[fetch.events.length - 1].seq);
    expect(fetch.events.every((e) => e.executionId === "fetch#1")).toBe(true);
    expect(view.byNode.fetch).toEqual([fetch]);
  });

  it("shows a loop as one execution per iteration, with the loop as parent", () => {
    const log = runLog();
    log.node("start#1");
    for (let i = 1; i <= 3; i += 1) {
      log.node(`loop#${i}`, { branch: "continue", output: { index: i - 1 } });
      log.node(`poll#${i}`, { parent: `loop#${i}`, output: { ready: i === 3 } });
    }
    log.node("loop#4", { branch: "done" });
    log.node("end#1");

    const view = reduceRunEvents(log.events);
    expect(view.byNode.poll.map((e) => e.executionId)).toEqual(["poll#1", "poll#2", "poll#3"]);
    expect(view.byNode.poll.map((e) => e.iteration)).toEqual([1, 2, 3]);
    expect(view.byNode.poll.map((e) => e.parentExecutionId)).toEqual([
      "loop#1",
      "loop#2",
      "loop#3",
    ]);
    expect(view.byNode.loop.map((e) => e.branch)).toEqual([
      "continue",
      "continue",
      "continue",
      "done",
    ]);
    // The timeline order is start order.
    const starts = view.executions.map((e) => e.startSeq);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(view.executions).toHaveLength(1 + 3 * 2 + 1 + 1);
    expect(view.executions.every((e) => e.status === "succeeded")).toBe(true);
  });

  it("pauses an approval and resumes the SAME execution", () => {
    const log = runLog();
    log.node("start#1");
    // The approval node interrupts: its step stays open.
    log.push("STEP_STARTED", { stepName: "approve" }, "approve#1");
    log.push(
      "CUSTOM",
      { name: "workflow.node_input", value: { config: { message: "Ship it?" }, iteration: 1 } },
      "approve#1",
    );
    log.push(
      "CUSTOM",
      {
        name: "HITL_INTERRUPT",
        value: {
          thread_id: "t",
          interrupt: {
            id: "i1",
            value: {
              type: "workflow.approval",
              nodeId: "approve",
              executionId: "approve#1",
              message: "Ship it?",
              payload: { version: 7 },
              allowedDecisions: ["approve", "reject"],
            },
          },
          metadata: { source: "workflow.approval", nodeId: "approve", executionId: "approve#1" },
        },
      },
      "approve#1",
    );

    const paused = reduceRunEvents(log.events);
    expect(byId(paused, "approve#1")).toMatchObject({
      status: "waiting",
      endSeq: null,
      approval: {
        message: "Ship it?",
        payload: { version: 7 },
        allowedDecisions: ["approve", "reject"],
      },
    });

    // The resume leg: the bridge's decision marker, then the engine re-runs approve#1.
    const before = log.events.length;
    log.push(
      "CUSTOM",
      { name: "bridge.approval_decision", value: { decision: "approve" } },
      "approve#1",
    );
    log.push("RUN_STARTED", { threadId: "t", runId: "run-1" });
    log.node("approve#1", { output: { decision: "approve", comment: null }, branch: "approved" });
    log.node("deploy#1", { output: { ok: true } });
    log.push("RUN_FINISHED", { result: { status: "completed", output: { ok: true } } });

    const resumed = applyEvents(paused, log.events.slice(before));
    expect(resumed.byNode.approve).toHaveLength(1);
    const approve = byId(resumed, "approve#1");
    expect(approve).toMatchObject({
      status: "succeeded",
      approval: null,
      branch: "approved",
      output: { decision: "approve", comment: null },
    });
    // Both legs' events, on the one execution.
    expect(approve.events.filter((e) => e.type === "STEP_STARTED")).toHaveLength(2);
    expect(approve.startSeq).toBe(byId(paused, "approve#1").startSeq);
    expect(resumed.executions.map((e) => e.executionId)).toEqual([
      "start#1",
      "approve#1",
      "deploy#1",
    ]);
    expect(resumed).toEqual(reduceRunEvents(log.events));
    // The paused view was not touched.
    expect(byId(paused, "approve#1").status).toBe("waiting");
  });

  it("fails a node on node_output.error and the open ones on RUN_ERROR", () => {
    const log = runLog();
    log.node("start#1");
    log.node("fetch#1", { error: { code: "http", message: "502 from upstream" } });
    log.push("RUN_ERROR", {
      message: "Node 'fetch' failed: 502 from upstream",
      code: "node_failed",
    });
    const view = reduceRunEvents(log.events);
    expect(byId(view, "fetch#1")).toMatchObject({
      status: "failed",
      error: { code: "http", message: "502 from upstream" },
      stateDelta: [],
    });
    expect(view.runError).toEqual({
      message: "Node 'fetch' failed: 502 from upstream",
      code: "node_failed",
    });

    // A run error while a step is still open fails it too.
    const open = runLog();
    open.push("STEP_STARTED", { stepName: "slow" }, "slow#1");
    open.push("RUN_ERROR", {
      message: "The workflow exceeded its step limit.",
      code: "step_limit",
    });
    expect(byId(reduceRunEvents(open.events), "slow#1").status).toBe("failed");
  });

  it("folds incrementally exactly like at once, and drops seqs it already applied", () => {
    const log = runLog();
    log.node("start#1");
    log.node("a#1", {
      inner: () => {
        log.push("TOOL_CALL_START", { toolCallId: "t", toolCallName: "x" }, "a#1");
        log.push("TOOL_CALL_ARGS", { toolCallId: "t", delta: '{"q":' }, "a#1");
        log.push("TOOL_CALL_ARGS", { toolCallId: "t", delta: "1}" }, "a#1");
      },
    });
    log.node("b#1");
    const whole = reduceRunEvents(log.events);
    expect(byId(whole, "a#1").toolCalls[0].args).toEqual({ q: 1 });

    let view = emptyRunView();
    for (let i = 0; i < log.events.length; i += 3)
      view = applyEvents(view, log.events.slice(i, i + 3));
    expect(view).toEqual(whole);

    // A reconnect replaying the tail, out of order: nothing changes.
    const replay = log.events.slice(-4).reverse();
    expect(applyEvents(view, replay)).toBe(view);
  });

  it("settles what a cancelled run left open", () => {
    const log = runLog();
    log.node("start#1");
    log.push("STEP_STARTED", { stepName: "slow" }, "slow#1");
    const view = reduceRunEvents(log.events);
    const settled = settleOpenExecutions(view, "cancelled");
    expect(byId(settled, "slow#1").status).toBe("cancelled");
    expect(byId(settled, "start#1").status).toBe("succeeded");
    expect(settleOpenExecutions(settled, "cancelled")).toBe(settled);
    expect(byId(view, "slow#1").status).toBe("running");
  });
});
