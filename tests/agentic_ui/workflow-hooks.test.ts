// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkflowQuickRun } from "@/features/workflows/hooks/useWorkflowQuickRun";
import { useWorkflowRun } from "@/features/workflows/hooks/useWorkflowRun";
import { useWorkflowRuns } from "@/features/workflows/hooks/useWorkflowRuns";
import { ApiError } from "@/shared/lib/http";
import type { WorkflowRun, WorkflowRunEvent, WorkflowRunStreamFrame } from "@/shared/lib/types";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * The workflow view's data hooks (plan 38, step 2).
 *
 * Pinned: `useWorkflowRun` folds the detail, follows the stream from the last
 * applied seq while the run is active, stops on a waiting/terminal status,
 * reconnects (from the new last seq) when the stream drops while the run is
 * still running, and starts following again after `resume`; a cancelled run's
 * open executions settle as cancelled. `useWorkflowRuns.startRun` turns a 409
 * into a readable Error. `useWorkflowQuickRun` (the Automations page's "Run
 * now") starts a run with no inputs only when none is required, and otherwise
 * starts nothing.
 */

const api = vi.hoisted(() => ({
  getWorkflowRunDetail: vi.fn(),
  streamWorkflowRunEvents: vi.fn(),
  resumeWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  listWorkflowRuns: vi.fn(),
  startWorkflowRun: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock("@/shared/lib/api", () => api);

const run = (status: WorkflowRun["status"]): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "Deploy",
  versionNo: 1,
  triggerKind: "manual",
  status,
  error: null,
  eventCount: 0,
  startedAt: "2026-11-04T10:00:00Z",
  finishedAt: null,
  createdAt: "2026-11-04T10:00:00Z",
  updatedAt: "2026-11-04T10:00:00Z",
});

const ev = (
  seq: number,
  type: string,
  executionId: string,
  payload: Record<string, unknown> = {},
): WorkflowRunEvent => ({
  seq,
  type,
  nodeId: executionId.split("#")[0],
  executionId,
  parentExecutionId: null,
  payload: { type, ...payload },
  createdAt: "2026-11-04T10:00:00Z",
});

type Stream = (
  userId: string,
  runId: string,
  afterSeq: number,
  onFrame: (frame: WorkflowRunStreamFrame) => void,
  signal?: AbortSignal,
) => Promise<void>;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
});

describe("useWorkflowRun", () => {
  it("replays, follows live, reconnects from the last seq, and stops at waiting", async () => {
    api.getWorkflowRunDetail.mockResolvedValue({
      run: run("running"),
      inputs: { q: 1 },
      events: [ev(1, "STEP_STARTED", "a#1")],
      hasMoreEvents: false,
    });
    const afterSeqs: number[] = [];
    const legs: Stream[] = [
      // First connection: one event, then the stream drops with the run still running.
      async (_u, _r, after, onFrame) => {
        afterSeqs.push(after);
        onFrame({ type: "status", run: run("running") });
        onFrame({ type: "event", event: ev(2, "STEP_FINISHED", "a#1") });
      },
      // Reconnect: the approval, then the closing status.
      async (_u, _r, after, onFrame) => {
        afterSeqs.push(after);
        onFrame({ type: "event", event: ev(3, "STEP_STARTED", "approve#1") });
        onFrame({
          type: "event",
          event: ev(4, "CUSTOM", "approve#1", {
            name: "HITL_INTERRUPT",
            value: {
              interrupt: {
                value: { message: "Ship?", payload: null, allowedDecisions: ["approve", "reject"] },
              },
            },
          }),
        });
        onFrame({ type: "status", run: run("waiting") });
      },
    ];
    api.streamWorkflowRunEvents.mockImplementation((...args: Parameters<Stream>) =>
      legs.shift()!(...args),
    );

    const { result } = renderHook(() => useWorkflowRun("run-1"));
    await waitFor(() => expect(result.current.run?.status).toBe("waiting"), { timeout: 3000 });
    await waitFor(() => expect(result.current.isLive).toBe(false));

    expect(afterSeqs).toEqual([1, 2]);
    expect(result.current.inputs).toEqual({ q: 1 });
    expect(result.current.view.lastSeq).toBe(4);
    const approve = result.current.view.byNode.approve[0];
    expect(approve.status).toBe("waiting");
    expect(approve.approval?.message).toBe("Ship?");
    expect(result.current.view.byNode.a[0].status).toBe("succeeded");
    expect(api.streamWorkflowRunEvents).toHaveBeenCalledTimes(2);

    // Resume: the bridge says running again, so the stream is followed again.
    api.resumeWorkflowRun.mockResolvedValue(run("running"));
    api.streamWorkflowRunEvents.mockImplementation(
      async (
        _u: string,
        _r: string,
        after: number,
        onFrame: (f: WorkflowRunStreamFrame) => void,
      ) => {
        afterSeqs.push(after);
        onFrame({ type: "event", event: ev(5, "STEP_STARTED", "approve#1") });
        onFrame({ type: "event", event: ev(6, "STEP_FINISHED", "approve#1") });
        onFrame({ type: "status", run: run("succeeded") });
      },
    );
    await act(async () => {
      await result.current.resume("approve", "ok");
    });
    expect(api.resumeWorkflowRun).toHaveBeenCalledWith("u1", "run-1", "approve", "ok");
    await waitFor(() => expect(result.current.run?.status).toBe("succeeded"));
    await waitFor(() => expect(result.current.view.lastSeq).toBe(6));
    expect(afterSeqs).toEqual([1, 2, 4]);
    expect(result.current.view.byNode.approve).toHaveLength(1);
    expect(result.current.view.byNode.approve[0].status).toBe("succeeded");
  });

  it("does not stream a finished run, and settles a cancelled run's open steps", async () => {
    api.getWorkflowRunDetail.mockResolvedValue({
      run: run("cancelled"),
      inputs: {},
      events: [ev(1, "STEP_STARTED", "slow#1")],
      hasMoreEvents: false,
    });
    const { result } = renderHook(() => useWorkflowRun("run-1"));
    await waitFor(() => expect(result.current.run?.status).toBe("cancelled"));
    expect(result.current.view.byNode.slow[0].status).toBe("cancelled");
    expect(result.current.isLive).toBe(false);
    expect(api.streamWorkflowRunEvents).not.toHaveBeenCalled();
  });

  it("loads nothing without a run id", () => {
    const { result } = renderHook(() => useWorkflowRun(null));
    expect(result.current.run).toBeNull();
    expect(result.current.view.executions).toEqual([]);
    expect(api.getWorkflowRunDetail).not.toHaveBeenCalled();
  });
});

