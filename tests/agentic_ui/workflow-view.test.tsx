// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import WorkflowGraph from "@/features/workflows/components/workflow_view_parts/WorkflowGraph";
import { ExecutionTimeline } from "@/features/workflows/components/workflow_view_parts/ExecutionTimeline";
import { ExecutionDetails } from "@/features/workflows/components/workflow_view_parts/ExecutionDetails";
import { RunInputDialog } from "@/features/workflows/components/workflow_view_parts/RunInputDialog";
import { WorkflowViewPage } from "@/features/workflows/components/WorkflowViewPage";
import { WorkflowNodeCard } from "@/features/workflows/components/workflow_parts/WorkflowNodeCard";
import { WorkflowEdge } from "@/features/workflows/components/workflow_parts/WorkflowEdge";
import { buildWorkflowFlow, latestExecution } from "@/features/workflows/lib/graph";
import {
  backEdgeFloor,
  bezierPoints,
  findBackEdges,
  layoutIsClean,
  type LayoutBox,
} from "@/features/workflows/lib/layout";
import { HEADER_HANDLE_TOP, branchHandleTop, nodeBranches } from "@/features/workflows/lib/nodeCard";
import fetchLoopApproval from "../agents/fixtures/workflows/fetch_loop_approval.json";
import { buildRunInputs, initialInputDraft } from "@/features/workflows/lib/inputs";
import { buildTimelineRows, newestExecution } from "@/features/workflows/lib/timeline";
import { formatDuration, toPatchOps, toTimelineTool } from "@/features/workflows/lib/format";
import type {
  Workflow,
  WorkflowExecution,
  WorkflowEdgeData,
  WorkflowInputDef,
  WorkflowNodeCardData,
  WorkflowNodeKindInfo,
  WorkflowRun,
  WorkflowRunView,
  WorkflowSpec,
} from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";

/**
 * The workflow view (plan 38, step 2) — its visual pieces over a fixture run:
 * the graph overlay (status per node from its last execution, ×N for a node
 * that ran more than once, the branch taken lit), the timeline (startSeq
 * order, a loop's body indented under the loop), the details tabs, the
 * approval card answering through `resume`, the Run dialog building typed
 * inputs from the spec (and showing a refusal inline), and the page wiring
 * (latest run by default, the empty state before the first run). React Flow
 * is swapped for a light stand-in that renders the custom nodes.
 */

// ------------------------------------------------------
// React Flow, light
// ------------------------------------------------------

const flowSpies = vi.hoisted(() => ({ deleteElements: vi.fn() }));

vi.mock("@xyflow/react", () => {
  type MockNode = { id: string; type: string; data: unknown; ariaLabel?: string };
  type MockEdge = { id: string; animated?: boolean; className?: string; label?: string };
  const ReactFlow = ({
    nodes,
    edges,
    nodeTypes,
    onNodeClick,
  }: {
    nodes: MockNode[];
    edges: MockEdge[];
    nodeTypes: Record<string, (props: { id: string; data: unknown }) => JSX.Element>;
    onNodeClick?: (event: unknown, node: MockNode) => void;
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
          data-testid={`flow-edge-${edge.id}`}
          data-animated={String(Boolean(edge.animated))}
          className={edge.className}
        >
          {edge.label}
        </div>
      ))}
    </div>
  );
  const Handle = ({
    type,
    id,
    position,
    className,
  }: {
    type: string;
    id?: string;
    position: string;
    className?: string;
  }) => (
    <span
      data-testid="flow-handle"
      data-type={type}
      data-handle-id={id ?? ""}
      data-position={position}
      className={className}
    />
  );
  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: JSX.Element }) => children,
    useReactFlow: () => ({ fitView: async () => true, deleteElements: flowSpies.deleteElements }),
    useInternalNode: () => undefined,
    Handle,
    BaseEdge: ({ path, id }: { path: string; id?: string }) => (
      <path data-testid={`base-edge-${id}`} className="react-flow__edge-path" d={path} />
    ),
    EdgeLabelRenderer: ({ children }: { children: JSX.Element }) => children,
    getBezierPath: () => ["M 0,0 C 1,1 2,2 3,3", 50, 60],
    Controls: () => null,
    Background: () => null,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    BackgroundVariant: { Dots: "dots" },
  };
});

// The chat's markdown renderer pulls in KaTeX's stylesheet, which Node cannot import.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

// The page's data hooks (the data layer is tested on its own).
const hooks = vi.hoisted(() => ({
  useWorkflow: vi.fn(),
  useWorkflowRuns: vi.fn(),
  useWorkflowRun: vi.fn(),
}));
vi.mock("@/features/workflows/hooks/useWorkflow", () => ({ useWorkflow: hooks.useWorkflow }));
vi.mock("@/features/workflows/hooks/useWorkflowRuns", () => ({
  useWorkflowRuns: hooks.useWorkflowRuns,
}));
vi.mock("@/features/workflows/hooks/useWorkflowRun", () => ({
  useWorkflowRun: hooks.useWorkflowRun,
}));

