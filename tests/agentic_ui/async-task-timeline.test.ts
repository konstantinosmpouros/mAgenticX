import { describe, expect, it } from "vitest";

import {
  createTimeline,
  finalizeTimeline,
  foldTimeline,
  reduceTimelineEvents,
  subagentRunStatus,
} from "@/features/inference/timeline";
import type { SubagentBlock } from "@/shared/lib/types";

/**
 * A run's own stream under plan 41: a background task shows up as a "Started
 * task" reference block (TASK_LAUNCHED) and, when its result is pulled into a
 * busy run, an inline marker (TASK_SETTLED_INLINE). Neither — nor an async
 * task's card — is ended by the run ending: the task outlives the run.
 */

const launched = (taskId: string, name = "researcher") => ({
  type: "CUSTOM",
  name: "TASK_LAUNCHED",
  value: { task_id: taskId, name, description: "Find the sources" },
});

describe("TASK_LAUNCHED / TASK_SETTLED_INLINE in a run's stream", () => {
  it("opens a reference block at the log position, between the text around it", () => {
    const timeline = foldTimeline([
      { type: "TEXT_MESSAGE_CONTENT", delta: "Delegating. " },
      launched("t1"),
      { type: "TEXT_MESSAGE_CONTENT", delta: "Meanwhile…" },
    ]);
    expect(timeline.blocks.map((block) => block.kind)).toEqual(["content", "task_ref", "content"]);
    expect(timeline.blocks[1]).toMatchObject({
      kind: "task_ref",
      taskId: "t1",
      name: "researcher",
      description: "Find the sources",
    });
  });

  it("reads the event whether it comes as CUSTOM or as a type of its own", () => {
    const timeline = foldTimeline([
      { type: "TASK_LAUNCHED", task_id: "t1", name: "researcher" },
      { type: "TASK_SETTLED_INLINE", task_id: "t1", name: "researcher", status: "error" },
    ]);
    expect(timeline.blocks).toMatchObject([
      { kind: "task_ref", taskId: "t1" },
      { kind: "task_settled", taskId: "t1", status: "error" },
    ]);
  });

  it("marks the block of an update to an existing task (shown as 'Updated task')", () => {
    const timeline = foldTimeline([
      { type: "CUSTOM", name: "TASK_LAUNCHED", value: { task_id: "t1", name: "", description: "Carry on", action: "update" } },
      launched("t2"),
    ]);
    expect(timeline.blocks).toMatchObject([
      { kind: "task_ref", taskId: "t1", action: "update" },
      { kind: "task_ref", taskId: "t2" },
    ]);
    expect(timeline.blocks[1]).not.toHaveProperty("action");
  });

  it("draws one block per task when a resume replays the launch", () => {
    const timeline = foldTimeline([launched("t1"), launched("t1"), launched("t2", "writer")]);
    expect(timeline.blocks.filter((block) => block.kind === "task_ref")).toHaveLength(2);
  });

  it("skips a malformed launch instead of breaking the fold", () => {
    const timeline = foldTimeline([
      { type: "CUSTOM", name: "TASK_LAUNCHED", value: { name: "no id" } },
      { type: "TEXT_MESSAGE_CONTENT", delta: "still here" },
    ]);
    expect(timeline.blocks.map((block) => block.kind)).toEqual(["content"]);
  });

  it("marks a pulled result inline, persisted with the run's events (survives reload)", () => {
    const events = [
      launched("t1"),
      {
        type: "CUSTOM",
        name: "TASK_SETTLED_INLINE",
        value: { task_id: "t1", name: "researcher", status: "success" },
      },
    ];
    const reloaded = foldTimeline(events, { status: "completed" });
    expect(reloaded.blocks[1]).toMatchObject({ kind: "task_settled", status: "success" });
  });
});

describe("finalizeTimeline no longer ends async tasks", () => {
  it("leaves the run's task references as they are when the run ends", () => {
    const live = reduceTimelineEvents(createTimeline(), [launched("t1")]);
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const ended = finalizeTimeline(live, status);
      expect(ended.blocks).toEqual(live.blocks);
      expect(ended.terminal).toBe(true);
    }
  });

  it("never ends an async task's card, while a blocking sub-agent still ends with the run", () => {
    const base = createTimeline();
    const asyncCard: SubagentBlock = {
      kind: "subagent",
      id: "task:t1",
      taskId: "t1",
      spawned: true,
      asyncTask: true,
      status: "running",
      blocks: [],
    };
    const blocking: SubagentBlock = {
      kind: "subagent",
      id: "b9",
      taskId: "call-1",
      spawned: true,
      status: "running",
      blocks: [],
    };
    const ended = finalizeTimeline({ ...base, blocks: [asyncCard, blocking] }, "cancelled");
    expect((ended.blocks[0] as SubagentBlock).status).toBe("running");
    expect((ended.blocks[0] as SubagentBlock).endedByRun).toBeUndefined();
    expect((ended.blocks[1] as SubagentBlock).status).toBe("cancelled");
  });
});

describe("subagentRunStatus reads an async task's own status", () => {
  const timeline = { terminal: true, interrupts: [] };
  const card = (status: SubagentBlock["status"]): SubagentBlock => ({
    kind: "subagent",
    id: "task:t1",
    taskId: "t1",
    spawned: true,
    asyncTask: true,
    status,
    blocks: [],
  });

  it("keeps a running task running after its run ended (no 'cancelled for want of a stream')", () => {
    expect(subagentRunStatus(card("running"), timeline, false)).toBe("running");
    expect(subagentRunStatus(card("waiting_children"), timeline, false)).toBe("waiting_children");
    expect(subagentRunStatus(card("stopping"), timeline, false)).toBe("stopping");
    expect(subagentRunStatus(card("done"), timeline, false)).toBe("done");
  });

  it("still reads a blocking sub-agent the old way", () => {
    const blocking: SubagentBlock = { ...card("running"), asyncTask: undefined };
    expect(subagentRunStatus(blocking, timeline, false)).toBe("cancelled");
  });
});
