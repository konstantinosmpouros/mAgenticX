// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  DECISION_IN_FLIGHT_GRACE_MS,
  dropDecision,
  isDecisionInFlight,
  markDecisionSent,
  nextDecisionDeadline,
  pruneExpiredDecisions,
  settleDecisionsForRun,
  type DecisionsInFlight,
} from "@/features/inference/decisionsInFlight";

/**
 * An approval the bridge accepted (HTTP 200) shows "Decision sent" only until
 * the run's BRIDGE_HITL_RESOLVED marker lands — or, if it never does, until a
 * quiet window runs out and the approval is offered again. It used to be marked
 * resolved forever on the 200: when the bridge lost one of three parallel
 * decisions, the run waited on an approval the UI no longer showed.
 */

const RUN = "run-1";
const T0 = 1_000_000;
const empty: DecisionsInFlight = new Map();

describe("decisions in flight", () => {
  it("shows a sent decision until its window closes", () => {
    const sent = markDecisionSent(empty, RUN, "int-1", T0);
    expect(isDecisionInFlight(sent, RUN, "int-1", T0 + 1)).toBe(true);
    expect(isDecisionInFlight(sent, RUN, "int-2", T0 + 1)).toBe(false);
    expect(isDecisionInFlight(sent, "run-2", "int-1", T0 + 1)).toBe(false);
    expect(isDecisionInFlight(sent, RUN, "int-1", T0 + DECISION_IN_FLIGHT_GRACE_MS)).toBe(false);
    expect(nextDecisionDeadline(sent)).toBe(T0 + DECISION_IN_FLIGHT_GRACE_MS);
    expect(nextDecisionDeadline(empty)).toBeNull();
  });

  it("drops a decision once the log resolves it, and keeps the others", () => {
    let sent = markDecisionSent(empty, RUN, "int-1", T0);
    sent = markDecisionSent(sent, RUN, "int-2", T0);
    const settled = settleDecisionsForRun(
      sent,
      { runId: RUN, active: true, pendingInterruptIds: ["int-2", "int-3"], streamed: false },
      T0 + 10,
    );
    expect(isDecisionInFlight(settled, RUN, "int-1", T0 + 10)).toBe(false);
    expect(isDecisionInFlight(settled, RUN, "int-2", T0 + 10)).toBe(true);
  });

  it("drops every decision of a run that ended", () => {
    const sent = markDecisionSent(markDecisionSent(empty, RUN, "int-1", T0), "run-2", "int-9", T0);
    const settled = settleDecisionsForRun(
      sent,
      { runId: RUN, active: false, pendingInterruptIds: ["int-1"], streamed: true },
      T0,
    );
    expect(isDecisionInFlight(settled, RUN, "int-1", T0)).toBe(false);
    expect(isDecisionInFlight(settled, "run-2", "int-9", T0)).toBe(true);
  });

  it("keeps waiting while the run streams (a queued decision goes out after the running leg)", () => {
    const sent = markDecisionSent(empty, RUN, "int-2", T0);
    const later = T0 + DECISION_IN_FLIGHT_GRACE_MS - 1;
    const rearmed = settleDecisionsForRun(
      sent,
      { runId: RUN, active: true, pendingInterruptIds: ["int-2"], streamed: true },
      later,
    );
    expect(isDecisionInFlight(rearmed, RUN, "int-2", T0 + DECISION_IN_FLIGHT_GRACE_MS + 5)).toBe(true);
    // A meta-only frame is not activity.
    const quiet = settleDecisionsForRun(
      sent,
      { runId: RUN, active: true, pendingInterruptIds: ["int-2"], streamed: false },
      later,
    );
    expect(quiet).toBe(sent);
  });

  it("offers the approval again when the window runs out with no resolution", () => {
    const sent = markDecisionSent(markDecisionSent(empty, RUN, "int-1", T0), RUN, "int-2", T0 + 5_000);
    const pruned = pruneExpiredDecisions(sent, T0 + DECISION_IN_FLIGHT_GRACE_MS);
    expect([...pruned.keys()]).toEqual([`${RUN}:int-2`]);
    expect(pruneExpiredDecisions(pruned, T0)).toBe(pruned);
  });

  it("forgets a decision whose request failed", () => {
    const sent = markDecisionSent(empty, RUN, "int-1", T0);
    expect(isDecisionInFlight(dropDecision(sent, RUN, "int-1"), RUN, "int-1", T0)).toBe(false);
    expect(dropDecision(empty, RUN, "int-1")).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// The hook: what the approval surfaces read through isDecisionInFlight
// ---------------------------------------------------------------------------
const api = vi.hoisted(() => ({
  startInference: vi.fn(),
  resumeInferenceRun: vi.fn(),
  cancelInferenceRun: vi.fn(),
  // Hydration stays out of the way: the run under test comes from beginRun.
  getActiveInferenceRuns: vi.fn(() => new Promise(() => {})),
  connectInferenceWebSocket: vi.fn(),
}));
vi.mock("@/shared/lib/api", () => api);

const { useInferenceRuns } = await import("@/features/inference/useInferenceRuns");

const hitl = (id: string) => ({
  type: "CUSTOM",
  name: "HITL_INTERRUPT",
  value: {
    thread_id: "thread-1",
    interrupt: { id, value: { action_requests: [{ name: "edit_file", args: {} }] } },
  },
});
const resolved = (id: string) => ({
  type: "CUSTOM",
  name: "BRIDGE_HITL_RESOLVED",
  value: { interrupt_id: id, decision: "approve" },
});

const run = (rawEvents: Record<string, unknown>[] = []) => ({
  id: RUN,
  userId: "user-1",
  conversationId: "conv-1",
  assistantMessageId: RUN,
  status: "running",
  messagePath: [],
  rawEvents,
  pendingInterrupts: 3,
  startedAt: new Date(T0),
  updatedAt: new Date(T0),
});

type Frame = { type: string; run: ReturnType<typeof run>; events?: Record<string, unknown>[] };

describe("useInferenceRuns: approvals stay actionable until the bridge applies them", () => {
  let push: (frame: Frame) => void = () => {};
  const toast = vi.fn();

  beforeEach(() => {
    api.connectInferenceWebSocket.mockImplementation(
      (_user: string, _run: string, onEvent: (frame: Frame) => void) => {
        push = onEvent;
        return new Promise(() => {});
      },
    );
    api.startInference.mockResolvedValue({
      run: run([hitl("int-1"), hitl("int-2"), hitl("int-3")]),
      message: null,
      summary: { id: "conv-1", isPrivate: false, updated_at: new Date(T0).toISOString() },
      detail: { id: "conv-1", messages: [] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const mount = async () => {
    const hook = renderHook(() =>
      useInferenceRuns({
        userId: "user-1",
        setConversations: vi.fn(),
        setCurrentConversation: vi.fn(),
        setThinkingState: vi.fn(),
        toast,
      }),
    );
    await act(async () => {
      await hook.result.current.beginRun({ mode: "send", conversationId: "conv-1" } as never);
    });
    return hook;
  };

  const decide = async (hook: Awaited<ReturnType<typeof mount>>, interruptId: string) => {
    await act(async () => {
      await hook.result.current.resumeRun(RUN, { interruptId, threadId: "t", decision: "approve" });
    });
  };

  it("shows 'Decision sent' after a 200 and settles it on the resolved marker", async () => {
    api.resumeInferenceRun.mockResolvedValue(run());
    const hook = await mount();
    await decide(hook, "int-1");
    await decide(hook, "int-2");
    expect(hook.result.current.isDecisionInFlight(RUN, "int-1")).toBe(true);
    expect(hook.result.current.isDecisionInFlight(RUN, "int-2")).toBe(true);
    expect(hook.result.current.isDecisionInFlight(RUN, "int-3")).toBe(false);

    act(() => push({ type: "events", run: run(), events: [resolved("int-1")] }));
    // int-1 is resolved in the log now (its timeline item is no longer pending).
    expect(hook.result.current.isDecisionInFlight(RUN, "int-1")).toBe(false);
    expect(hook.result.current.isDecisionInFlight(RUN, "int-2")).toBe(true);
  });

  it("brings a decision that never resolves back as an approval to act on", async () => {
    api.resumeInferenceRun.mockResolvedValue(run());
    const hook = await mount();
    await decide(hook, "int-3");
    expect(hook.result.current.isDecisionInFlight(RUN, "int-3")).toBe(true);

    // From here the clock is ours (the window was armed on the real one).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    // The run keeps streaming for a while: still waiting for the marker.
    act(() => vi.advanceTimersByTime(DECISION_IN_FLIGHT_GRACE_MS - 1_000));
    act(() => push({ type: "events", run: run(), events: [{ type: "TEXT_MESSAGE_CONTENT", delta: "…" }] }));
    act(() => vi.advanceTimersByTime(DECISION_IN_FLIGHT_GRACE_MS - 1_000));
    expect(hook.result.current.isDecisionInFlight(RUN, "int-3")).toBe(true);

    // Then nothing — the run sits paused with no resolution: offer it again.
    act(() => vi.advanceTimersByTime(2_000));
    expect(hook.result.current.isDecisionInFlight(RUN, "int-3")).toBe(false);
  });

  it("keeps the approval and shows the bridge's reason on a 409", async () => {
    const conflict = Object.assign(new Error("This approval is not pending on the run any more."), { status: 409 });
    api.resumeInferenceRun.mockRejectedValue(conflict);
    const hook = await mount();
    await act(async () => {
      await expect(
        hook.result.current.resumeRun(RUN, { interruptId: "int-2", threadId: "t", decision: "approve" }),
      ).rejects.toBe(conflict);
    });
    expect(hook.result.current.isDecisionInFlight(RUN, "int-2")).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not send your decision",
        description: "This approval is not pending on the run any more.",
        variant: "destructive",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// A decision the agent could no longer take
// ---------------------------------------------------------------------------
describe("an expired approval", () => {
  it("leaves no pending card and reads as not applied, with the reason", async () => {
    const { foldTimeline, pendingTimelineInterrupts } = await import("@/features/inference/timeline");
    const reason = "Not applied: this approval was no longer pending on the agent.";
    const timeline = foldTimeline(
      [
        hitl("int-1"),
        hitl("int-2"),
        // The approve marker sent with the batch, then the bridge's void one.
        resolved("int-1"),
        {
          type: "CUSTOM",
          name: "BRIDGE_HITL_RESOLVED",
          value: { interrupt_id: "int-1", decision: "expired", reason, decisions: null },
        },
      ],
      { status: "running" },
    );
    expect(pendingTimelineInterrupts(timeline).map((item) => item.id)).toEqual(["int-2"]);
    const expired = timeline.interrupts.find((item) => item.id === "int-1");
    expect(expired?.status).toBe("rejected");
    expect(expired?.reason).toBe(reason);
  });
});
