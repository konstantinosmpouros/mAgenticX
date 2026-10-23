import { describe, expect, it } from "vitest";

import {
  agentTranscript,
  buildAgentMap,
  buildAnswerNodes,
  collectAgentMapAnswers,
  flattenAgentNodes,
  foldAnswerTimeline,
  formatAgentDuration,
} from "@/features/chat/lib/agentMap";
import {
  createTimeline,
  finalizeTimeline,
  reduceTimelineEvents,
} from "@/features/inference/timeline";
import type { MessageOut, RunTimeline, SubagentBlock } from "@/shared/lib/types";

/**
 * The agent map's tree (composer button → panel): answers on the branch that
 * used sub-agents, their sub-agents, and the sub-agents those delegated to —
 * nested by LangGraph namespace, as the agents service emits them: a nested
 * sub-agent's events arrive as top-level SUBAGENT_EVENTs whose namespace
 * extends its parent's, and its `task` call arrives inside the parent's stream.
 */

type Event = Record<string, unknown>;

const task = (taskId: string, type: string, description: string): Event => ({
  type: "CUSTOM",
  name: "TASK_SUBAGENT",
  value: { task_id: taskId, subagent_type: type, description },
});

const inside = (taskId: string, namespace: string[], event: Event): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_EVENT",
  value: { task_id: taskId, namespace, event },
});

// The envelope carries the time the sub-agent's first event reached the run.
const started = (taskId: string, namespace: string[], at: number): Event => ({
  ...inside(taskId, namespace, { type: "THINKING_START", timestamp: at }),
  timestamp: at,
});

const tool = (taskId: string, namespace: string[], id: string): Event[] => [
  inside(taskId, namespace, { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "search" }),
  inside(taskId, namespace, { type: "TOOL_CALL_RESULT", toolCallId: id, content: "ok" }),
];

const completed = (
  taskId: string,
  startedAt: number,
  endedAt: number,
  status = "completed",
): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_COMPLETED",
  value: { task_id: taskId, status, started_at: startedAt, ended_at: endedAt },
});

/** Researcher (with a nested fact checker) and a writer in parallel. */
const nestedRun = (): Event[] => [
  task("t-research", "researcher", "Find the three vendors' prices"),
  task("t-write", "writer", "Draft the comparison"),
  started("t-research", ["tools:r1"], 1_000),
  started("t-write", ["tools:w1"], 1_200),
  ...tool("t-research", ["tools:r1"], "call-1"),
  // The researcher delegates: its `task` call is inside its own stream ...
  inside("t-research", ["tools:r1"], task("t-check", "fact-checker", "Check the prices")),
  // ... and the fact checker's events come one namespace level deeper.
  started("t-check", ["tools:r1", "tools:c1"], 2_000),
  ...tool("t-check", ["tools:r1", "tools:c1"], "call-2"),
  ...tool("t-check", ["tools:r1", "tools:c1"], "call-3"),
  completed("t-check", 2_000, 5_000),
  completed("t-research", 1_000, 9_000),
  completed("t-write", 1_200, 4_200, "error"),
];

const fold = (events: Event[], status?: "completed" | "failed" | "cancelled"): RunTimeline => {
  const state = reduceTimelineEvents(createTimeline(), events);
  return status ? finalizeTimeline(state, status) : state;
};

const message = (id: string, sender: string, extra: Partial<MessageOut> = {}): MessageOut => ({
  id,
  sender,
  content: "",
  created_at: new Date(0),
  updated_at: new Date(0),
  attachments: [],
  ...extra,
});

describe("agent map: nesting", () => {
  it("nests a sub-agent under the one whose namespace it extends", () => {
    const nodes = buildAnswerNodes("m1", fold(nestedRun(), "completed"), false);

    expect(nodes.map((node) => node.title)).toEqual(["Researcher", "Writer"]);
    const [researcher, writer] = nodes;
    expect(researcher.children.map((node) => node.title)).toEqual(["Fact Checker"]);
    expect(researcher.children[0].depth).toBe(2);
    expect(researcher.depth).toBe(1);
    expect(writer.children).toEqual([]);
  });

  it("gives the nested sub-agent the type and task its parent's call asked for", () => {
    const timeline = fold(nestedRun(), "completed");
    const checker = timeline.blocks.find(
      (block) => block.kind === "subagent" && block.taskId === "t-check",
    );

    expect(checker).toMatchObject({
      type: "fact-checker",
      description: "Check the prices",
      parentTaskId: "t-research",
      namespace: "tools:r1 / tools:c1",
    });
  });

  it("nests three levels deep and keeps parallel siblings in start order", () => {
    const events: Event[] = [
      task("a", "planner", "Plan"),
      started("a", ["tools:a"], 10),
      started("b", ["tools:a", "tools:b"], 20),
      started("c", ["tools:a", "tools:b", "tools:c"], 30),
      started("d", ["tools:a", "tools:d"], 40),
    ];
    const [root] = buildAnswerNodes("m", fold(events), true);

    expect(root.children.map((node) => node.taskId)).toEqual(["b", "d"]);
    expect(root.children[0].children.map((node) => node.taskId)).toEqual(["c"]);
    expect(root.children[0].children[0].depth).toBe(3);
    expect(flattenAgentNodes([root]).map((node) => node.taskId)).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back to the parent's `task` call when a namespace is missing", () => {
    const timeline = fold(nestedRun(), "completed");
    for (const block of timeline.blocks) {
      if (block.kind === "subagent") block.namespace = undefined;
    }
    const [researcher] = buildAnswerNodes("m1", timeline, false);

    expect(researcher.children.map((node) => node.taskId)).toEqual(["t-check"]);
  });

  it("leaves out a `task` call that never spawned (rejected at the gate)", () => {
    const nodes = buildAnswerNodes("m", fold([task("x", "writer", "Write"), ...nestedRun()]), true);

    expect(flattenAgentNodes(nodes).map((node) => node.taskId)).not.toContain("x");
  });
});