// ------------------------------------------------------
// Fixture: start → loop (continue → poll → loop, done → check) → check
// (true → approve, false → end); poll ran three times inside loop#1, check
// took "true", approve waits on an approval.
// ------------------------------------------------------

const spec: WorkflowSpec = {
  version: 1,
  name: "Poll and approve",
  description: "Polls an API until ready, then asks.",
  inputs: [],
  state: [],
  nodes: [
    { id: "start", kind: "trigger.manual", label: "Start", config: {}, position: { x: 0, y: 0 } },
    { id: "loop", kind: "loop", label: "Until ready", config: {}, position: { x: 0, y: 120 } },
    { id: "poll", kind: "fetch", label: "Poll API", config: {}, position: { x: 260, y: 240 } },
    { id: "check", kind: "condition", label: "Ready?", config: {}, position: { x: 0, y: 360 } },
    { id: "approve", kind: "approval", label: "Sign-off", config: {}, position: { x: 0, y: 480 } },
    { id: "end", kind: "end", label: "Done", config: {}, position: { x: 260, y: 480 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "loop" },
    { id: "e2", source: "loop", target: "poll", branch: "continue" },
    { id: "e3", source: "poll", target: "loop" },
    { id: "e4", source: "loop", target: "check", branch: "done" },
    { id: "e5", source: "check", target: "approve", branch: "true" },
    { id: "e6", source: "check", target: "end", branch: "false" },
  ],
};

const catalog: WorkflowNodeKindInfo[] = [
  {
    kind: "fetch",
    label: "HTTP fetch",
    group: "Data",
    description: "",
    branches: [],
    dynamicBranches: false,
    isTrigger: false,
    configSchema: {},
  },
  {
    kind: "condition",
    label: "Condition",
    group: "Logic",
    description: "",
    branches: ["true", "false"],
    dynamicBranches: false,
    isTrigger: false,
    configSchema: {},
  },
];

const exec = (
  over: Partial<WorkflowExecution> & Pick<WorkflowExecution, "executionId" | "nodeId" | "startSeq">,
): WorkflowExecution => ({
  iteration: 1,
  parentExecutionId: null,
  status: "succeeded",
  endSeq: over.startSeq + 1,
  startedAt: "2026-11-04T10:00:00Z",
  durationMs: 1200,
  input: null,
  output: null,
  branch: null,
  error: null,
  stateDelta: [],
  toolCalls: [],
  text: "",
  approval: null,
  events: [],
  ...over,
});

const executions: WorkflowExecution[] = [
  exec({ executionId: "start#1", nodeId: "start", startSeq: 1 }),
  exec({ executionId: "loop#1", nodeId: "loop", startSeq: 2, endSeq: 9, branch: "done" }),
  exec({ executionId: "poll#1", nodeId: "poll", startSeq: 3, parentExecutionId: "loop#1" }),
  exec({
    executionId: "poll#2",
    nodeId: "poll",
    startSeq: 5,
    parentExecutionId: "loop#1",
    iteration: 2,
  }),
  exec({
    executionId: "poll#3",
    nodeId: "poll",
    startSeq: 7,
    parentExecutionId: "loop#1",
    iteration: 3,
  }),
  exec({ executionId: "check#1", nodeId: "check", startSeq: 10, branch: "true" }),
  exec({
    executionId: "approve#1",
    nodeId: "approve",
    startSeq: 12,
    endSeq: null,
    durationMs: null,
    status: "waiting",
    approval: {
      message: "Ship the report?",
      payload: { amount: 5 },
      allowedDecisions: ["approve", "reject"],
    },
  }),
];

const byNode = (list: WorkflowExecution[]): Record<string, WorkflowExecution[]> => {
  const map: Record<string, WorkflowExecution[]> = {};
  for (const execution of [...list].sort((a, b) => a.startSeq - b.startSeq)) {
    (map[execution.nodeId] ??= []).push(execution);
  }
  return map;
};

// Shuffled on purpose: the timeline must order by startSeq itself.
const view: WorkflowRunView = {
  executions: [
    executions[6],
    executions[2],
    executions[0],
    executions[4],
    executions[1],
    executions[5],
    executions[3],
  ],
  byNode: byNode(executions),
  lastSeq: 12,
  output: null,
  runError: null,
};

// ------------------------------------------------------
// Graph overlay
// ------------------------------------------------------

describe("graph overlay", () => {
  it("takes each node's status from its last execution and counts its runs", () => {
    const { nodes } = buildWorkflowFlow({
      spec,
      view,
      catalog,
      selectedNodeId: "poll",
      animate: true,
    });
    const data = Object.fromEntries(nodes.map((node) => [node.id, node.data]));
    expect(data.poll).toMatchObject({
      executionCount: 3,
      status: "succeeded",
      mode: "view",
      selected: true,
      dimmed: false,
    });
    expect(data.poll.kindInfo?.label).toBe("HTTP fetch");
    expect(data.approve).toMatchObject({ executionCount: 1, status: "waiting" });
    // The run is under way and has not reached "end": drawn faded.
    expect(data.end).toMatchObject({ executionCount: 0, status: null, dimmed: true });
    expect(data.check).toMatchObject({ branches: ["true", "false"], takenBranch: "true" });
    expect(data.start.isTrigger).toBe(true);
  });

  it("keeps the spec's positions on request and lays a cramped spec out left to right", () => {
    const at = (layout: "spec" | "smart") =>
      Object.fromEntries(
        buildWorkflowFlow({ spec, view, catalog, selectedNodeId: null, animate: true, layout })
          .nodes.map((node) => [node.id, node.position]),
      );
    expect(at("spec").poll).toEqual({ x: 260, y: 240 });
    // The fixture is stacked top to bottom, so "smart" lays it out itself.
    const auto = at("smart");
    expect(auto.start.x).toBeLessThan(auto.loop.x);
    expect(auto.loop.x).toBeLessThan(auto.check.x);
    expect(auto.check.x).toBeLessThan(auto.approve.x);
  });

  it("lights the branch each node last took, and no other", () => {
    const { edges } = buildWorkflowFlow({
      spec,
      view,
      catalog,
      selectedNodeId: null,
      animate: true,
    });
    const taken = Object.fromEntries(edges.map((edge) => [edge.id, edge.data?.taken]));
    expect(taken).toEqual({ e1: true, e2: false, e3: true, e4: true, e5: true, e6: false });
    const e5 = edges.find((edge) => edge.id === "e5");
    expect(e5).toMatchObject({ sourceHandle: "true", type: "workflowEdge", data: { branch: "true" } });
    // "check" went "true": its "false" branch is muted; poll → loop closes the loop.
    expect(edges.find((edge) => edge.id === "e6")?.data).toMatchObject({ untaken: true });
    expect(edges.find((edge) => edge.id === "e6")?.className).toContain("is-untaken");
    expect(edges.find((edge) => edge.id === "e3")?.data).toMatchObject({ back: true });
    expect(edges.find((edge) => edge.id === "e3")?.data?.floorY).toBeGreaterThan(0);
  });

  it("animates the edge into a running node unless motion is reduced", () => {
    const running: WorkflowRunView = {
      ...view,
      byNode: {
        ...view.byNode,
        approve: [{ ...executions[6], status: "running", approval: null }],
      },
    };
    const edge = (animate: boolean) =>
      buildWorkflowFlow({ spec, view: running, catalog, selectedNodeId: null, animate }).edges.find(
        (e) => e.id === "e5",
      );
    expect(edge(true)).toMatchObject({ animated: true, data: { running: true } });
    expect(edge(false)?.animated).toBe(false);
  });

  it("renders the status and the ×N badge on the cards, and a click selects the node", async () => {
    const onSelectNode = vi.fn();
    render(
      <WorkflowGraph
        spec={spec}
        view={view}
        catalog={catalog}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />,
    );
    expect(screen.getByTestId("workflow-node-count-poll")).toHaveTextContent("×3");
    expect(screen.queryByTestId("workflow-node-count-start")).toBeNull();
    expect(screen.getByTestId("workflow-node-approve")).toHaveAttribute("data-status", "waiting");
    expect(screen.getByTestId("workflow-node-end")).toHaveAttribute("data-status", "idle");
    expect(
      within(screen.getByTestId("workflow-node-approve")).getByText("Waiting"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("flow-edge-e5").className).toContain("is-taken");
    expect(screen.getByTestId("flow-edge-e6").className).not.toContain("is-taken");
    fireEvent.click(screen.getByRole("group", { name: /Poll API/ }));
    expect(onSelectNode).toHaveBeenCalledWith("poll");
    expect(latestExecution(view, "poll")?.executionId).toBe("poll#3");
  });
});

// ------------------------------------------------------
// Layout — tests/agents/fixtures/workflows/fetch_loop_approval.json
// ------------------------------------------------------

const kindInfo = (
  kind: string,
  over: Partial<WorkflowNodeKindInfo> = {},
): WorkflowNodeKindInfo => ({
  kind,
  label: kind,
  group: "flow",
  description: "",
  branches: [],
  dynamicBranches: false,
  isTrigger: false,
  configSchema: {},
  ...over,
});

const fullCatalog: WorkflowNodeKindInfo[] = [
  kindInfo("trigger.manual", { label: "Manual trigger", isTrigger: true }),
  kindInfo("fetch", { label: "HTTP fetch" }),
  kindInfo("condition", { label: "Condition", branches: ["true", "false"] }),
  kindInfo("loop", { label: "Loop", branches: ["continue", "done"] }),
  kindInfo("approval", { label: "Approval", branches: ["approved", "rejected"] }),
  kindInfo("router", { label: "Router", branches: ["default"], dynamicBranches: true }),
  kindInfo("end", { label: "End" }),
];

describe("layout", () => {
  const jobSpec = fetchLoopApproval as WorkflowSpec;
  const flow = buildWorkflowFlow({
    spec: jobSpec,
    view: null,
    catalog: fullCatalog,
    selectedNodeId: null,
    animate: true,
  });
  const boxes: Record<string, LayoutBox> = Object.fromEntries(
    flow.nodes.map((node) => [
      node.id,
      { ...node.position, width: node.width ?? 0, height: node.height ?? 0 },
    ]),
  );
  const branchesOf = Object.fromEntries(flow.nodes.map((node) => [node.id, node.data.branches]));
  const handleTop = (id: string, branch: string | null | undefined) => {
    const index = branch ? branchesOf[id].indexOf(branch) : -1;
    return index >= 0 ? branchHandleTop(index) : HEADER_HANDLE_TOP;
  };

  it("finds the loop's back-edge and draws only it, as an arc under the cards", () => {
    expect(findBackEdges(jobSpec.nodes, jobSpec.edges)).toEqual(new Set(["e5"]));
    const back = flow.edges.filter((edge) => edge.data?.back).map((edge) => edge.id);
    expect(back).toEqual(["e5"]);
    const floor = flow.edges.find((edge) => edge.id === "e5")!.data!.floorY!;
    expect(floor).toBe(backEdgeFloor(boxes, "retry", "poll"));
    // Every card sits above the arc's floor (they all lie in its span here or left of it).
    for (const box of Object.values(boxes)) {
      if (box.x <= boxes.retry.x) expect(box.y + box.height).toBeLessThan(floor);
    }
  });

  it("reads left to right: no overlap, every forward edge goes right, no curve through a card", () => {
    expect(layoutIsClean(boxes, jobSpec.edges, new Set(["e5"]), handleTop)).toBe(true);
    for (const edge of jobSpec.edges.filter((entry) => entry.id !== "e5")) {
      expect(boxes[edge.target].x).toBeGreaterThan(boxes[edge.source].x + boxes[edge.source].width);
    }
    // The spec's own positions (cards 240 apart, 240 wide) would not pass.
    const specBoxes = Object.fromEntries(
      jobSpec.nodes.map((node) => [node.id, { ...boxes[node.id], ...node.position }]),
    );
    expect(layoutIsClean(specBoxes, jobSpec.edges, new Set(["e5"]), handleTop)).toBe(false);
    // A condition's "true" target sits above its "false" one.
    expect(boxes.approve.y).toBeLessThan(boxes.retry.y);
    // The sampler walks the whole curve.
    const points = bezierPoints({ x: 0, y: 0 }, { x: 600, y: 0 });
    expect(points.some((point) => point.x > 250 && point.x < 350)).toBe(true);
  });

  it("puts every branch name on its card, beside its own handle", () => {
    render(
      <WorkflowGraph
        spec={jobSpec}
        view={null}
        catalog={fullCatalog}
        selectedNodeId={null}
        onSelectNode={() => {}}
      />,
    );
    const approve = screen.getByTestId("workflow-node-approve");
    expect(within(approve).getByText("approved")).toBeInTheDocument();
    expect(within(approve).getByText("rejected")).toBeInTheDocument();
    const sources = within(approve)
      .getAllByTestId("flow-handle")
      .filter((handle) => handle.dataset.type === "source")
      .map((handle) => handle.dataset.handleId);
    expect(sources).toEqual(["approved", "rejected"]);
  });

  it("lists a router's cases as branches, then default, then any branch an edge uses", () => {
    expect(
      nodeBranches(
        { id: "route", config: { cases: [{ name: "big" }, { name: "small" }, { bad: 1 }] } },
        fullCatalog.find((entry) => entry.kind === "router")!,
        [
          { source: "route", branch: "small" },
          { source: "route", branch: "legacy" },
          { source: "other", branch: "x" },
        ],
      ),
    ).toEqual(["big", "small", "default", "legacy"]);
    expect(nodeBranches({ id: "n", config: {} }, null, [])).toEqual([]);
  });
});

// ------------------------------------------------------
// Shared node card + edge
// ------------------------------------------------------

describe("workflow node card", () => {
  const cardData = (over: Partial<WorkflowNodeCardData> = {}): WorkflowNodeCardData => ({
    nodeId: "check",
    kind: "condition",
    label: "Ready?",
    kindInfo: fullCatalog.find((entry) => entry.kind === "condition")!,
    mode: "view",
    branches: ["true", "false"],
    isTrigger: false,
    ...over,
  });
  // The card only reads `data` and `selected` from React Flow's node props.
  const renderCard = (data: WorkflowNodeCardData) =>
    render(<WorkflowNodeCard
        {...({ id: data.nodeId, data, selected: false } as unknown as Parameters<
          typeof WorkflowNodeCard
        >[0])}
      />);
  const handles = () =>
    screen.getAllByTestId("flow-handle").map((handle) => ({
      type: handle.dataset.type,
      id: handle.dataset.handleId,
      position: handle.dataset.position,
    }));

  it("has a target on the left and one source handle per branch on the right", () => {
    renderCard(cardData());
    expect(handles()).toEqual([
      { type: "target", id: "", position: "left" },
      { type: "source", id: "true", position: "right" },
      { type: "source", id: "false", position: "right" },
    ]);
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("Condition")).toBeInTheDocument();
  });

  it("has one plain source and no target for a trigger with no branches", () => {
    renderCard(
      cardData({
        nodeId: "start",
        kind: "trigger.manual",
        branches: [],
        isTrigger: true,
        kindInfo: null,
      }),
    );
    expect(handles()).toEqual([{ type: "source", id: "", position: "right" }]);
    // No catalogue yet: the kind is named from its id.
    expect(screen.getByText("Trigger manual")).toBeInTheDocument();
  });

  it.each([
    ["running", "Running"],
    ["waiting", "Waiting"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("marks a %s node with its class, data-status and labelled chip", (status, label) => {
    renderCard(cardData({ status, executionCount: 1 }));
    const node = screen.getByTestId("workflow-node-check");
    expect(node).toHaveAttribute("data-status", status);
    expect(node.className).toContain(`workflow-node--${status}`);
    expect(within(node).getByText(label)).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-node-count-check")).toBeNull();
  });

  it("shows ×N from two runs up, lights the taken branch, and outlines the selection", () => {
    renderCard(
      cardData({ status: "succeeded", executionCount: 4, takenBranch: "false", selected: true }),
    );
    expect(screen.getByTestId("workflow-node-count-check")).toHaveTextContent("×4");
    expect(screen.getByTestId("workflow-node-check")).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("false").className).toContain("is-taken");
    expect(screen.getByText("true").className).not.toContain("is-taken");
  });

  it("fades a node the run has not reached", () => {
    renderCard(cardData({ status: null, dimmed: true }));
    const idle = screen.getByTestId("workflow-node-check");
    expect(idle).toHaveAttribute("data-status", "idle");
    expect(idle).toHaveAttribute("data-dimmed", "true");
    expect(idle.className).toContain("workflow-node--idle");
  });

  it("in edit mode shows the issue badge, connectable handles and a delete action, never the run", () => {
    const onDelete = vi.fn();
    renderCard(
      cardData({ mode: "edit", issueCount: 2, hasErrors: true, status: "running", onDelete }),
    );
    expect(screen.getByTestId("workflow-node-issues-check")).toHaveTextContent("2");
    const node = screen.getByTestId("workflow-node-check");
    expect(node).toHaveAttribute("data-status", "idle");
    expect(node).toHaveAttribute("data-errors", "true");
    expect(
      screen
        .getAllByTestId("flow-handle")
        .every((handle) => !handle.className.includes("is-readonly")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete Ready?" }));
    expect(onDelete).toHaveBeenCalledWith("check");
  });

  it("shows no issue badge in view mode", () => {
    renderCard(cardData({ issueCount: 3 }));
    expect(screen.queryByTestId("workflow-node-issues-check")).toBeNull();
  });
});

describe("workflow edge", () => {
  const renderEdge = (data: WorkflowEdgeData, at = { sx: 0, sy: 30, tx: 200, ty: 30 }) =>
    render(
      <svg>
        <WorkflowEdge
          {...({
            id: "e1",
            source: "a",
            target: "b",
            sourceX: at.sx,
            sourceY: at.sy,
            targetX: at.tx,
            targetY: at.ty,
            data,
            selected: false,
          } as unknown as Parameters<typeof WorkflowEdge>[0])}
        />
      </svg>,
    );

  it("draws a forward edge as a bezier with one arrowhead, toned by the run", () => {
    const { container } = renderEdge({ mode: "view", branch: "true", taken: true });
    expect(container.querySelector(".workflow-edge")).toHaveAttribute("data-tone", "taken");
    expect(screen.getByTestId("base-edge-e1").getAttribute("d")).toBe("M 0,0 C 1,1 2,2 3,3");
    expect(container.querySelectorAll(".workflow-edge-arrow")).toHaveLength(1);
    // Branch names live on the cards, not on the line.
    expect(screen.queryByText("true")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws a back-edge as an arc down to its floor and back", () => {
    const { container } = renderEdge(
      { mode: "view", branch: "continue", back: true, floorY: 300 },
      { sx: 600, sy: 100, tx: 100, ty: 30 },
    );
    expect(container.querySelector(".workflow-edge")?.getAttribute("class")).toContain("is-back");
    const d = screen.getByTestId("base-edge-e1").getAttribute("d")!;
    expect(d.startsWith("M 600,100")).toBe(true);
    expect(d).toContain("L 100,300");
    expect(d.endsWith("100,30")).toBe(true);
  });

  it("in edit mode deletes through onDelete, else through React Flow", () => {
    const onDelete = vi.fn();
    const first = renderEdge({ mode: "edit", branch: null, onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(onDelete).toHaveBeenCalledWith("e1");
    first.unmount();
    renderEdge({ mode: "edit", branch: "false" });
    fireEvent.click(screen.getByRole("button", { name: "Delete the false connection" }));
    expect(flowSpies.deleteElements).toHaveBeenCalledWith({ edges: [{ id: "e1" }] });
  });
});

// ------------------------------------------------------
// Timeline
// ------------------------------------------------------

describe("timeline", () => {
  it("orders by startSeq and indents a loop's body under the loop", () => {
    const rows = buildTimelineRows(view, spec, catalog);
    expect(rows.map((row) => row.execution.executionId)).toEqual([
      "start#1",
      "loop#1",
      "poll#1",
      "poll#2",
      "poll#3",
      "check#1",
      "approve#1",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 1, 1, 0, 0]);
    expect(rows[2]).toMatchObject({ label: "Poll API", kindLabel: "HTTP fetch", rails: [0, 1] });
    expect(newestExecution(view)?.executionId).toBe("approve#1");
  });

  it("renders one option per execution in order, selects on click, and offers to follow again", () => {
    const rows = buildTimelineRows(view, spec, catalog);
    const onSelect = vi.fn();
    const onFollow = vi.fn();
    render(
      <ExecutionTimeline
        rows={rows}
        selectedId="poll#2"
        onSelect={onSelect}
        following={false}
        onFollow={onFollow}
        isLive
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("data-execution-id"))).toEqual(
      rows.map((row) => row.execution.executionId),
    );
    expect(options.map((option) => option.getAttribute("data-depth"))).toEqual([
      "0",
      "0",
      "1",
      "1",
      "1",
      "0",
      "0",
    ]);
    expect(options[3]).toHaveAttribute("aria-selected", "true");
    expect(within(options[5]).getByText("true")).toBeInTheDocument(); // the branch check took
    fireEvent.click(options[4]);
    expect(onSelect).toHaveBeenCalledWith("poll#3");
    fireEvent.keyDown(options[3], { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("poll#3");
    fireEvent.click(screen.getByRole("button", { name: /Follow live/ }));
    expect(onFollow).toHaveBeenCalled();
  });

  it("hides Follow live while already following", () => {
    const rows = buildTimelineRows(view, spec, catalog);
    render(
      <ExecutionTimeline
        rows={rows}
        selectedId="approve#1"
        onSelect={vi.fn()}
        following
        onFollow={vi.fn()}
        isLive
      />,
    );
    expect(screen.queryByRole("button", { name: /Follow live/ })).toBeNull();
  });
});

// ------------------------------------------------------
// Details panel
// ------------------------------------------------------

describe("details panel", () => {
  const detailed = exec({
    executionId: "poll#2",
    nodeId: "poll",
    startSeq: 5,
    input: { url: "https://api.example.test/status" },
    output: { status: 200 },
    text: "Checked the status.",
    stateDelta: [{ op: "add", path: "/attempts/-", value: 2 }],
    toolCalls: [
      {
        toolCallId: "t1",
        name: "http_get",
        args: { url: "x" },
        result: { ok: true },
        error: false,
      },
    ],
    events: [
      {
        seq: 5,
        type: "STEP_STARTED",
        nodeId: "poll",
        executionId: "poll#2",
        parentExecutionId: "loop#1",
        payload: { stepName: "poll" },
        createdAt: "2026-11-04T10:00:00Z",
      },
      {
        seq: 6,
        type: "STEP_FINISHED",
        nodeId: "poll",
        executionId: "poll#2",
        parentExecutionId: "loop#1",
        payload: {},
        createdAt: "2026-11-04T10:00:01Z",
      },
    ],
  });

  it("opens on Output and switches through every tab", () => {
    render(
      <ExecutionDetails
        execution={detailed}
        label="Poll API"
        kindLabel="HTTP fetch"
        onResume={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual([
      "Input",
      "Output",
      "State",
      "Tool calls",
      "Raw events",
    ]);
    const panel = () => screen.getByRole("tabpanel");
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel()).getByText("Checked the status.")).toBeInTheDocument();
    expect(within(panel()).getByText("200")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Input" }));
    expect(within(panel()).getByText(/api\.example\.test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /State/ }));
    expect(within(panel()).getByText("/attempts/-")).toBeInTheDocument();
    expect(within(panel()).getByText("add")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Tool calls/ }));
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: /Raw events/ }));
    expect(within(panel()).getByText("STEP_STARTED")).toBeInTheDocument();
    expect(within(panel()).getByText("STEP_FINISHED")).toBeInTheDocument();
  });

  it("shows the execution's error", () => {
    render(
      <ExecutionDetails
        execution={{
          ...detailed,
          status: "failed",
          error: { code: "http_500", message: "Upstream broke." },
        }}
        label="Poll API"
        kindLabel="HTTP fetch"
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Upstream broke.");
    expect(screen.getByRole("alert")).toHaveTextContent("http_500");
  });

  it("formats durations, patch ops and tool calls for the panes", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(toPatchOps([{ op: "replace", path: "/a", value: 1 }, "odd"])).toEqual([
      { op: "replace", path: "/a", value: 1, hasValue: true },
      { op: "?", path: "", value: "odd", hasValue: true },
    ]);
    expect(
      toTimelineTool({ toolCallId: "t", name: "ls", args: {}, result: null, error: false }).state,
    ).toBe("input-available");
    expect(
      toTimelineTool({ toolCallId: "t", name: "ls", args: {}, result: "x", error: true }).state,
    ).toBe("output-error");
  });
});

// ------------------------------------------------------
// Approval
// ------------------------------------------------------

describe("approval card", () => {
  it("sends the decision and the comment through resume", async () => {
    const onResume = vi.fn(async () => undefined);
    render(
      <ExecutionDetails
        execution={executions[6]}
        label="Sign-off"
        kindLabel="Approval"
        onResume={onResume}
      />,
    );
    const card = screen.getByRole("region", { name: "Approval required" });
    expect(within(card).getByText("Ship the report?")).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/Comment/), {
      target: { value: "  looks good " },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith("approve", "looks good"));
  });

  it("offers only the allowed decisions and shows a failed send inline", async () => {
    const onResume = vi.fn(async () => {
      throw new Error("Run is not waiting.");
    });
    const execution = {
      ...executions[6],
      approval: { message: "Go?", payload: null, allowedDecisions: ["reject" as const] },
    };
    render(
      <ExecutionDetails
        execution={execution}
        label="Sign-off"
        kindLabel="Approval"
        onResume={onResume}
      />,
    );
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith("reject", undefined));
    expect(await screen.findByText("Run is not waiting.")).toBeInTheDocument();
  });

  it("is not shown once the execution is no longer waiting", () => {
    render(
      <ExecutionDetails
        execution={{ ...executions[6], status: "succeeded" }}
        label="Sign-off"
        kindLabel="Approval"
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Approval required" })).toBeNull();
  });
});

// ------------------------------------------------------
// Run dialog
// ------------------------------------------------------

const inputs: WorkflowInputDef[] = [
  { name: "city", type: "string", required: true, description: "Where to look." },
  { name: "days", type: "number", default: 3 },
  { name: "verbose", type: "boolean" },
  { name: "filters", type: "object" },
  { name: "tags", type: "array", default: ["a"] },
];

describe("run inputs", () => {
  it("starts from the defaults and builds typed inputs", () => {
    const draft = initialInputDraft(inputs);
    expect(draft).toEqual({
      city: "",
      days: "3",
      verbose: false,
      filters: "",
      tags: '[\n  "a"\n]',
    });
    expect(buildRunInputs(inputs, draft).errors).toEqual({ city: "Required." });
    const built = buildRunInputs(inputs, {
      ...draft,
      city: "Athens",
      verbose: true,
      filters: '{"a":1}',
    });
    expect(built).toEqual({
      inputs: { city: "Athens", days: 3, verbose: true, filters: { a: 1 }, tags: ["a"] },
      errors: {},
    });
  });

  it("refuses a non-number, bad JSON and the wrong JSON shape", () => {
    const { errors } = buildRunInputs(inputs, {
      city: "x",
      days: "three",
      verbose: false,
      filters: "[1]",
      tags: "{",
    });
    expect(errors).toEqual({
      days: "Enter a number.",
      filters: "Enter a JSON object.",
      tags: "Not valid JSON.",
    });
  });

  it("generates the form from the spec and submits the built inputs", async () => {
    const onStart = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    render(
      <RunInputDialog
        open
        onOpenChange={onOpenChange}
        workflowName="Poll"
        inputs={inputs}
        onStart={onStart}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/days/)).toHaveValue("3");
    expect(within(dialog).getByLabelText("verbose")).not.toBeChecked();

    fireEvent.click(within(dialog).getByRole("button", { name: /Start run/ }));
    expect(await within(dialog).findByText("Required.")).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/city/), { target: { value: "Athens" } });
    fireEvent.click(within(dialog).getByLabelText("verbose"));
    fireEvent.change(within(dialog).getByLabelText(/filters/), {
      target: { value: '{"region":"eu"}' },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Start run/ }));
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith({
        city: "Athens",
        days: 3,
        verbose: true,
        filters: { region: "eu" },
        tags: ["a"],
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps the dialog open with the refusal inline (409)", async () => {
    const onStart = vi.fn(async () => {
      throw new Error("This workflow already has a run in progress.");
    });
    const onOpenChange = vi.fn();
    render(
      <RunInputDialog
        open
        onOpenChange={onOpenChange}
        workflowName="Poll"
        inputs={[]}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Start run/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has a run in progress");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

// ------------------------------------------------------
// The page
// ------------------------------------------------------

const workflow: Workflow = {
  id: "wf1",
  name: "Poll and approve",
  description: "Polls an API until ready, then asks.",
  spec,
  latestVersionNo: 4,
  createdAt: null,
  updatedAt: null,
};

const runRow = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: "r1",
  workflowId: "wf1",
  workflowName: "Poll and approve",
  versionNo: 4,
  triggerKind: "manual",
  status: "waiting",
  error: null,
  eventCount: 12,
  startedAt: "2026-11-04T10:00:00Z",
  finishedAt: null,
  createdAt: "2026-11-04T10:00:00Z",
  updatedAt: "2026-11-04T10:00:00Z",
  ...over,
});

const emptyView: WorkflowRunView = {
  executions: [],
  byNode: {},
  lastSeq: 0,
  output: null,
  runError: null,
};

const runsState = (runs: WorkflowRun[]) => ({
  runs,
  hasMore: false,
  loadMore: vi.fn(),
  isLoading: false,
  refresh: vi.fn(),
  startRun: vi.fn(async () => "r-new"),
});

const runState = (run: WorkflowRun | null, runView: WorkflowRunView) => ({
  run,
  inputs: {},
  view: runView,
  isLive: false,
  error: null,
  resume: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
});

const renderPage = (runId: string | null = null, onSelectRun = vi.fn()) =>
  render(
    <SidebarProvider>
      <WorkflowViewPage workflowId="wf1" runId={runId} onSelectRun={onSelectRun} />
    </SidebarProvider>,
  );

describe("workflow view page", () => {
  beforeEach(() => {
    hooks.useWorkflow.mockReturnValue({ workflow, catalog, isLoading: false, error: null });
  });

  it("explains the empty state and opens the Run dialog from it", async () => {
    hooks.useWorkflowRuns.mockReturnValue(runsState([]));
    hooks.useWorkflowRun.mockReturnValue(runState(null, emptyView));
    renderPage();
    expect(screen.getByRole("heading", { name: "Poll and approve" })).toBeInTheDocument();
    expect(screen.getByText("v4")).toBeInTheDocument();
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(hooks.useWorkflowRun).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: /Run it now/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Run Poll and approve");
  });

  it("shows the latest run by default, follows its newest execution and cancels while live", async () => {
    const live = runRow({ id: "r2" });
    hooks.useWorkflowRuns.mockReturnValue(
      runsState([live, runRow({ id: "r1", status: "succeeded" })]),
    );
    const state = runState(live, view);
    hooks.useWorkflowRun.mockReturnValue(state);
    renderPage(null);
    expect(hooks.useWorkflowRun).toHaveBeenLastCalledWith("r2");
    // Following: the newest execution (the waiting approval) is the one shown.
    expect(screen.getByRole("region", { name: "Approval required" })).toBeInTheDocument();
    expect(await screen.findByTestId("workflow-node-count-poll")).toHaveTextContent("×3");

    // A pick stops following; the details show the picked execution.
    fireEvent.click(screen.getByRole("option", { name: /poll#2/ }));
    expect(screen.getByRole("region", { name: "Execution poll#2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(state.cancel).toHaveBeenCalled());
  });

  it("gives the graph the larger share, resizable from the handle and remembered", () => {
    window.localStorage.clear();
    hooks.useWorkflowRuns.mockReturnValue(runsState([]));
    hooks.useWorkflowRun.mockReturnValue(runState(null, emptyView));
    const first = renderPage();
    const pane = screen.getByTestId("workflow-graph-pane");
    const handle = screen.getByRole("separator", { name: "Resize the graph" });
    expect(handle).toHaveAttribute("aria-valuenow", "58");
    expect(pane.style.height).toBe("58.0%");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle).toHaveAttribute("aria-valuenow", "62");
    expect(pane.style.height).toBe("62.0%");
    // Clamped: neither side vanishes.
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "80");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "25");
    fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
    first.unmount();
    renderPage();
    expect(screen.getByRole("separator", { name: "Resize the graph" })).toHaveAttribute("aria-valuenow", "37");
    window.localStorage.clear();
  });

  it("shows the run-level error banner for a failed run", () => {
    const failed = runRow({ id: "r3", status: "failed", finishedAt: "2026-11-04T10:01:00Z" });
    hooks.useWorkflowRuns.mockReturnValue(runsState([failed]));
    hooks.useWorkflowRun.mockReturnValue(
      runState(failed, {
        ...emptyView,
        runError: { message: "The agents service went away.", code: "upstream" },
      }),
    );
    renderPage("r3");
    expect(screen.getByText("The agents service went away.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

  it("offers the final output of a succeeded run", () => {
    const done = runRow({ id: "r4", status: "succeeded", finishedAt: "2026-11-04T10:01:00Z" });
    hooks.useWorkflowRuns.mockReturnValue(runsState([done]));
    hooks.useWorkflowRun.mockReturnValue(
      runState(done, { ...emptyView, output: { report: "ok" } }),
    );
    renderPage("r4");
    fireEvent.click(screen.getByRole("button", { name: /Final output/ }));
    expect(screen.getByRole("region", { name: "Final output" })).toHaveTextContent("report");
  });

  it("shows the load error when the workflow cannot be opened", () => {
    hooks.useWorkflow.mockReturnValue({
      workflow: null,
      catalog: [],
      isLoading: false,
      error: "Not found.",
    });
    hooks.useWorkflowRuns.mockReturnValue(runsState([]));
    hooks.useWorkflowRun.mockReturnValue(runState(null, emptyView));
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Not found.");
  });
});
