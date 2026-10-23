// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import;
// the answer text is not what these tests look at.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { TimelineSequence } from "@/features/chat/components/message_parts/TimelineSequence";
import {
  createTimeline,
  finalizeTimeline,
  foldTimeline,
  reduceTimelineEvents,
  subagentRunStatus,
} from "@/features/inference/timeline";
import type { RunTimeline, SubagentBlock } from "@/shared/lib/types";

/**
 * The sub-agent run status (the DESEL-style live card).
 *
 * Pinned: SUBAGENT_COMPLETED closes the right card whether the sub-agent's
 * events were keyed by its `task` call id or by its namespace (the two ids the
 * wire uses); a sub-agent paused on an approval waits, it does not fail; the
 * run's end closes the still-running ones as done / failed / cancelled, kept
 * apart; a `task` call that never ran never spins and has no card once the run
 * is over; a run that is not live never shows a sub-agent at work; and a
 * finished run keeps its sub-agent cards inline in the message.
 */

type Event = Record<string, unknown>;

const task = (taskId: string, subagentType = "researcher", description = `Do ${taskId}`): Event => ({
  type: "CUSTOM",
  name: "TASK_SUBAGENT",
  value: { task_id: taskId, subagent_type: subagentType, description },
});

const inside = (taskId: string, namespace: string[], event: Event, timestamp = 1_000): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_EVENT",
  timestamp,
  value: { task_id: taskId, namespace, event },
});

const thought = (text: string): Event => ({ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: text });

const completed = (taskId: string, extra: Event = {}): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_COMPLETED",
  timestamp: 9_000,
  value: { task_id: taskId, status: "completed", ...extra },
});

const interrupt = (id: string, action: string): Event => ({
  type: "CUSTOM",
  name: "HITL_INTERRUPT",
  value: {
    thread_id: "thread-1",
    interrupt: { id, value: { action_requests: [{ action, args: {} }] } },
  },
});

const resolved = (id: string, decision: "approve" | "reject"): Event => ({
  type: "CUSTOM",
  name: "BRIDGE_HITL_RESOLVED",
  value: { interrupt_id: id, decision },
});

const fold = (events: Event[]): RunTimeline => reduceTimelineEvents(createTimeline(), events);

const subagents = (state: RunTimeline) =>
  state.blocks.filter((block): block is SubagentBlock => block.kind === "subagent");

const byTask = (state: RunTimeline, taskId: string) =>
  subagents(state).find((block) => block.taskId === taskId) as SubagentBlock;

const shown = (state: RunTimeline, taskId: string, live: boolean) =>
  subagentRunStatus(byTask(state, taskId), state, live);

