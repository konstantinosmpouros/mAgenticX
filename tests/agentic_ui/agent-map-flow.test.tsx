// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentMapPanel } from "@/features/chat/components/agent_map/AgentMapPanel";
import { AgentMapViewSwitch } from "@/features/chat/components/agent_map/AgentMapViewSwitch";
import {
  AGENT_MAP_VIEW_KEY,
  loadAgentMapView,
  saveAgentMapView,
} from "@/features/chat/hooks/useAgentMapView";
import {
  AGENT_MAP_ROOT_ID,
  buildAgentMap,
  type AgentMap,
  type AgentMapAnswerInput,
} from "@/features/chat/lib/agentMap";
import {
  FLOW_LAYOUT,
  FLOW_NODE_SIZE,
  buildAgentMapFlow,
  flowFrameNodeIds,
  layoutTree,
  type LayoutTree,
} from "@/features/chat/lib/agentMapFlow";
import { createTimeline, foldTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The agent map's flow view: the same map as the tree, drawn top-down with
 * React Flow — the layout (deterministic, parents centred over children, one
 * row per depth), the map → nodes/edges mapping (edge tones by status, the
 * running ones animated unless motion is reduced), what it frames on open,
 * and the header's Tree | Flow switch (remembered per browser). React Flow
 * itself is swapped for a light stand-in that renders the custom nodes.
 */

// ------------------------------------------------------
// React Flow, light: the nodes (through the view's own node types) and edges
// ------------------------------------------------------

// The markdown renderer (the detail view's) pulls in KaTeX's stylesheet, which
// Node cannot import; the answer text is not what these tests look at.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

const fitView = vi.fn(async () => true);

vi.mock("@xyflow/react", () => {
  type MockNode = { id: string; type: string; data: unknown; ariaLabel?: string };
  type MockEdge = { id: string; animated?: boolean; className?: string };
  const ReactFlow = ({
    nodes,
    edges,
    nodeTypes,
    onNodeClick,
    children,
  }: {
    nodes: MockNode[];
    edges: MockEdge[];
    nodeTypes: Record<string, (props: { id: string; data: unknown }) => JSX.Element>;
    onNodeClick?: (event: unknown, node: MockNode) => void;
    children?: unknown;
  }) => (
    <div data-testid="react-flow">
      {nodes.map((node) => {
        const NodeView = nodeTypes[node.type];
        return (
          <div
            key={node.id}
            className={`react-flow__node react-flow__node-${node.type}`}
            data-id={node.id}
            tabIndex={0}
            role="group"
            aria-label={node.ariaLabel}
            onClick={(event) => onNodeClick?.(event, node)}
          >
            <NodeView id={node.id} data={node.data} />
          </div>
        );
      })}
      {edges.map((edge) => (
        <div
          key={edge.id}
          data-testid="flow-edge"
          data-animated={String(Boolean(edge.animated))}
          className={edge.className}
        />
      ))}
      {children as JSX.Element}
    </div>
  );
  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: JSX.Element }) => children,
    useReactFlow: () => ({ fitView }),
    Handle: () => null,
    Controls: () => null,
    Background: () => null,
    Panel: ({ children }: { children: JSX.Element }) => <div>{children}</div>,
    Position: { Top: "top", Bottom: "bottom" },
    BackgroundVariant: { Dots: "dots" },
  };
});

// ------------------------------------------------------
// A realistic map: three answers — one with a nested sub-agent, one failed,
// one live with a sub-agent still running
// ------------------------------------------------------

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
const started = (taskId: string, namespace: string[], at: number): Event => ({
  ...inside(taskId, namespace, { type: "THINKING_START", timestamp: at }),
  timestamp: at,
});
const completed = (taskId: string, s: number, e: number, status = "completed"): Event => ({
  type: "CUSTOM",
  name: "SUBAGENT_COMPLETED",
  value: { task_id: taskId, status, started_at: s, ended_at: e },
});

