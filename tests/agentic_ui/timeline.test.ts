import { describe, expect, it } from "vitest";

import {
  createTimeline,
  finalizeTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "@/features/inference/timeline";

/**
 * The run timeline is the one reducer every message on screen is rendered from,
 * and it is folded by three different callers (live WebSocket frames, REST
 * snapshot hydration, persisted-message replay). These tests pin the invariants
 * that make that safe to do — ordering, idempotence, and tolerance of junk — so
 * the Phase 5 restructure has something to fail against.
 */

const text = (delta: string, seq?: number) => ({
  type: "TEXT_MESSAGE_CHUNK",
  delta,
  ...(seq === undefined ? {} : { seq }),
});

const thinking = (delta: string, seq?: number) => ({
  type: "THINKING_TEXT_MESSAGE_CONTENT",
  delta,
  ...(seq === undefined ? {} : { seq }),
});

describe("reduceTimelineEvents", () => {
  it("folds successive text deltas into a single content block", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      text("Hello"),
      text(", "),
      text("world"),
    ]);

    const content = state.blocks.filter((b) => b.kind === "content");
    expect(content).toHaveLength(1);
    expect((content[0] as { text: string }).text).toBe("Hello, world");
  });

  it("ignores events whose seq was already applied", () => {
    // The live socket can replay from `since` after a reconnect, so the same
    // frame legitimately arrives twice. Re-applying it would double the text.
    const first = reduceTimelineEvents(createTimeline(), [text("a", 1), text("b", 2)]);
    const replayed = reduceTimelineEvents(first, [text("a", 1), text("b", 2), text("c", 3)]);

    const content = replayed.blocks.filter((b) => b.kind === "content");
    expect((content[0] as { text: string }).text).toBe("abc");
    expect(replayed.lastSeq).toBe(3);
  });

  it("survives malformed events instead of throwing", () => {
    // A single bad frame must never take down the whole conversation view.
    // Note the tool event legitimately closes the open content block, so the
    // trailing text lands in a NEW block — this asserts nothing was lost, not
    // that everything stayed in one block.
    const state = reduceTimelineEvents(createTimeline(), [
      text("before"),
      null as never,
      "not-an-object" as never,
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "search" },
      text("after"),
    ]);

    const content = state.blocks
      .filter((b) => b.kind === "content")
      .map((b) => (b as { text: string }).text);
    expect(content.join("")).toBe("beforeafter");
  });

  it("returns the same object when there is nothing to apply", () => {
    // Identity is load-bearing: memoized block components re-render when it changes.
    const state = reduceTimelineEvents(createTimeline(), [text("x")]);
    expect(reduceTimelineEvents(state, [])).toBe(state);
  });

  it("refuses to mutate a terminal timeline", () => {
    // A late frame arriving after the run finished must not reopen it.
    const finished = finalizeTimeline(
      reduceTimelineEvents(createTimeline(), [text("done")]),
      "completed",
    );
    const after = reduceTimelineEvents(finished, [text(" MORE")]);

    expect(after).toBe(finished);
    const content = after.blocks.filter((b) => b.kind === "content");
    expect((content[0] as { text: string }).text).toBe("done");
  });

  it("does not mutate the input state", () => {
    const before = reduceTimelineEvents(createTimeline(), [text("one")]);
    const beforeBlocks = before.blocks;

    const after = reduceTimelineEvents(before, [text(" two", 5)]);

    expect(after).not.toBe(before);
    expect(before.blocks).toBe(beforeBlocks);
    expect((before.blocks.filter((b) => b.kind === "content")[0] as { text: string }).text).toBe(
      "one",
    );
  });
});

describe("finalizeTimeline", () => {
  it("marks the run terminal with its status", () => {
    const state = finalizeTimeline(
      reduceTimelineEvents(createTimeline(), [text("hi")]),
      "completed",
    );

    expect(state.terminal).toBe(true);
    expect(state.terminalStatus).toBe("completed");
  });

  it("is idempotent for the same status", () => {
    const once = finalizeTimeline(createTimeline(), "failed");
    expect(finalizeTimeline(once, "failed")).toBe(once);
  });

  it("leaves a mid-run timeline open", () => {
    // The Done sentinel must not appear while a HITL interrupt is pending — the
    // run is paused, not finished.
    const state = reduceTimelineEvents(createTimeline(), [thinking("considering")]);
    expect(state.terminal).toBe(false);
  });
});

describe("timelineThoughtStrings", () => {
  it("extracts thinking text and tolerates an absent timeline", () => {
    const state = reduceTimelineEvents(createTimeline(), [thinking("step one")]);

    expect(timelineThoughtStrings(state).join(" ")).toContain("step one");
    expect(timelineThoughtStrings(null)).toEqual([]);
    expect(timelineThoughtStrings(undefined)).toEqual([]);
  });
});