describe("agent map: status, duration, tools", () => {
  it("reads status, settled duration and tool count off each sub-agent", () => {
    const [researcher, writer] = buildAnswerNodes("m1", fold(nestedRun(), "completed"), false);
    const checker = researcher.children[0];

    expect(researcher).toMatchObject({ status: "done", durationMs: 8_000, toolCount: 1 });
    expect(checker).toMatchObject({ status: "done", durationMs: 3_000, toolCount: 2 });
    expect(writer).toMatchObject({ status: "failed", durationMs: 3_000 });
    expect(researcher.task).toBe("Find the three vendors' prices");
  });

  it("shows a working sub-agent as running with no duration yet", () => {
    const [node] = buildAnswerNodes(
      "m",
      fold([task("a", "analyst", "Look"), started("a", ["tools:a"], 5)]),
      true,
    );

    expect(node.status).toBe("running");
    expect(node.durationMs).toBeNull();
    expect(node.startedAt).toBe(5);
  });

  it("formats durations", () => {
    expect(formatAgentDuration(400)).toBe("<1s");
    expect(formatAgentDuration(42_000)).toBe("42s");
    expect(formatAgentDuration(185_000)).toBe("3m 05s");
    expect(formatAgentDuration(3_720_000)).toBe("1h 02m");
    expect(formatAgentDuration(null)).toBeNull();
  });
});

describe("agent map: the conversation", () => {
  const nestedEvents = nestedRun();
  const conversation = (): MessageOut[] => [
    message("u1", "user", { content: "Compare the three vendors\n on price" }),
    message("a1", "ai", { rawEvents: nestedEvents, streamingStatus: "completed" }),
    message("u2", "user", { content: "Thanks!" }),
    message("a2", "ai", { rawEvents: [{ type: "TEXT_MESSAGE_CONTENT", delta: "You're welcome" }] }),
    message("u3", "user", { content: "Now draft the summary" }),
    message("a3", "ai", { rawEvents: [] }),
  ];

  it("groups sub-agents by answer, numbered by question, skipping answers without any", () => {
    const map = buildAgentMap(
      collectAgentMapAnswers(conversation(), { messageId: null, timeline: null }),
    );

    expect(map.answers.map((answer) => [answer.number, answer.question])).toEqual([
      [1, "Compare the three vendors on price"],
    ]);
    expect(map.answers[0].subagentCount).toBe(3);
    expect(map.subagentCount).toBe(3);
    expect(map.runningCount).toBe(0);
  });

  it("is empty for an empty conversation and for one without sub-agents", () => {
    expect(buildAgentMap(collectAgentMapAnswers([], { messageId: null, timeline: null }))).toEqual({
      answers: [],
      subagentCount: 0,
      runningCount: 0,
    });
    const plain = conversation().filter((m) => m.id !== "a1");
    expect(
      buildAgentMap(collectAgentMapAnswers(plain, { messageId: null, timeline: null })).answers,
    ).toEqual([]);
  });

  it("takes the live run's timeline for the streaming answer and updates with it", () => {
    const messages = conversation();
    const firstFrame = fold([
      task("live-1", "analyst", "Summarise"),
      started("live-1", ["tools:l1"], 100),
    ]);
    const live = buildAgentMap(
      collectAgentMapAnswers(messages, { messageId: "a3", timeline: firstFrame }),
    );

    expect(live.answers.map((answer) => answer.number)).toEqual([1, 3]);
    const q3 = live.answers[1];
    expect(q3).toMatchObject({ live: true, question: "Now draft the summary", runningCount: 1 });
    expect(live.runningCount).toBe(1);

    // A later frame: the analyst delegates, then finishes.
    const nextFrame = reduceTimelineEvents(firstFrame, [
      inside("live-1", ["tools:l1"], task("live-2", "editor", "Polish")),
      started("live-2", ["tools:l1", "tools:l2"], 200),
      completed("live-2", 200, 700),
    ]);
    const updated = buildAgentMap(
      collectAgentMapAnswers(messages, { messageId: "a3", timeline: nextFrame }),
    );
    const analyst = updated.answers[1].nodes[0];

    expect(analyst.status).toBe("running");
    expect(analyst.children.map((node) => [node.title, node.status])).toEqual([["Editor", "done"]]);
    expect(updated.subagentCount).toBe(5);
    // The settled answer was not rebuilt: same object across frames.
    expect(updated.answers[0]).toBe(live.answers[0]);
  });

  it("folds a settled answer once per event log", () => {
    const [, answer] = conversation();
    const first = foldAnswerTimeline(answer);

    expect(first).not.toBeNull();
    expect(foldAnswerTimeline(answer)).toBe(first);
    expect(
      foldAnswerTimeline(message("x", "ai", { rawEvents: [{ type: "TEXT_MESSAGE_CONTENT" }] })),
    ).toBeNull();
  });

  it("settles a sub-agent still running when its answer was stopped", () => {
    const stopped = message("a", "ai", {
      rawEvents: [task("s", "analyst", "Look"), started("s", ["tools:s"], 1)],
      streamingStatus: "cancelled",
    });
    const map = buildAgentMap(
      collectAgentMapAnswers([message("u", "user", { content: "Go" }), stopped], {
        messageId: null,
        timeline: null,
      }),
    );

    expect(map.answers[0].nodes[0].status).toBe("cancelled");
    expect(map.runningCount).toBe(0);
  });
});