const inputs = (): AgentMapAnswerInput[] => [
  {
    messageId: "a1",
    number: 1,
    question: "Compare the three vendors",
    live: false,
    timeline: foldTimeline(
      [
        task("r", "researcher", "Collect the prices"),
        task("w", "writer", "Draft the comparison"),
        started("r", ["tools:r"], 1_000),
        started("w", ["tools:w"], 1_200),
        inside("r", ["tools:r"], task("f", "fact-checker", "Check the prices")),
        started("f", ["tools:r", "tools:f"], 2_000),
        completed("f", 2_000, 5_000),
        completed("r", 1_000, 9_000),
        completed("w", 1_200, 6_000),
      ],
      { status: "completed" },
    ),
  },
  {
    messageId: "a2",
    number: 2,
    question: "Check the liability caps",
    live: false,
    timeline: foldTimeline(
      [
        task("l", "legal-reviewer", "Review the MSA"),
        started("l", ["tools:l"], 1_000),
        completed("l", 1_000, 4_000, "error"),
      ],
      { status: "completed" },
    ),
  },
  {
    messageId: "a3",
    number: 3,
    question: "Plan the rollout",
    live: true,
    timeline: reduceTimelineEvents(createTimeline(), [
      task("p", "planner", "Plan the phases"),
      task("b", "budget-analyst", "Estimate the costs"),
      started("p", ["tools:p"], 1_000),
      started("b", ["tools:b"], 1_100),
      completed("b", 1_100, 3_000),
    ]),
  },
];

const realisticMap = (): AgentMap => buildAgentMap(inputs());

// ------------------------------------------------------
// Layout
// ------------------------------------------------------

const leaf = (id: string, width = 100): LayoutTree => ({ id, width, height: 40, children: [] });
const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;

describe("flow layout", () => {
  const tree = (): LayoutTree => ({
    id: "root",
    width: 120,
    height: 50,
    children: [
      {
        id: "a",
        width: 100,
        height: 30,
        children: [{ ...leaf("a1"), children: [leaf("a1x"), leaf("a1y")] }, leaf("a2")],
      },
      { id: "b", width: 100, height: 30, children: [leaf("b1")] },
    ],
  });

  it("is deterministic", () => {
    expect([...layoutTree(tree())]).toEqual([...layoutTree(tree())]);
  });

  it("puts each depth on its own row, below the tallest box of the row above", () => {
    const boxes = layoutTree(tree());
    const { levelGap } = FLOW_LAYOUT;
    expect(boxes.get("root")).toMatchObject({ y: 0, depth: 0 });
    expect(boxes.get("a")).toMatchObject({ y: 50 + levelGap, depth: 1 });
    expect(boxes.get("b")?.y).toBe(boxes.get("a")?.y);
    expect(boxes.get("a1")).toMatchObject({ y: 50 + levelGap + 30 + levelGap, depth: 2 });
    expect(boxes.get("a1x")?.depth).toBe(3);
    expect(boxes.get("a1x")!.y).toBeGreaterThan(boxes.get("a1")!.y);
  });

  it("centres each parent over its first and last child", () => {
    const boxes = layoutTree(tree());
    const middle = (first: string, last: string) =>
      (centerX(boxes.get(first)!) + centerX(boxes.get(last)!)) / 2;
    // Within a pixel: positions are rounded to whole pixels.
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
    near(centerX(boxes.get("root")!), middle("a", "b"));
    near(centerX(boxes.get("a")!), middle("a1", "a2"));
    near(centerX(boxes.get("a1")!), middle("a1x", "a1y"));
    // A single child sits right under its parent.
    near(centerX(boxes.get("b1")!), centerX(boxes.get("b")!));
  });

  it("spaces siblings evenly, never overlapping within a row, wider between the answers", () => {
    const boxes = layoutTree(tree());
    const gap = (left: string, right: string) =>
      boxes.get(right)!.x - (boxes.get(left)!.x + boxes.get(left)!.width);
    expect(gap("a1x", "a1y")).toBe(FLOW_LAYOUT.siblingGap);
    expect(gap("a1", "a2")).toBeGreaterThanOrEqual(FLOW_LAYOUT.siblingGap);
    // The answers' subtrees: a's right edge (a2) and b's left edge (b1).
    expect(gap("a2", "b1")).toBeGreaterThanOrEqual(FLOW_LAYOUT.groupGap);
    for (const row of [1, 2, 3]) {
      const inRow = [...boxes.values()]
        .filter((box) => box.depth === row)
        .sort((p, q) => p.x - q.x);
      inRow.slice(1).forEach((box, index) => {
        expect(box.x).toBeGreaterThanOrEqual(inRow[index].x + inRow[index].width);
      });
    }
  });

  it("lays a lone node out at the origin", () => {
    expect(layoutTree(leaf("only")).get("only")).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      depth: 0,
    });
  });
});

