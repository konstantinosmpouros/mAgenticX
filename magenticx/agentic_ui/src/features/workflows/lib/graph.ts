import type { Edge, Node } from "@xyflow/react";

import type {
  WorkflowEdgeData,
  WorkflowExecution,
  WorkflowNodeCardData,
  WorkflowNodeKindInfo,
  WorkflowRunView,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";
import { workflowScheduleSubtitle } from "@/shared/lib/workflowSchedule";
import { SCHEDULE_TRIGGER_KIND, scheduleNodeSubtitle } from "./builder/schedule";
import { kindView, nodeLabel } from "./kinds";
import {
  backEdgeFloor,
  cardHandleTop,
  findBackEdges,
  layoutIsClean,
  layoutWorkflow,
  type LayoutBox,
  type LayoutPoint,
} from "./layout";
import {
  NODE_CARD,
  WORKFLOW_EDGE_TYPE,
  WORKFLOW_NODE_TYPE,
  nodeBranches,
  nodeCardHeight,
  sourceHandleId,
} from "./nodeCard";

/**
 * The workflow view's graph, as React Flow nodes and edges: the spec's nodes
 * where the spec placed them — drawn by the shared `WorkflowNodeCard`, one
 * source handle per branch — its edges (the shared `WorkflowEdge`) leaving
 * from their branch's handle, and the run's overlay on top: each node's last
 * status and how many times it ran, the branch each node last took lit, the
 * branches it did not take muted, a flowing edge into a running node. Pure, so
 * the overlay is unit-tested without React Flow (types only are imported from
 * it, which keeps the library itself in the graph's lazy chunk).
 */

/** The card's width and its height with no branches (the spec's positions are top-left corners). */
export const WORKFLOW_NODE_SIZE = {
  width: NODE_CARD.width,
  height: NODE_CARD.headerHeight,
} as const;

export type WorkflowFlowNode = Node<WorkflowNodeCardData, typeof WORKFLOW_NODE_TYPE>;
export type WorkflowFlowEdge = Edge<WorkflowEdgeData, typeof WORKFLOW_EDGE_TYPE>;

export type WorkflowFlow = { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] };

/** A node's executions in this run (empty before it runs, or with no run). */
export const nodeExecutions = (view: WorkflowRunView | null, nodeId: string): WorkflowExecution[] =>
  view?.byNode[nodeId] ?? [];

/** The latest execution of a node — what clicking the node selects. */
export const latestExecution = (
  view: WorkflowRunView | null,
  nodeId: string,
): WorkflowExecution | null => {
  const executions = nodeExecutions(view, nodeId);
  return executions.length ? executions[executions.length - 1] : null;
};

/**
 * Whether the edge is the way its source last went. A branching edge is taken
 * when the source's last finished execution took its branch; a plain edge when
 * the source finished and its target has run since.
 */
function edgeTaken(view: WorkflowRunView | null, edge: WorkflowSpec["edges"][number]): boolean {
  const finished = nodeExecutions(view, edge.source).filter(
    (execution) => execution.status !== "running" && execution.status !== "waiting",
  );
  const last = finished[finished.length - 1];
  if (!last || last.status === "failed" || last.status === "cancelled") return false;
  if (edge.branch) return last.branch === edge.branch;
  if (last.branch) return false;
  return nodeExecutions(view, edge.target).length > 0;
}

/** A node's last finished execution (not running, not waiting), if any. */
function lastFinished(view: WorkflowRunView | null, nodeId: string): WorkflowExecution | undefined {
  const finished = nodeExecutions(view, nodeId).filter(
    (execution) => execution.status !== "running" && execution.status !== "waiting",
  );
  return finished[finished.length - 1];
}

/**
 * Where the cards go: the spec's own positions when they read cleanly left to
 * right (no overlaps, no curve through a card), else the auto-layout. `spec`
 * and `auto` force one or the other.
 */
export type WorkflowLayoutMode = "smart" | "spec" | "auto";