describe("agentTranscript (the detail view's conversation)", () => {
  const sub = (taskId: string, extra: Partial<SubagentBlock>): SubagentBlock => ({
    kind: "subagent",
    id: `b-${taskId}`,
    taskId,
    spawned: true,
    status: "done",
    blocks: [],
    ...extra,
  });
  const toolItem = (id: string, name: string) => ({
    kind: "tool" as const,
    id,
    name,
    argsText: "",
    state: "output-available" as const,
  });
  const nodesFor = (blocks: SubagentBlock[], live = false) =>
    buildAnswerNodes("m1", { ...createTimeline(), blocks, terminal: !live }, live);

  it("puts the instruction first and splices each nested sub-agent after its task call", () => {
    const parent = sub("p", {
      prompt: "Research the vendors.",
      description: "Research",
      startedAt: 0,
      endedAt: 100,
      blocks: [
        {
          kind: "thinking",
          id: "th",
          startedAt: 0,
          endedAt: 60,
          items: [toolItem("s1", "search"), toolItem("c1", "task"), { kind: "thought", id: "x", text: "ok" }],
        },
        { kind: "content", id: "ct", text: "The answer" },
      ],
    });
    const child = sub("c1", { parentTaskId: "p", startedAt: 10, endedAt: 40 });
    const [node] = nodesFor([parent, child]);
    const transcript = agentTranscript(node);

    expect(transcript.instruction).toBe("Research the vendors.");
    expect(transcript.live).toBe(false);
    expect(transcript.timeline.terminal).toBe(true);
    expect(transcript.timeline.terminalStatus).toBe("completed");
    const shape = transcript.timeline.blocks.map((b) =>
      b.kind === "thinking" ? `thinking:${b.items.map((i) => i.id).join(",")}` : `${b.kind}:${b.id}`,
    );
    expect(shape).toEqual(["thinking:s1,c1", "subagent:b-c1", "thinking:x", "content:ct"]);
    // Block ids stay unique after the split; the halves keep their time spans.
    const [before, , after] = transcript.timeline.blocks;
    expect(before.id).not.toBe(after.id);
    expect(before.kind === "thinking" && [before.startedAt, before.endedAt]).toEqual([0, 10]);
    expect(after.kind === "thinking" && after.startedAt).toBe(40);
  });

  it("falls back to task-call order, then the end, and reads a running one as live", () => {
    const parent = sub("p", {
      status: "running",
      description: "Only a description",
      blocks: [{ kind: "thinking", id: "th", items: [toolItem("other-id", "task")] }],
    });
    const a = sub("a", { parentTaskId: "p" });
    const b = sub("b", { parentTaskId: "p" });
    const [node] = nodesFor([parent, a, b], true);
    const transcript = agentTranscript(node);

    expect(transcript.instruction).toBe("Only a description");
    expect(transcript.live).toBe(true);
    expect(transcript.timeline.terminal).toBe(false);
    expect(transcript.timeline.blocks.map((block) => block.id)).toEqual(["th", "b-a", "b-b"]);
  });

  it("an empty reply has no blocks", () => {
    const [node] = nodesFor([sub("p", { status: "running" })], true);
    expect(agentTranscript(node).timeline.blocks).toEqual([]);
  });
});
