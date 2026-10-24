import { describe, expect, it } from "vitest";

import { buildAnswerNodes } from "@/features/chat/lib/agentMap";
import {
  createTimeline,
  finalizeTimeline,
  reduceTimelineEvents,
  subagentRunStatus,
} from "@/features/inference/timeline";
import type { RunTimeline, SubagentBlock } from "@/shared/lib/types";

/**
 * A sub-agent that delegates in turn, with the events in the exact shape the
 * agents service emits them (tests/agents/test_agui_nested_subagents.py drives
 * a real nested deepagents run through the normalizer to pin that shape):
 *
 *  - the nested `task` call (TASK_SUBAGENT) arrives inside the parent's envelope;
 *  - the nested sub-agent's own events arrive as top-level SUBAGENT_EVENTs keyed
 *    by its `task` call id, its namespace one segment deeper than its parent's;
 *  - its SUBAGENT_COMPLETED arrives INSIDE the parent's envelope, because the
 *    `task` result is a message of the parent's graph, not the orchestrator's.
 */

type Event = Record<string, unknown>;

const R_NS = ["tools:r1"];
const C_NS = ["tools:r1", "tools:c1"];

const inside = (taskId: string, namespace: string[], event: Event, timestamp?: number): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_EVENT",
  value: { task_id: taskId, namespace, event },
  ...(timestamp !== undefined ? { timestamp } : {}),
});

const taskCall = (taskId: string, type: string, description: string): Event => ({
  type: "CUSTOM",
  name: "TASK_SUBAGENT",
  value: { task_id: taskId, subagent_type: type, description },
});

const beforeAgent = (taskId: string, namespace: string[], at: number): Event =>
  inside(
    taskId,
    namespace,
    { type: "CUSTOM", name: "BEFORE_AGENT_EVENT", value: { message: "", metadata: { namespace: taskId } } },
    at,
  );

const completedEvent = (taskId: string, namespace: string[], startedAt: number, endedAt: number): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_COMPLETED",
  value: { task_id: taskId, status: "completed", namespace, started_at: startedAt, ended_at: endedAt },
});

/** main → researcher → checker; the checker has returned, the researcher works on. */
const checkerReturned = (): Event[] => [
  taskCall("call-research", "researcher", "Find prices"),
  beforeAgent("call-research", R_NS, 1_000),
  inside("call-research", R_NS, taskCall("call-check", "checker", "Check the prices")),
  beforeAgent("call-check", C_NS, 2_000),
  inside("call-check", C_NS, { type: "TOOL_CALL_START", toolCallId: "s1", toolCallName: "search" }),
  inside("call-check", C_NS, { type: "TOOL_CALL_RESULT", toolCallId: "s1", content: "ok" }),
  inside("call-check", C_NS, { type: "TEXT_MESSAGE_CHUNK", messageId: "m", delta: "checked: prices ok" }),
  inside("call-research", R_NS, completedEvent("call-check", C_NS, 2_000, 5_000)),
];

const subagent = (timeline: RunTimeline, taskId: string): SubagentBlock => {
  const block = timeline.blocks.find(
    (candidate): candidate is SubagentBlock =>
      candidate.kind === "subagent" && candidate.taskId === taskId,
  );
  if (!block) throw new Error(`no sub-agent block for ${taskId}`);
  return block;
};

describe("a sub-agent of a sub-agent", () => {
  it("settles the nested sub-agent when its completion arrives inside its parent's stream", () => {
    const timeline = reduceTimelineEvents(createTimeline(), checkerReturned());
    const checker = subagent(timeline, "call-check");

    expect(checker).toMatchObject({
      status: "done",
      startedAt: 2_000,
      endedAt: 5_000,
      parentTaskId: "call-research",
      type: "checker",
      namespace: "tools:r1 / tools:c1",
    });
    expect(subagentRunStatus(checker, timeline, true)).toBe("done");
    // The parent is still working.
    expect(subagentRunStatus(subagent(timeline, "call-research"), timeline, true)).toBe("running");
  });

  it("shows it done, with its own time and tools, under its parent in the agent map while the run streams", () => {
    const timeline = reduceTimelineEvents(createTimeline(), checkerReturned());
    const [researcher] = buildAnswerNodes("a1", timeline, true);

    expect(researcher).toMatchObject({ taskId: "call-research", status: "running" });
    expect(researcher.children).toHaveLength(1);
    expect(researcher.children[0]).toMatchObject({
      taskId: "call-check",
      title: "Checker",
      task: "Check the prices",
      status: "done",
      durationMs: 3_000,
      toolCount: 1,
      depth: 2,
    });
  });

  it("keeps the nested sub-agent's own end time when the run settles", () => {
    const events = [
      ...checkerReturned(),
      completedEvent("call-research", R_NS, 1_000, 9_000),
    ];
    const timeline = finalizeTimeline(reduceTimelineEvents(createTimeline(), events), "completed");
    const checker = subagent(timeline, "call-check");

    expect(checker.status).toBe("done");
    expect(checker.endedByRun).toBeUndefined();
    expect(checker.endedAt).toBe(5_000);
    // The completion is not a step of the parent's own reply.
    const researcher = subagent(timeline, "call-research");
    expect(researcher.status).toBe("done");
    expect(researcher.blocks).toEqual([]);
  });

  it("reports a failed nested sub-agent as failed", () => {
    const events = checkerReturned();
    events[events.length - 1] = inside("call-research", R_NS, {
      ...completedEvent("call-check", C_NS, 2_000, 4_000),
      value: { task_id: "call-check", status: "error", namespace: C_NS, started_at: 2_000, ended_at: 4_000 },
    });
    const timeline = reduceTimelineEvents(createTimeline(), events);

    expect(subagent(timeline, "call-check").status).toBe("failed");
  });
});