export function buildWorkflowFlow({
  spec,
  view,
  catalog,
  selectedNodeId,
  animate,
  layout = "smart",
  schedule = null,
  now = new Date(),
}: {
  spec: WorkflowSpec;
  view: WorkflowRunView | null;
  catalog: WorkflowNodeKindInfo[];
  selectedNodeId: string | null;
  /** Off when the user prefers reduced motion: no flowing dashes. */
  animate: boolean;
  layout?: WorkflowLayoutMode;
  /** The workflow's live schedule: the schedule trigger's subtitle reads from it. */
  schedule?: WorkflowSchedule | null;
  now?: Date;
}): WorkflowFlow {
  // A run that has started touching nodes fades the ones it has not reached.
  const runTouched = Boolean(view && view.executions.length > 0);

  const kindInfoOf = new Map(
    spec.nodes.map((node) => [node.id, catalog.find((entry) => entry.kind === node.kind) ?? null]),
  );
  const branchesOf = new Map(
    spec.nodes.map((node) => [node.id, nodeBranches(node, kindInfoOf.get(node.id)!, spec.edges)]),
  );
  const isTrigger = (id: string) => {
    const node = spec.nodes.find((entry) => entry.id === id);
    return kindInfoOf.get(id)?.isTrigger ?? Boolean(node?.kind.startsWith("trigger."));
  };
  const heightOf = (id: string) => nodeCardHeight(branchesOf.get(id)?.length ?? 0);
  const handleTop = (id: string, branch: string | null | undefined) =>
    cardHandleTop(branchesOf.get(id) ?? [], branch);

  const boxesAt = (positions: Record<string, LayoutPoint>): Record<string, LayoutBox> =>
    Object.fromEntries(
      spec.nodes.map((node) => [
        node.id,
        { ...positions[node.id], width: NODE_CARD.width, height: heightOf(node.id) },
      ]),
    );
  const specPositions = Object.fromEntries(
    spec.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]),
  );
  const backEdges = findBackEdges(spec.nodes, spec.edges, isTrigger);
  let boxes = boxesAt(specPositions);
  const useSpec =
    layout === "spec" ||
    (layout === "smart" && layoutIsClean(boxes, spec.edges, backEdges, handleTop));
  if (!useSpec) {
    boxes = boxesAt(
      layoutWorkflow(spec.nodes, spec.edges, { heightOf, handleTop, isTrigger }).positions,
    );
  }

  const nodes: WorkflowFlowNode[] = spec.nodes.map((node) => {
    const executions = nodeExecutions(view, node.id);
    const last = executions[executions.length - 1];
    const kindInfo = kindInfoOf.get(node.id) ?? null;
    const kind = kindView(catalog, node.kind);
    const label = nodeLabel(node);
    const status = last?.status ?? null;
    const branches = branchesOf.get(node.id) ?? [];
    const finished = lastFinished(view, node.id);
    // The schedule trigger says when it runs: from the live schedule when the
    // workflow has one, else (switched off, not synced yet) from its config.
    const subtitle =
      node.kind === SCHEDULE_TRIGGER_KIND
        ? schedule
          ? workflowScheduleSubtitle(schedule, now)
          : scheduleNodeSubtitle(node.config, now)
        : null;
    return {
      id: node.id,
      type: WORKFLOW_NODE_TYPE,
      position: { x: boxes[node.id].x, y: boxes[node.id].y },
      width: NODE_CARD.width,
      height: boxes[node.id].height,
      ariaLabel: [
        label,
        kind.label,
        status ? `last ${status}` : "not run",
        executions.length > 1 ? `ran ${executions.length} times` : null,
      ]
        .filter(Boolean)
        .join(", "),
      data: {
        nodeId: node.id,
        kind: node.kind,
        label,
        kindInfo,
        mode: "view",
        branches,
        isTrigger: isTrigger(node.id),
        status,
        executionCount: executions.length,
        selected: node.id === selectedNodeId,
        dimmed: runTouched && executions.length === 0,
        takenBranch: finished?.branch ?? null,
        ...(subtitle ? { subtitle: subtitle.text, subtitlePaused: subtitle.paused } : {}),
      },
    };
  });

  const known = new Set(spec.nodes.map((node) => node.id));
  const edges: WorkflowFlowEdge[] = spec.edges
    .filter((edge) => known.has(edge.source) && known.has(edge.target))
    .map((edge) => {
      const taken = edgeTaken(view, edge);
      const targetLast = latestExecution(view, edge.target);
      const running = taken && targetLast?.status === "running";
      const failed = taken && targetLast?.status === "failed";
      // A branch its source finished without taking (it went another way).
      const sourceDone = lastFinished(view, edge.source);
      const untaken =
        !taken && Boolean(edge.branch) && sourceDone?.status === "succeeded" && !!sourceDone.branch;
      const back = backEdges.has(edge.id);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: sourceHandleId(edge.branch),
        type: WORKFLOW_EDGE_TYPE,
        animated: animate && running,
        className: [
          "workflow-flow-edge",
          taken ? "is-taken" : null,
          running ? "is-running" : null,
          failed ? "is-failed" : null,
          untaken ? "is-untaken" : null,
          back ? "is-back" : null,
        ]
          .filter(Boolean)
          .join(" "),
        data: {
          mode: "view",
          branch: edge.branch ?? null,
          taken,
          running,
          failed,
          untaken,
          back,
          floorY: back ? backEdgeFloor(boxes, edge.source, edge.target) : undefined,
        },
      };
    });

  return { nodes, edges };
}