// ------------------------------------------------------
// The map as nodes and edges
// ------------------------------------------------------

describe("the map as a flow graph", () => {
  it("has the main agent, each answer and every sub-agent, in reading order", () => {
    const { nodes } = buildAgentMapFlow(realisticMap(), { agentName: "Atlas" });
    expect(nodes.map((node) => node.id)).toEqual([
      AGENT_MAP_ROOT_ID,
      "answer:a1",
      "a1/r",
      "a1/f",
      "a1/w",
      "answer:a2",
      "a2/l",
      "answer:a3",
      "a3/p",
      "a3/b",
    ]);
    expect(nodes.map((node) => node.type)).toEqual([
      "agentRoot",
      "agentAnswer",
      "agentSubagent",
      "agentSubagent",
      "agentSubagent",
      "agentAnswer",
      "agentSubagent",
      "agentAnswer",
      "agentSubagent",
      "agentSubagent",
    ]);
    // Read-only, with the tree's accessible names.
    for (const node of nodes) {
      expect(node).toMatchObject({ draggable: false, connectable: false, selectable: false });
    }
    expect(nodes[0].ariaLabel).toBe("Atlas, main agent, 6 sub-agents");
    expect(nodes.find((node) => node.id === "a2/l")?.ariaLabel).toBe(
      "Legal Reviewer, failed: Review the MSA",
    );
  });

  it("sizes and places the nodes from the layout: nested ones a row below their parent", () => {
    const { nodes } = buildAgentMapFlow(realisticMap(), { agentName: "Atlas" });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(byId.get("a1/r")).toMatchObject(FLOW_NODE_SIZE.subagent);
    expect(byId.get("answer:a1")).toMatchObject(FLOW_NODE_SIZE.answer);
    expect(byId.get(AGENT_MAP_ROOT_ID)).toMatchObject(FLOW_NODE_SIZE.root);
    const y = (id: string) => byId.get(id)!.position.y;
    expect(y("answer:a1")).toBeGreaterThan(y(AGENT_MAP_ROOT_ID));
    expect(y("a1/r")).toBeGreaterThan(y("answer:a1"));
    expect(y("a1/f")).toBeGreaterThan(y("a1/r"));
    expect(y("a1/w")).toBe(y("a1/r"));
    // The fact checker hangs straight under the researcher.
    const center = (id: string) => byId.get(id)!.position.x + (byId.get(id)!.width ?? 0) / 2;
    expect(Math.abs(center("a1/f") - center("a1/r"))).toBeLessThanOrEqual(1);
  });

  it("joins parent to child, toned by the child's status, animating into running ones", () => {
    const { edges } = buildAgentMapFlow(realisticMap(), { agentName: "Atlas" });
    const byId = new Map(edges.map((edge) => [edge.id, edge]));
    expect(edges).toHaveLength(9);
    expect(byId.get("answer:a1->a1/r")).toMatchObject({ type: "smoothstep", animated: false });
    expect(byId.get("answer:a1->a1/r")?.data?.tone).toBe("done");
    expect(byId.get("a1/r->a1/f")?.data?.tone).toBe("done");
    expect(byId.get("answer:a2->a2/l")?.data?.tone).toBe("failed");
    expect(byId.get("answer:a2->a2/l")?.className).toContain("is-failed");
    expect(byId.get("answer:a3->a3/p")).toMatchObject({
      animated: true,
      data: { tone: "running" },
    });
    expect(byId.get("answer:a3->a3/p")?.className).toContain("is-running");
    expect(byId.get("answer:a3->a3/b")).toMatchObject({ animated: false, data: { tone: "done" } });
    // The main agent's edge into the answer a sub-agent works under is lit too.
    expect(byId.get(`${AGENT_MAP_ROOT_ID}->answer:a3`)).toMatchObject({
      animated: true,
      data: { tone: "running" },
    });
    expect(byId.get(`${AGENT_MAP_ROOT_ID}->answer:a1`)?.data?.tone).toBe("idle");
    expect(edges.filter((edge) => edge.animated).map((edge) => edge.id)).toEqual([
      `${AGENT_MAP_ROOT_ID}->answer:a3`,
      "answer:a3->a3/p",
    ]);
  });

  it("keeps running edges lit but still under reduced motion", () => {
    const { edges } = buildAgentMapFlow(realisticMap(), { agentName: "Atlas", animate: false });
    expect(edges.some((edge) => edge.animated)).toBe(false);
    expect(edges.find((edge) => edge.id === "answer:a3->a3/p")?.data?.tone).toBe("running");
  });

  it("draws only the answers shown", () => {
    const map = realisticMap();
    const { nodes } = buildAgentMapFlow(map, {
      agentName: "Atlas",
      answers: map.answers.slice(-1),
    });
    expect(nodes.map((node) => node.id)).toEqual([AGENT_MAP_ROOT_ID, "answer:a3", "a3/p", "a3/b"]);
  });
});