describe("sub-agent run status", () => {
  it("completes the card its task call id names, leaving a parallel one running", () => {
    const state = fold([
      task("call-a"),
      task("call-b", "writer"),
      inside("call-a", ["tools:ns-a"], thought("a"), 1_000),
      inside("call-b", ["tools:ns-b"], thought("b"), 2_000),
      completed("call-a"),
    ]);

    expect(shown(state, "call-a", true)).toBe("done");
    expect(shown(state, "call-b", true)).toBe("running");
    const done = byTask(state, "call-a");
    expect(done.startedAt).toBe(1_000);
    expect(done.endedAt).toBe(9_000);
  });

  it("takes the completion's own timestamps when it carries them", () => {
    const state = fold([
      task("call-a"),
      inside("call-a", ["tools:ns-a"], thought("a"), 5_000),
      completed("call-a", { started_at: 4_000, ended_at: 7_500 }),
    ]);
    expect(byTask(state, "call-a").startedAt).toBe(5_000);
    expect(byTask(state, "call-a").endedAt).toBe(7_500);
  });

  it("marks a sub-agent whose task call errored as failed", () => {
    const state = fold([
      task("call-a"),
      inside("call-a", ["tools:ns-a"], thought("a")),
      completed("call-a", { status: "error" }),
    ]);
    expect(shown(state, "call-a", true)).toBe("failed");
  });

  it("completes the namespace-keyed card when the events never carried the call id", () => {
    // A resume that lost the namespace→call binding: the sub-agent's events
    // come with the namespace-derived id, open their own block, and the call-id
    // block stays unspawned. The completion names the call id AND the
    // namespace: the card that really ran must stop spinning.
    const state = fold([
      task("call-a"),
      inside("ns-uuid", ["tools:ns-uuid"], thought("working")),
      completed("call-a", { namespace: ["tools:ns-uuid"] }),
    ]);

    const orphan = byTask(state, "ns-uuid");
    expect(subagentRunStatus(orphan, state, true)).toBe("done");
    // It inherits the task's metadata, and the never-spawned call block has no card.
    expect(orphan.description).toBe("Do call-a");
    expect(orphan.type).toBe("researcher");
    expect(shown(state, "call-a", true)).toBeNull();
  });

  it("resolves a completion through the task-id remap (BEFORE_AGENT aliasing)", () => {
    const state = fold([
      task("call-a"),
      inside("wrapper-x", ["tools:ns-x"], {
        type: "CUSTOM",
        name: "BEFORE_AGENT_EVENT",
        value: { message: "", metadata: { namespace: "call-a" } },
      }),
      inside("wrapper-x", ["tools:ns-x"], thought("working")),
      completed("wrapper-x"),
    ]);
    expect(subagents(state)).toHaveLength(1);
    expect(shown(state, "call-a", true)).toBe("done");
  });

  it("shows a sub-agent paused on its own approval as awaiting approval, not failed", () => {
    const paused = fold([
      task("call-a"),
      inside("call-a", ["tools:ns-a"], thought("a")),
      inside("call-a", ["tools:ns-a"], interrupt("int-1", "write_file")),
    ]);
    expect(shown(paused, "call-a", true)).toBe("awaiting_approval");
    // The stream ends on the pause (or the page is reloaded): still waiting.
    expect(shown(paused, "call-a", false)).toBe("awaiting_approval");

    const resumed = reduceTimelineEvents(paused, [
      resolved("int-1", "approve"),
      inside("call-a", ["tools:ns-a"], thought("after")),
    ]);
    expect(shown(resumed, "call-a", true)).toBe("running");
  });

  it("waits with the task call's own approval, and has no card once rejected", () => {
    const gated = fold([task("call-a"), interrupt("int-task", "task")]);
    expect(shown(gated, "call-a", false)).toBe("awaiting_approval");

    const rejected = reduceTimelineEvents(gated, [
      resolved("int-task", "reject"),
      completed("call-a", { status: "error" }),
    ]);
    expect(shown(rejected, "call-a", true)).toBeNull();
    expect(subagentRunStatus(byTask(rejected, "call-a"), finalizeTimeline(rejected, "completed"), false)).toBeNull();
  });

  it("never spins for a task call that has not spawned", () => {
    const state = fold([task("call-a")]);
    expect(shown(state, "call-a", true)).toBe("pending");
    const finished = finalizeTimeline(state, "completed");
    expect(subagentRunStatus(byTask(finished, "call-a"), finished, false)).toBeNull();
    expect(byTask(finished, "call-a").status).toBe("pending");
  });

  it.each([
    ["completed", "done"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("closes still-running sub-agents when the run is %s", (runStatus, expected) => {
    const state = finalizeTimeline(
      fold([
        task("call-a"),
        task("call-b"),
        inside("call-a", ["tools:ns-a"], thought("a")),
        inside("call-b", ["tools:ns-b"], thought("b")),
        completed("call-a"),
      ]),
      runStatus,
    );
    // The one that returned keeps its own status; the other ends with the run.
    expect(shown(state, "call-a", false)).toBe("done");
    expect(shown(state, "call-b", false)).toBe(expected);
  });

  it("re-closes run-ended sub-agents if the run's terminal status changes", () => {
    const state = fold([task("call-a"), inside("call-a", ["tools:ns-a"], thought("a"))]);
    const cancelled = finalizeTimeline(state, "cancelled");
    const failed = finalizeTimeline(cancelled, "failed");
    expect(shown(failed, "call-a", false)).toBe("failed");
  });

  it("never shows a sub-agent at work for a run that is not live (reload mid-run)", () => {
    const state = foldTimeline([task("call-a"), inside("call-a", ["tools:ns-a"], thought("a"))], {
      status: "running",
    });
    expect(state.terminal).toBe(false);
    expect(shown(state, "call-a", true)).toBe("running");
    expect(shown(state, "call-a", false)).toBe("cancelled");
  });
});

describe("sub-agent cards after the run", () => {
  const finishedRun = () =>
    foldTimeline(
      [
        { type: "THINKING_START" },
        thought("planning"),
        { type: "THINKING_END" },
        task("call-a", "researcher", "Find the filing deadlines"),
        task("call-b", "writer", "Draft the summary"),
        inside("call-a", ["tools:ns-a"], thought("a"), 1_000),
        inside("call-b", ["tools:ns-b"], thought("b"), 1_000),
        completed("call-a", { ended_at: 43_000 }),
        { type: "TEXT_MESSAGE_CONTENT", delta: "Here is the answer." },
      ],
      { status: "completed" },
    );

  const renderTimeline = (timeline: RunTimeline, isStreaming: boolean) =>
    render(
      <TimelineSequence
        timeline={timeline}
        runId="run-1"
        isStreaming={isStreaming}
        expandedThinking={{}}
        onToggleThinking={() => {}}
      />,
    );

  it("keeps a finished run's sub-agent cards inline, with their final status", () => {
    const { container } = renderTimeline(finishedRun(), false);

    const cards = container.querySelectorAll(".subagent-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Find the filing deadlines")).toBeInTheDocument();
    expect(screen.getByText("Draft the summary")).toBeInTheDocument();
    expect([...cards].map((card) => card.getAttribute("data-status"))).toEqual(["done", "done"]);
    // Nothing spins once the run is over.
    expect(container.querySelector('.subagent-card[data-active="true"]')).toBeNull();
    // Duration of the one that reported its end.
    expect(screen.getByText("42s")).toBeInTheDocument();
  });

  it("drops a rejected task call's card after the run and merges the thinking around it", () => {
    const timeline = foldTimeline(
      [
        thought("first"),
        task("call-x"),
        interrupt("int-task", "task"),
        resolved("int-task", "reject"),
        thought("second"),
        { type: "TEXT_MESSAGE_CONTENT", delta: "Done without it." },
      ],
      { status: "completed" },
    );
    const { container } = renderTimeline(timeline, false);
    expect(container.querySelectorAll(".subagent-card")).toHaveLength(0);
  });

  it("animates the ring only on a sub-agent that is running in a live run", () => {
    const live = fold([
      task("call-a"),
      task("call-b"),
      inside("call-a", ["tools:ns-a"], thought("a")),
      inside("call-b", ["tools:ns-b"], thought("b")),
      completed("call-a"),
    ]);
    const { container } = renderTimeline(live, true);
    const active = container.querySelectorAll('.subagent-card[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-status")).toBe("running");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });
});
