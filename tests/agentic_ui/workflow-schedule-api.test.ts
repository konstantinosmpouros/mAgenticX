// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkflows } from "@/features/workflows/hooks/useWorkflows";
import { useWorkflowSchedulePause } from "@/features/workflows/hooks/useWorkflowSchedulePause";
import { listWorkflows, pauseWorkflowSchedule, resumeWorkflowSchedule } from "@/shared/lib/api";
import type { WorkflowSchedule } from "@/shared/lib/types";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * Pause / resume a workflow's schedule (plan 38, step 4 UI):
 * `POST /v1/workflows/{user}/{wf}/schedule/pause|resume` with CSRF, the
 * answer (`WorkflowScheduleOut`) read through its Zod schema; a workflow
 * list's `schedule` read the same way; and the hook that flips the list
 * entry at once, then lands the server's answer — or the old schedule back
 * when the call fails.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "mx_csrf=tok";
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
});
afterEach(() => vi.unstubAllGlobals());

const call = (index = 0) => ({
  url: String(fetchMock.mock.calls[index][0]),
  init: fetchMock.mock.calls[index][1] ?? {},
});
const csrfOf = (init: RequestInit) => new Headers(init.headers).get("X-CSRF-Token");

const wire = (patch: Record<string, unknown> = {}) => ({
  status: "active",
  kind: "interval",
  spec: { interval_seconds: 3600 },
  timezone: null,
  nextRunAt: "2026-11-04T11:00:00Z",
  lastRunAt: "2026-11-04T10:00:00Z",
  lastRunStatus: "succeeded",
  ...patch,
});

describe("schedule pause / resume API", () => {
  it("pauses with POST …/schedule/pause and CSRF, reading WorkflowScheduleOut", async () => {
    fetchMock.mockResolvedValueOnce(json(wire({ status: "paused", extra: "ignored" })));
    const schedule = await pauseWorkflowSchedule("u1", "wf 1");
    const { url, init } = call();
    expect(url).toBe("/api/v1/workflows/u1/wf%201/schedule/pause");
    expect(init.method).toBe("POST");
    expect(csrfOf(init)).toBe("tok");
    expect(schedule).toEqual({
      status: "paused",
      kind: "interval",
      spec: { interval_seconds: 3600 },
      timezone: null,
      nextRunAt: "2026-11-04T11:00:00Z",
      lastRunAt: "2026-11-04T10:00:00Z",
      lastRunStatus: "succeeded",
    });
  });

  it("resumes with POST …/schedule/resume; an unknown status reads as active", async () => {
    fetchMock.mockResolvedValueOnce(json(wire({ status: "weird", spec: "nope" })));
    const schedule = await resumeWorkflowSchedule("u1", "wf-1");
    expect(call().url).toBe("/api/v1/workflows/u1/wf-1/schedule/resume");
    expect(csrfOf(call().init)).toBe("tok");
    expect(schedule).toMatchObject({ status: "active", spec: {} });
  });

  it("surfaces a 404 (no schedule) as an error", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "This workflow has no schedule." }, 404));
    await expect(pauseWorkflowSchedule("u1", "wf-1")).rejects.toThrow(/no schedule/);
  });

  it("reads each listed workflow's schedule, null when it has none", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { id: "wf-1", name: "A", schedule: wire() },
        { id: "wf-2", name: "B", schedule: null },
      ]),
    );
    const list = await listWorkflows("u1");
    expect(list[0].schedule).toMatchObject({ status: "active", nextRunAt: "2026-11-04T11:00:00Z" });
    expect(list[1].schedule).toBeNull();
  });
});

describe("pausing from a workflow list, optimistically", () => {
  it("flips the list entry at once, then lands the server's answer", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "wf-1", name: "A", schedule: wire() }]));
    const { result } = renderHook(() => ({
      list: useWorkflows(),
      pause: useWorkflowSchedulePause(),
    }));
    await waitFor(() => expect(result.current.list.workflows).toHaveLength(1));

    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    const current = result.current.list.workflows[0].schedule as WorkflowSchedule;
    let done: Promise<WorkflowSchedule> = Promise.resolve(current);
    act(() => {
      done = result.current.pause("wf-1", current, true, (next) =>
        result.current.list.setSchedule("wf-1", next),
      );
    });
    // Before the server answers: already paused.
    expect(result.current.list.workflows[0].schedule?.status).toBe("paused");
    expect(call(1).url).toBe("/api/v1/workflows/u1/wf-1/schedule/pause");
    await act(async () => {
      release(json(wire({ status: "paused", nextRunAt: null })));
      await done;
    });
    expect(result.current.list.workflows[0].schedule).toMatchObject({
      status: "paused",
      nextRunAt: null,
    });
  });

  it("puts the old schedule back when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ id: "wf-1", name: "A", schedule: wire({ status: "paused" }) }]),
    );
    const { result } = renderHook(() => ({
      list: useWorkflows(),
      pause: useWorkflowSchedulePause(),
    }));
    await waitFor(() => expect(result.current.list.workflows).toHaveLength(1));
    fetchMock.mockResolvedValueOnce(json({ detail: "Boom." }, 500));
    const current = result.current.list.workflows[0].schedule as WorkflowSchedule;
    await act(async () => {
      await expect(
        result.current.pause("wf-1", current, false, (next) =>
          result.current.list.setSchedule("wf-1", next),
        ),
      ).rejects.toThrow();
    });
    expect(call(1).url).toBe("/api/v1/workflows/u1/wf-1/schedule/resume");
    expect(result.current.list.workflows[0].schedule).toEqual(current);
  });
});