describe("what the flow frames on open", () => {
  const map = realisticMap();
  const flow = buildAgentMapFlow(map, { agentName: "Atlas" });

  it("the whole map when it reads at that size", () => {
    expect(flowFrameNodeIds(flow, map.answers, { width: 2400, height: 900 }, 0.12)).toBeNull();
  });

  it("else the main agent and the live answer's branch, else that branch alone", () => {
    expect(flowFrameNodeIds(flow, map.answers, { width: 760, height: 560 }, 0.12)).toEqual([
      AGENT_MAP_ROOT_ID,
      "answer:a3",
      "a3/p",
      "a3/b",
    ]);
    expect(flowFrameNodeIds(flow, map.answers, { width: 358, height: 600 }, 0.12)).toEqual([
      "answer:a3",
      "a3/p",
      "a3/b",
    ]);
  });
});

// ------------------------------------------------------
// The view switch and the panel
// ------------------------------------------------------

describe("the view preference", () => {
  beforeEach(() => localStorage.clear());

  it("is the tree by default and remembers the flow", () => {
    expect(loadAgentMapView()).toBe("tree");
    saveAgentMapView("flow");
    expect(localStorage.getItem(AGENT_MAP_VIEW_KEY)).toBe("flow");
    expect(loadAgentMapView()).toBe("flow");
    localStorage.setItem(AGENT_MAP_VIEW_KEY, "something else");
    expect(loadAgentMapView()).toBe("tree");
  });

  it("falls back to the tree when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadAgentMapView()).toBe("tree");
    expect(() => saveAgentMapView("flow")).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});

describe("view switch", () => {
  it("is a radio group with one tab stop; arrow keys move the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<AgentMapViewSwitch value="tree" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Agent map view" });
    const [tree, flow] = within(group).getAllByRole("radio");
    expect(tree).toHaveAccessibleName("Tree");
    expect(tree).toHaveAttribute("aria-checked", "true");
    expect(tree).toHaveAttribute("tabindex", "0");
    expect(flow).toHaveAttribute("aria-checked", "false");
    expect(flow).toHaveAttribute("tabindex", "-1");

    tree.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("flow");
    rerender(<AgentMapViewSwitch value="flow" onChange={onChange} />);
    expect(flow).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("tree");

    await user.click(flow);
    // Already chosen: no change.
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

function PanelHarness({ map }: { map: AgentMap }) {
  // The button the panel opens from (it places the panel above its composer).
  const anchorRef: { current: HTMLButtonElement | null } = { current: null };
  return (
    <TooltipProvider>
      <button ref={(element) => (anchorRef.current = element)} type="button">
        anchor
      </button>
      <AgentMapPanel
        open
        onOpenChange={() => {}}
        map={map}
        agentName="Atlas"
        anchorRef={anchorRef}
      />
    </TooltipProvider>
  );
}

describe("agent map panel: tree | flow", () => {
  beforeEach(() => {
    localStorage.clear();
    fitView.mockClear();
  });

  it("opens on the tree, switches to the flow and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PanelHarness map={realisticMap()} />);
    const dialog = await screen.findByRole("dialog", { name: "Agent map" });
    expect(within(dialog).getByRole("tree", { name: "Agent map" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Tree" })).toBeChecked();

    await user.click(within(dialog).getByRole("radio", { name: "Flow" }));
    expect(await within(dialog).findByTestId("react-flow")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Flow" })).toBeChecked();
    expect(localStorage.getItem(AGENT_MAP_VIEW_KEY)).toBe("flow");
    // The switch keeps the focus.
    expect(within(dialog).getByRole("radio", { name: "Flow" })).toHaveFocus();

    unmount();
    render(<PanelHarness map={realisticMap()} />);
    const again = await screen.findByRole("dialog", { name: "Agent map" });
    expect(await within(again).findByTestId("react-flow")).toBeInTheDocument();
    expect(within(again).getByRole("radio", { name: "Flow" })).toBeChecked();
  });

  it("draws the flow's nodes as the view's own cards, the running edges animated", async () => {
    saveAgentMapView("flow");
    render(<PanelHarness map={realisticMap()} />);
    const flow = await screen.findByTestId("react-flow");

    const root = flow.querySelector<HTMLElement>(`[data-id="${AGENT_MAP_ROOT_ID}"]`)!;
    expect(root).toHaveTextContent("Atlas");
    expect(root).toHaveTextContent("1 working");
    const answer = flow.querySelector<HTMLElement>('[data-id="answer:a2"]')!;
    expect(answer).toHaveTextContent("Q2");
    expect(answer).toHaveTextContent("Check the liability caps");
    const planner = flow.querySelector<HTMLElement>('[data-id="a3/p"]')!;
    expect(planner).toHaveTextContent("Planner");
    expect(planner).toHaveTextContent("Running");
    // The travelling light of the tree's running card.
    expect(planner.querySelector(".subagent-card")).toHaveAttribute("data-active", "true");
    const failed = flow.querySelector<HTMLElement>('[data-id="a2/l"]')!;
    expect(failed).toHaveTextContent("Failed");
    expect(failed.querySelector(".subagent-card")).toHaveAttribute("data-active", "false");

    const animated = within(flow)
      .getAllByTestId("flow-edge")
      .filter((edge) => edge.dataset.animated === "true");
    expect(animated).toHaveLength(2);
  });

  it("opens a sub-agent's detail on click and on Enter; an answer frames its branch", async () => {
    saveAgentMapView("flow");
    const user = userEvent.setup();
    render(<PanelHarness map={realisticMap()} />);
    const dialog = await screen.findByRole("dialog", { name: "Agent map" });
    const flow = await within(dialog).findByTestId("react-flow");

    await user.click(flow.querySelector<HTMLElement>('[data-id="answer:a1"]')!);
    expect(fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: [{ id: "answer:a1" }, { id: "a1/r" }, { id: "a1/f" }, { id: "a1/w" }],
      }),
    );

    const factChecker = flow.querySelector<HTMLElement>('[data-id="a1/f"]')!;
    act(() => factChecker.focus());
    fireEvent.keyDown(factChecker, { key: "Enter" });
    expect(
      await within(dialog).findByText("Fact Checker", { selector: '[aria-current="page"]' }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    const back = await within(dialog).findByTestId("react-flow");
    await user.click(back.querySelector<HTMLElement>('[data-id="a2/l"]')!);
    expect(
      await within(dialog).findByText("Legal Reviewer", { selector: '[aria-current="page"]' }),
    ).toBeInTheDocument();
  });

  it("shows the empty state, and no switch, when nothing was delegated", async () => {
    saveAgentMapView("flow");
    render(<PanelHarness map={buildAgentMap([])} />);
    const dialog = await screen.findByRole("dialog", { name: "Agent map" });
    expect(within(dialog).getByText("No sub-agents yet")).toBeInTheDocument();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).queryByTestId("react-flow")).toBeNull();
  });
});
