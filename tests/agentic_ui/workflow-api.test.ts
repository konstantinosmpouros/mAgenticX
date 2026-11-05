// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWorkflowCatalog,
  getWorkflowRunDetail,
  listWorkflows,
  resumeWorkflowRun,
  startWorkflowRun,
  streamWorkflowRunEvents,
} from "@/shared/lib/api";
import {
  isWorkflowsPath,
  workflowIdFromPath,
  workflowPath,
  workflowRunPath,
} from "@/features/workflows/lib/routes";
import type { WorkflowRunStreamFrame } from "@/shared/lib/types";

/**
 * The workflows API module (plan 38) and the view's URLs.
 *
 * Pinned: the `/api/v1/workflows…` and `/api/v1/workflow-runs…` paths; the run
 * detail follows `hasMoreEvents` pages from the last seq until complete; the
 * SSE reader turns `data:` frames (split across chunks, CRLF or LF) into typed
 * status/event frames and skips keep-alives and junk; mutations send CSRF;
 * responses are defaulted field by field (a run's unknown status reads failed).
 */

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "Deploy",
  versionNo: 3,
  triggerKind: "manual",
  status: "running",
  error: null,
  eventCount: 2,
  startedAt: "2026-11-04T10:00:00Z",
  finishedAt: null,
  createdAt: "2026-11-04T10:00:00Z",
  updatedAt: "2026-11-04T10:00:00Z",
  ...overrides,
});
const event = (seq: number) => ({
  seq,
  type: "STEP_STARTED",
  nodeId: "a",
  executionId: "a#1",
  parentExecutionId: null,
  payload: { type: "STEP_STARTED", stepName: "a" },
  createdAt: "2026-11-04T10:00:00Z",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A text/event-stream response delivering `chunks` one by one. */
const sse = (chunks: string[]) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "mx_csrf=tok";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const calledUrl = (index: number) => String(fetchMock.mock.calls[index][0]);
const calledInit = (index: number) => fetchMock.mock.calls[index][1] ?? {};

describe("workflows API", () => {
  it("lists workflows with defaults and drops rows without an id", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "wf-1", name: "Deploy" }, { name: "no id" }]));
    const workflows = await listWorkflows("u1");
    expect(calledUrl(0)).toBe("/api/v1/workflows/u1");
    expect(workflows).toEqual([
      {
        id: "wf-1",
        name: "Deploy",
        description: null,
        spec: null,
        latestVersionNo: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
  });

  it("reads the catalogue as a bare list", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          kind: "loop",
          label: "Loop",
          group: "flow",
          branches: ["continue", "done"],
          configSchema: {},
        },
      ]),
    );
    const [kind] = await getWorkflowCatalog();
    expect(calledUrl(0)).toBe("/api/v1/workflows/catalog");
    expect(kind).toMatchObject({
      kind: "loop",
      branches: ["continue", "done"],
      dynamicBranches: false,
      isTrigger: false,
    });
  });

  it("follows the run detail's event pages until complete", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ run: run(), inputs: { q: 1 }, events: [event(1), event(2)], hasMoreEvents: true }),
      )
      .mockResolvedValueOnce(
        json({
          run: run({ status: "succeeded" }),
          inputs: {},
          events: [event(3)],
          hasMoreEvents: false,
        }),
      );
    const detail = await getWorkflowRunDetail("u1", "run-1");
    expect(calledUrl(0)).toBe("/api/v1/workflow-runs/u1/run-1");
    expect(calledUrl(1)).toBe("/api/v1/workflow-runs/u1/run-1?after_seq=2");
    expect(detail.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(detail.inputs).toEqual({ q: 1 });
    expect(detail.run.status).toBe("succeeded");
    expect(detail.hasMoreEvents).toBe(false);
  });

  it("starts and resumes runs with CSRF", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ runId: "run-9" }, 202))
      .mockResolvedValueOnce(json(run({ status: "bogus" }), 202));
    expect(await startWorkflowRun("u1", "wf-1", { q: 1 })).toBe("run-9");
    expect(calledUrl(0)).toBe("/api/v1/workflows/u1/wf-1/runs");
    expect(calledInit(0).method).toBe("POST");
    expect(JSON.parse(String(calledInit(0).body))).toEqual({ inputs: { q: 1 } });
    expect(new Headers(calledInit(0).headers).get("X-CSRF-Token")).toBe("tok");

    const resumed = await resumeWorkflowRun("u1", "run-1", "reject", "  not now  ");
    expect(calledUrl(1)).toBe("/api/v1/workflow-runs/u1/run-1/resume");
    expect(JSON.parse(String(calledInit(1).body))).toEqual({
      decision: "reject",
      comment: "not now",
    });
    // An unknown status is never trusted as live.
    expect(resumed.status).toBe("failed");
  });

  it("parses the SSE stream across chunk boundaries", async () => {
    const status = JSON.stringify({ type: "status", run: run() });
    const ev = JSON.stringify({ type: "event", event: event(3) });
    fetchMock.mockResolvedValueOnce(
      sse([
        `data: ${status}\r\n\r\n`,
        ": keep-alive\n\n",
        `id: 3\ndata: ${ev.slice(0, 20)}`,
        `${ev.slice(20)}\n\n`,
        "data: not json\n\n",
        `data: ${JSON.stringify({ type: "mystery" })}\n\n`,
        `data: ${JSON.stringify({ type: "status", run: run({ status: "succeeded" }) })}`,
      ]),
    );
    const frames: WorkflowRunStreamFrame[] = [];
    await streamWorkflowRunEvents("u1", "run-1", 2, (frame) => frames.push(frame));
    expect(calledUrl(0)).toBe("/api/v1/workflow-runs/u1/run-1/events/stream?after_seq=2");
    expect(new Headers(calledInit(0).headers).get("Accept")).toBe("text/event-stream");
    expect(
      frames.map((f) => (f.type === "status" ? `status:${f.run.status}` : `event:${f.event.seq}`)),
    ).toEqual(["status:running", "event:3", "status:succeeded"]);
  });
});

describe("workflow routes", () => {
  it("builds and reads the view's URLs", () => {
    expect(workflowPath("wf 1")).toBe("/workflows/wf%201");
    expect(workflowRunPath("wf-1", "run-1")).toBe("/workflows/wf-1/runs/run-1");
    expect(isWorkflowsPath("/workflows/wf-1/runs/run-1")).toBe(true);
    expect(isWorkflowsPath("/workflowsX")).toBe(false);
    expect(workflowIdFromPath("/workflows/wf%201/runs/r")).toBe("wf 1");
    expect(workflowIdFromPath("/automations")).toBeNull();
  });
});
