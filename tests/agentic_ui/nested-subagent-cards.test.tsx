// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import;
// the answer text is not what these tests look at.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { SubagentsSidePanel } from "@/features/chat/components/message_parts/RunSidePanels";
import { TimelineSequence } from "@/features/chat/components/message_parts/TimelineSequence";
import {
  agentTranscript,
  buildAgentMap,
  buildAnswerNodes,
  flattenAgentNodes,
} from "@/features/chat/lib/agentMap";
import { buildAgentMapFlow } from "@/features/chat/lib/agentMapFlow";
import { foldTimeline, subagentRunStatus } from "@/features/inference/timeline";
import type { RunTimeline, SubagentBlock } from "@/shared/lib/types";

/**
 * The nested example agent (tests/agents/fixtures/agents/nested-research-demo:
 * main → researcher → fact-checker), as the chat draws it — from the events the
 * agents service streamed for it through its real build path, paused on the
 * `task` gate at both levels and approved:
 *
 *  - the inline cards are a tree: the fact-checker's card sits inside the
 *    researcher's, on the agent map's connector rail, with its own status;
 *  - the sub-agents panel lists the same tree;
 *  - the agent map nests it, and the researcher's transcript shows a
 *    "Delegated to Fact Checker" row where it delegated, which opens the
 *    fact-checker.
 */

type Event = Record<string, any>;

const FIXTURES = path.resolve(__dirname, "../agents/fixtures/nested_subagents");
const legsOf = (name: string): Event[][] =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")).legs as Event[][];

/** The run's stored log: every stream, with the bridge's resolution marker
 *  between a pause and the stream that resumed it. */
function storedLog(legs: Event[][]): Event[] {
  const log: Event[] = [];
  legs.forEach((leg, index) => {
    log.push(...leg);
    if (index === legs.length - 1) return;
    const pause = leg.find((event) => event.type === "CUSTOM" && event.name === "HITL_INTERRUPT");
    log.push({
      type: "CUSTOM",
      name: "BRIDGE_HITL_RESOLVED",
      value: { interrupt_id: pause?.value?.interrupt?.id, decision: "approve", decisions: null },
    });
  });
  return log;
}

const ALWAYS_OPEN = new Proxy({}, { get: () => true }) as Record<string, boolean>;

describe.each([
  ["scripted models", "example_scripted_run.json"],
  ["a real model (gpt-4.1-mini)", "example_openai_run.json"],
])("the nested example agent with %s", (_label, file) => {
  const timeline = (): RunTimeline =>
    foldTimeline(storedLog(legsOf(file)), { status: "completed" });

  it("draws the fact-checker's card inside the researcher's", () => {
    const { container } = render(
      <TimelineSequence
        timeline={timeline()}
        runId="run-1"
        isStreaming={false}
        expandedThinking={{}}
        onToggleThinking={() => {}}
      />,
    );

    const cards = Array.from(container.querySelectorAll<HTMLElement>(".subagent-card"));
    expect(cards).toHaveLength(2);
    const topLevel = cards.filter((card) => !card.parentElement?.closest(".subagent-card"));
    expect(topLevel).toHaveLength(1);
    const [researcher] = topLevel;
    expect(within(researcher).getByRole("button", { name: /^Researcher, Done/ })).toBeTruthy();
    const rail = within(researcher).getByRole("list", { name: "Researcher's sub-agents" });
    const branch = within(rail).getAllByRole("listitem");
    expect(branch).toHaveLength(1);
    expect(branch[0].className).toContain("agent-map-branch");
    expect(branch[0].dataset.active).toBe("false");
    expect(within(branch[0]).getByRole("button", { name: /^Fact Checker, Done/ })).toBeTruthy();
  });

  it("lists the same tree in the sub-agents panel", () => {
    render(<SubagentsSidePanel timeline={timeline()} open onOpenChange={() => {}} />);
    expect(screen.getByText(/2 delegated tasks in this run — 1 by other sub-agents/)).toBeTruthy();
    const rail = screen.getByRole("list", { name: "Researcher's sub-agents" });
    expect(within(rail).getByRole("button", { name: /^Fact Checker, Done/ })).toBeTruthy();
  });

  it("nests it on the agent map, with each level's own time", () => {
    const folded = timeline();
    const map = buildAgentMap([
      { messageId: "a1", number: 1, question: "How tall?", timeline: folded, live: false },
    ]);
    const [researcher] = map.answers[0].nodes;
    expect(researcher).toMatchObject({ type: "researcher", depth: 1, status: "done" });
    expect(researcher.children.map((node) => [node.type, node.depth, node.status])).toEqual([
      ["fact-checker", 2, "done"],
    ]);
    for (const node of flattenAgentNodes(map.answers[0].nodes)) {
      expect(node.durationMs).toBeGreaterThan(0);
    }
    const flow = buildAgentMapFlow(map, { agentName: "Nested research demo" });
    expect(flow.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["root", "answer:a1"],
      ["answer:a1", researcher.id],
      [researcher.id, researcher.children[0].id],
    ]);
  });

  it("shows where the researcher delegated, and that row opens the fact-checker", () => {
    const folded = timeline();
    const [researcher] = buildAnswerNodes("a1", folded, false);
    const transcript = agentTranscript(researcher);
    const opened: SubagentBlock[] = [];
    render(
      <TimelineSequence
        timeline={transcript.timeline}
        runId="run-1"
        isStreaming={false}
        expandedThinking={ALWAYS_OPEN}
        onToggleThinking={() => {}}
        subagentLinks={{
          statusOf: (block) => subagentRunStatus(block, folded, false),
          onOpen: (block) => opened.push(block),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Fact Checker" }));
    expect(opened.map((block) => block.type)).toEqual(["fact-checker"]);
    // The child follows the step it was delegated in, not the researcher's reply.
    const kinds = transcript.timeline.blocks.map((block) => block.kind);
    expect(kinds.indexOf("subagent")).toBeLessThan(kinds.lastIndexOf("content"));
  });
});