describe("useWorkflowRuns", () => {
  it("pages runs and turns a 409 on start into a readable error", async () => {
    api.listWorkflowRuns
      .mockResolvedValueOnce({ items: [run("succeeded")], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [{ ...run("failed"), id: "run-0" }], nextCursor: null });
    const { result } = renderHook(() => useWorkflowRuns("wf-1"));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(["run-1", "run-0"]));
    expect(api.listWorkflowRuns).toHaveBeenLastCalledWith("u1", "wf-1", "c1");
    expect(result.current.hasMore).toBe(false);

    api.startWorkflowRun.mockRejectedValueOnce(new ApiError("conflict", { status: 409 }));
    await expect(result.current.startRun({})).rejects.toThrow(/already has a run in progress/);

    api.startWorkflowRun.mockResolvedValueOnce("run-2");
    api.listWorkflowRuns.mockResolvedValueOnce({ items: [run("queued")], nextCursor: null });
    await expect(result.current.startRun({ q: 1 })).resolves.toBe("run-2");
    expect(api.startWorkflowRun).toHaveBeenLastCalledWith("u1", "wf-1", { q: 1 });
  });
});

describe("useWorkflowQuickRun", () => {
  const withInputs = (inputs: { name: string; required?: boolean }[]) => ({
    id: "wf-1",
    name: "Deploy",
    description: null,
    latestVersionNo: 1,
    createdAt: null,
    updatedAt: null,
    spec: {
      version: 1,
      name: "Deploy",
      inputs: inputs.map((input) => ({ type: "string", ...input })),
      state: [],
      nodes: [],
      edges: [],
    },
  });

  it("starts a run with no inputs when none is required", async () => {
    api.getWorkflow.mockResolvedValueOnce(withInputs([{ name: "note", required: false }]));
    api.startWorkflowRun.mockResolvedValueOnce("run-9");
    const { result } = renderHook(() => useWorkflowQuickRun());
    await expect(result.current("wf-1")).resolves.toEqual({ started: true, runId: "run-9" });
    expect(api.getWorkflow).toHaveBeenCalledWith("u1", "wf-1");
    expect(api.startWorkflowRun).toHaveBeenCalledWith("u1", "wf-1", {});
  });

  it("starts nothing when an input is required, and reads a 409 as a message", async () => {
    api.getWorkflow.mockResolvedValueOnce(withInputs([{ name: "url", required: true }]));
    const { result } = renderHook(() => useWorkflowQuickRun());
    await expect(result.current("wf-1")).resolves.toEqual({ started: false });
    expect(api.startWorkflowRun).not.toHaveBeenCalled();

    api.getWorkflow.mockResolvedValueOnce(withInputs([]));
    api.startWorkflowRun.mockRejectedValueOnce(new ApiError("conflict", { status: 409 }));
    await expect(result.current("wf-1")).rejects.toThrow(/already has a run in progress/);
  });
});
