import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentTranscript,
  buildAgentMap,
  buildAnswerNodes,
  flattenAgentNodes,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";
import { buildAgentMapFlow } from "@/features/chat/lib/agentMapFlow";
import {
  countRunActivity,
  createTimeline,
  foldTimeline,
  pendingTimelineInterrupts,
  reduceTimelineEvents,
  subagentBlockToItem,
  subagentRunStatus,
  subagentTree,
} from "@/features/inference/timeline";
import type {
  RunTimeline,
  SubagentBlock,
  ThinkingBlock,
  TimelineDelegation,
} from "@/shared/lib/types";

/**
 * Real nested sub-agent runs, folded by the UI. The events are what the agents
 * service streamed for real deepagents runs (tests/agents/fixtures/
 * nested_subagents, recorded through its normalizer): the main agent delegates
 * to a researcher, which starts a fact-checker and a citation formatter in
 * parallel; the fact-checker delegates to a source verifier.
 *
 *   main
 *   └─ researcher                 (web_search)
 *      ├─ fact-checker            (lookup_fact)
 *      │  └─ source-verifier      (find_source)
 *      └─ citation-formatter
 */

type Event = Record<string, any>;
type Fixture = { events: Event[] };

const FIXTURES = path.resolve(__dirname, "../agents/fixtures/nested_subagents");
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as T;

const TOOLS: Record<string, string[]> = {
  researcher: ["web_search"],
  "fact-checker": ["lookup_fact"],
  "source-verifier": ["find_source"],
  "citation-formatter": [],
};
const PARENT: Record<string, string | undefined> = {
  researcher: undefined,
  "fact-checker": "researcher",
  "citation-formatter": "researcher",
  "source-verifier": "fact-checker",
};
const DEPTH: Record<string, number> = {
  researcher: 1,
  "fact-checker": 2,
  "citation-formatter": 2,
  "source-verifier": 3,
};
const FAKE_TEXT: Record<string, string> = {
  researcher: "Research: 330 m, verified by the fact-checker; citation formatted.",
  "fact-checker": "Fact-check: TRUE (330 m), source verified.",
  "source-verifier": "Source: toureiffel.paris key figures page.",
  "citation-formatter": "Citation: SETE (2022). Key figures. toureiffel.paris.",
};

const custom = (event: Event, name: string) =>
  event?.type === "CUSTOM" && event?.name === name ? event.value : undefined;

/** task id -> the SUBAGENT_COMPLETED the service sent for it (at any depth). */
function completions(events: Event[]): Record<string, Event> {
  const out: Record<string, Event> = {};
  for (const event of events) {
    const top = custom(event, "SUBAGENT_COMPLETED");
    if (top) out[top.task_id] = top;
    const envelope = custom(event, "SUBAGENT_EVENT");
    const nested = envelope && custom(envelope.event, "SUBAGENT_COMPLETED");
    if (nested) out[nested.task_id] = nested;
  }
  return out;
}

const subagents = (timeline: RunTimeline): SubagentBlock[] =>
  timeline.blocks.filter((block): block is SubagentBlock => block.kind === "subagent");

const byType = (timeline: RunTimeline): Record<string, SubagentBlock> =>
  Object.fromEntries(subagents(timeline).map((block) => [block.type ?? "?", block]));

const nodesByType = (nodes: AgentMapNode[]): Record<string, AgentMapNode> =>
  Object.fromEntries(flattenAgentNodes(nodes).map((node) => [node.type ?? "?", node]));

