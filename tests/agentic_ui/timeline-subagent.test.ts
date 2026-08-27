import { describe, expect, it } from "vitest";

import { createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import type { SubagentBlock, ThinkingBlock, TimelineHitlApproval } from "@/shared/lib/types";

/**
 * The sub-agent fold path.
 *
 * `applyEvent` and `applySubagentInnerEvent` are two dispatch tables over the
 * same event vocabulary that differ only in where they write, and they had
 * silently drifted — four event types were handled at top level only. These
 * tests pin the sub-agent side specifically, because everything previously
 * covered ran through the top-level table and so could not have caught it.
 */

const TASK_ID = "task-1";

/** Open a sub-agent panel, the way the orchestrator does. */
const spawnSubagent = () => [
  {
    type: "CUSTOM",
    name: "TASK_SUBAGENT",
    value: {
      task_id: TASK_ID,
      subagent_type: "writer",
      description: "Write a file",
    },
  },
];

/** Wrap an event so it is folded *inside* the sub-agent rather than at top level. */
const inSubagent = (event: Record<string, unknown>) => ({
  type: "CUSTOM",
  name: "SUBAGENT_EVENT",
  value: { task_id: TASK_ID, namespace: ["writer"], event },
});

const subagentOf = (state: ReturnType<typeof createTimeline>) =>
  state.blocks.find((b) => b.kind === "subagent") as SubagentBlock | undefined;

describe("sub-agent event folding", () => {
  it("opens a sub-agent block from the orchestrator event, but does not count it yet", () => {
    // TASK_SUBAGENT fires when the orchestrator CALLS the `task` tool, which is
    // before the HITL gate — so the block exists but nothing has run.
    const state = reduceTimelineEvents(createTimeline(), spawnSubagent());
    const sub = subagentOf(state);

    expect(sub).toBeDefined();
    expect(sub?.description).toBe("Write a file");
    expect(sub?.spawned).toBeFalsy();
    expect(state.subagentCount).toBe(0);
  });

  it("counts the sub-agent once it actually spawns", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({ type: "THINKING_START", timestamp: 1000 }),
    ]);

    expect(subagentOf(state)?.spawned).toBe(true);
    expect(state.subagentCount).toBe(1);
  });

  it("never counts a task call that was rejected at the HITL gate", () => {
    // The bug this guards: a rejected `task` is a refused TOOL CALL, not a
    // sub-agent. No SUBAGENT_EVENT ever arrives for it, so it must not appear in
    // the panel — it used to render as a card with no response and no tools.
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      {
        type: "CUSTOM",
        name: "HITL_INTERRUPT",
        value: {
          thread_id: "thread-1",
          interrupt: { id: "int-task", value: { action_requests: [{ action: "task" }] } },
        },
      },
      {
        type: "CUSTOM",
        name: "BRIDGE_HITL_RESOLVED",
        value: { interrupt_id: "int-task", decision: "reject" },
      },
    ]);

    expect(subagentOf(state)?.spawned).toBeFalsy();
    expect(state.subagentCount).toBe(0);
  });

  it("folds thinking text into the sub-agent's own block, not the top level", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({
        type: "THINKING_TEXT_MESSAGE_CONTENT",
        delta: "planning the write",
      }),
    ]);

    const sub = subagentOf(state);
    const thinking = sub?.blocks.find((b) => b.kind === "thinking") as ThinkingBlock | undefined;
    expect(thinking?.items.some((i) => "text" in i && i.text === "planning the write")).toBe(true);

    // Nothing leaked into the top level — only the subagent block lives there.
    expect(state.blocks.filter((b) => b.kind === "thinking")).toHaveLength(0);
  });

  it("opens and closes the sub-agent thinking block on THINKING_START/END", () => {
    // Regression: these were handled only at top level, so a sub-agent's own
    // thinking lifecycle events did nothing.
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({ type: "THINKING_START", timestamp: 1000 }),
      inSubagent({ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "step" }),
      inSubagent({ type: "THINKING_END", timestamp: 2000 }),
    ]);

    const sub = subagentOf(state);
    const thinking = sub?.blocks.find((b) => b.kind === "thinking") as ThinkingBlock | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.endedAt).toBe(2000);
  });

  it("closes the sub-agent thinking block when its answer starts", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({ type: "THINKING_START", timestamp: 1000 }),
      inSubagent({ type: "TEXT_MESSAGE_START", timestamp: 1500 }),
      inSubagent({ type: "TEXT_MESSAGE_CHUNK", delta: "done" }),
    ]);

    const sub = subagentOf(state);
    const thinking = sub?.blocks.find((b) => b.kind === "thinking") as ThinkingBlock | undefined;
    expect(thinking?.endedAt).toBe(1500);
    const content = sub?.blocks.find((b) => b.kind === "content") as { text: string } | undefined;
    expect(content?.text).toBe("done");
  });

  it("resolves an approval raised inside a sub-agent", () => {
    // The bug this file exists for: BRIDGE_HITL_RESOLVED was top-level only, so
    // an approval granted for a sub-agent action stayed pending forever.
    const interruptId = "int-1";
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({ type: "THINKING_START", timestamp: 1000 }),
      inSubagent({
        type: "CUSTOM",
        name: "HITL_INTERRUPT",
        value: {
          thread_id: "thread-1",
          interrupt: {
            id: interruptId,
            value: { action_requests: [{ action: "write_file" }] },
          },
        },
      }),
    ]);

    const pending = state.interrupts.find((i) => i.id === interruptId);
    expect(pending, "interrupt should be registered").toBeDefined();
    expect(pending?.status).toBe("pending");

    const resolved = reduceTimelineEvents(state, [
      inSubagent({
        type: "CUSTOM",
        name: "BRIDGE_HITL_RESOLVED",
        value: { interrupt_id: interruptId, decision: "approve" },
      }),
    ]);

    const after = resolved.interrupts.find((i: TimelineHitlApproval) => i.id === interruptId);
    expect(after?.status).not.toBe("pending");
  });

  it("unwraps a RAW_SSE_EVENT envelope inside a sub-agent", () => {
    // parseRawSseEvent expects a real SSE frame, i.e. a `data:` line.
    const inner = `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CHUNK", delta: "via sse" })}`;
    const state = reduceTimelineEvents(createTimeline(), [
      ...spawnSubagent(),
      inSubagent({ type: "RAW_SSE_EVENT", raw_sse: inner }),
    ]);

    const sub = subagentOf(state);
    const content = sub?.blocks.find((b) => b.kind === "content") as { text: string } | undefined;
    expect(content?.text).toBe("via sse");
  });
});