describe.each([
  ["scripted models", "fake_run.json"],
  ["a real model (gpt-4.1-mini)", "openai_run.json"],
])("a 3-level run with %s", (_label, file) => {
  const { events } = load<Fixture>(file);
  const settled = () => foldTimeline(events, { status: "completed" });

  it("folds one spawned, settled block per sub-agent, each under the agent that delegated to it", () => {
    const timeline = settled();
    const blocks = byType(timeline);

    expect(Object.keys(blocks).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(timeline.subagentCount).toBe(4);
    for (const [type, block] of Object.entries(blocks)) {
      expect(block.spawned).toBe(true);
      expect(block.status).toBe("done");
      expect(block.endedByRun).toBeUndefined();
      const parent = PARENT[type];
      expect(block.parentTaskId).toBe(parent ? blocks[parent].taskId : undefined);
      // The namespace path is the parent's plus one `tools:<id>` segment.
      const segments = block.namespace!.split(" / ");
      expect(segments).toHaveLength(DEPTH[type]);
      if (parent) expect(blocks[parent].namespace).toBe(segments.slice(0, -1).join(" / "));
    }
  });

  it("keeps each sub-agent's own reply and tool calls in its own block", () => {
    const blocks = byType(settled());
    for (const [type, block] of Object.entries(blocks)) {
      const item = subagentBlockToItem(block);
      expect(item.tools?.map((tool) => tool.name)).toEqual(TOOLS[type]);
      expect(item.tools?.every((tool) => tool.status === "completed")).toBe(true);
      expect(item.text?.trim()).toBeTruthy();
      if (file === "fake_run.json") expect(item.text).toBe(FAKE_TEXT[type]);
    }
    // The main agent's answer is its own; no sub-agent text leaks into it.
    const answer = settled()
      .blocks.filter((block) => block.kind === "content")
      .map((block) => (block as { text: string }).text)
      .join("");
    expect(answer).toMatch(/330/);
    for (const text of Object.values(FAKE_TEXT)) expect(answer).not.toContain(text);
  });

  it("times every level by its own start and its own completion", () => {
    const blocks = byType(settled());
    const done = completions(events);
    for (const [type, block] of Object.entries(blocks)) {
      expect(block.endedAt).toBe(done[block.taskId].ended_at);
      expect(block.startedAt).toBeLessThan(block.endedAt!);
      const parent = PARENT[type];
      if (parent) {
        // A child works inside its parent's time.
        expect(block.startedAt!).toBeGreaterThanOrEqual(blocks[parent].startedAt!);
        expect(block.endedAt!).toBeLessThanOrEqual(blocks[parent].endedAt!);
      }
    }
    // Siblings started together (one model turn), and ran side by side.
    const [checker, citer] = [blocks["fact-checker"], blocks["citation-formatter"]];
    expect(citer.startedAt!).toBeLessThan(checker.endedAt!);
  });

  it("builds the agent map tree: researcher > (fact-checker > source-verifier, citation-formatter)", () => {
    const nodes = buildAnswerNodes("a1", settled(), false);
    expect(nodes.map((node) => node.type)).toEqual(["researcher"]);
    const [researcher] = nodes;
    expect(researcher.children.map((node) => node.type).sort()).toEqual([
      "citation-formatter",
      "fact-checker",
    ]);
    const checker = researcher.children.find((node) => node.type === "fact-checker")!;
    expect(checker.children.map((node) => node.type)).toEqual(["source-verifier"]);

    for (const [type, node] of Object.entries(nodesByType(nodes))) {
      expect(node).toMatchObject({
        status: "done",
        depth: DEPTH[type],
        toolCount: TOOLS[type].length,
      });
      expect(node.durationMs).toBe(node.endedAt! - node.startedAt!);
      expect(node.durationMs!).toBeGreaterThan(0);
      expect(node.task).toBeTruthy();
    }
  });

  it("draws the flow graph with one edge per delegation, a row per depth", () => {
    const timeline = settled();
    const map = buildAgentMap([
      { messageId: "a1", number: 1, question: "How tall?", timeline, live: false },
    ]);
    expect(map).toMatchObject({ subagentCount: 4, runningCount: 0 });
    const flow = buildAgentMapFlow(map, { agentName: "Orchestrator" });
    const types = nodesByType(map.answers[0].nodes);
    const id = (type: string) => types[type].id;

    expect(flow.nodes).toHaveLength(1 + 1 + 4);
    const edge = (source: string, target: string, tone: string) =>
      `${source} -> ${target} (${tone})`;
    expect(flow.edges.map((e) => edge(e.source, e.target, String(e.data?.tone))).sort()).toEqual(
      [
        edge("root", "answer:a1", "idle"),
        edge("answer:a1", id("researcher"), "done"),
        edge(id("researcher"), id("fact-checker"), "done"),
        edge(id("researcher"), id("citation-formatter"), "done"),
        edge(id("fact-checker"), id("source-verifier"), "done"),
      ].sort(),
    );
    expect(flow.edges.some((edge) => edge.animated)).toBe(false);
    const y = (nodeId: string) => flow.nodes.find((node) => node.id === nodeId)!.position.y;
    expect(y(id("researcher"))).toBeLessThan(y(id("fact-checker")));
    expect(y(id("fact-checker"))).toBe(y(id("citation-formatter")));
    expect(y(id("fact-checker"))).toBeLessThan(y(id("source-verifier")));
  });

  it("nests every level inside the card of the agent that delegated to it", () => {
    const timeline = settled();
    // What TimelineSequence and the sub-agents panel draw: one top-level card
    // (the researcher), its sub-agents inside it, theirs inside them.
    const tree = subagentTree(timeline);
    const typesOf = (blocks: SubagentBlock[]) => blocks.map((block) => block.type).sort();
    expect(typesOf(tree.roots)).toEqual(["researcher"]);
    const [researcher] = tree.roots;
    expect(typesOf(tree.childrenOf(researcher))).toEqual(["citation-formatter", "fact-checker"]);
    const checker = tree.childrenOf(researcher).find((block) => block.type === "fact-checker")!;
    expect(typesOf(tree.childrenOf(checker))).toEqual(["source-verifier"]);
    for (const block of subagents(timeline)) {
      expect(tree.isNested(block)).toBe(block.type !== "researcher");
      expect(subagentRunStatus(block, timeline, false)).toBe("done");
    }
  });

  it("places a sub-agent's delegations where it made them in its transcript", () => {
    const [researcher] = buildAnswerNodes("a1", settled(), false);
    const transcript = agentTranscript(researcher);
    const blocks = transcript.timeline.blocks;
    const kinds = blocks.map((block) =>
      block.kind === "subagent" ? (block as SubagentBlock).type : block.kind,
    );
    // The two sub-agents it started together come right after the step that
    // started them — the "Delegated to" marks — and before its reply.
    const firstChild = kinds.findIndex(
      (kind) => kind === "fact-checker" || kind === "citation-formatter",
    );
    expect(kinds.slice(firstChild, firstChild + 2).sort()).toEqual([
      "citation-formatter",
      "fact-checker",
    ]);
    expect(kinds.lastIndexOf("content")).toBeGreaterThan(firstChild);
    const step = blocks[firstChild - 1] as ThinkingBlock;
    expect(step.kind).toBe("thinking");
    const marks = step.items.filter((item) => item.kind === "delegation");
    expect(marks.map((item) => (item as TimelineDelegation).type).sort()).toEqual([
      "citation-formatter",
      "fact-checker",
    ]);
    // A mark is not a tool: the card and the node count only real tool calls.
    expect(subagentBlockToItem(researcher.block).tools?.map((tool) => tool.name)).toEqual([
      "web_search",
    ]);
    expect(researcher.toolCount).toBe(1);
    expect(transcript.instruction).toBeTruthy();
  });

  it("counts every level's model and tool calls", () => {
    const usage = new Set<string>();
    const tools = new Set<string>();
    const visit = (event: Event) => {
      const envelope = custom(event, "SUBAGENT_EVENT");
      if (envelope) return visit(envelope.event);
      const tokenUsage = custom(event, "TOKEN_USAGE");
      if (tokenUsage) usage.add(tokenUsage.message_id);
      if (event.type === "TOOL_CALL_START") tools.add(event.toolCallId);
    };
    events.forEach(visit);
    expect(countRunActivity(events)).toEqual({ modelCalls: usage.size, toolCalls: 3 });
    expect(tools.size).toBe(3);
  });
});

describe("a 3-level run paused twice (scripted)", () => {
  const { legs } = load<{ legs: Event[][] }>("fake_hitl_legs.json");
  const firstInterrupt = (leg: Event[]) => {
    for (const event of leg) {
      const top = custom(event, "HITL_INTERRUPT");
      if (top) return top.interrupt.id as string;
    }
    throw new Error("leg did not pause");
  };
  const resolved = (interruptId: string): Event => ({
    type: "CUSTOM",
    name: "BRIDGE_HITL_RESOLVED",
    value: { interrupt_id: interruptId, decision: "approve", reason: null, decisions: null },
  });
  // What the bridge stores: each stream's events, with its resolution marker
  // between a pause and the stream that resumes it.
  const log = [
    ...legs[0],
    resolved(firstInterrupt(legs[0])),
    ...legs[1],
    resolved(firstInterrupt(legs[1])),
    ...legs[2],
  ];

  it("parks the nested sub-agent on its own approval while its sibling finishes", () => {
    const upToSecondPause = [...legs[0], resolved(firstInterrupt(legs[0])), ...legs[1]];
    const timeline = reduceTimelineEvents(createTimeline(), upToSecondPause);
    const blocks = byType(timeline);

    expect(subagentRunStatus(blocks["fact-checker"], timeline, true)).toBe("awaiting_approval");
    expect(subagentRunStatus(blocks["citation-formatter"], timeline, true)).toBe("done");
    expect(subagentRunStatus(blocks.researcher, timeline, true)).toBe("running");
    const [pending] = pendingTimelineInterrupts(timeline);
    // The interrupt reaches the UI once per level it bubbles through; it
    // belongs to the deepest — the agent whose tool is gated.
    expect(pending.subagentId).toBe(blocks["fact-checker"].taskId);
  });

  it("settles every level once, with the times of its real completion", () => {
    const timeline = foldTimeline(log, { status: "completed" });
    const blocks = byType(timeline);

    expect(Object.keys(blocks).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(pendingTimelineInterrupts(timeline)).toEqual([]);
    expect(timeline.interrupts).toHaveLength(2);
    const done = completions(log);
    const sent = log.filter((event) => {
      const envelope = custom(event, "SUBAGENT_EVENT");
      return (
        custom(event, "SUBAGENT_COMPLETED") ||
        (envelope && custom(envelope.event, "SUBAGENT_COMPLETED"))
      );
    });
    expect(sent).toHaveLength(4); // one per sub-agent, none repeated by a resume
    for (const block of Object.values(blocks)) {
      expect(block.status).toBe("done");
      expect(block.endedAt).toBe(done[block.taskId].ended_at);
    }
    const nodes = nodesByType(buildAnswerNodes("a1", timeline, false));
    expect(nodes["source-verifier"].depth).toBe(3);
    expect(nodes["fact-checker"].toolCount).toBe(1);
  });
});
