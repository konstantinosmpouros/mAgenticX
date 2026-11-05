import type {
  WorkflowBuilderSelection,
  WorkflowEdgeDef,
  WorkflowNodeKindInfo,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";
import type { WorkflowFlowEdge, WorkflowFlowNode } from "@/features/workflows/lib/graph";
import { nodeLabel } from "@/features/workflows/lib/kinds";
import {
  backEdgeFloor,
  cardHandleTop,
  findBackEdges,
  LAYOUT_GAP,
  layoutWorkflow,
  type LayoutBox,
  type LayoutPoint,
} from "@/features/workflows/lib/layout";
import {
  NODE_CARD,
  WORKFLOW_EDGE_TYPE,
  WORKFLOW_NODE_TYPE,
  nodeBranches,
  nodeCardHeight,
  sourceHandleId,
} from "@/features/workflows/lib/nodeCard";
import { isTriggerKind, kindInfoOf } from "./graph";
import { snap } from "./draft";
import { SCHEDULE_TRIGGER_KIND, scheduleNodeSubtitle } from "./schedule";

/**
 * The builder's spec ↔ React Flow. `specToFlow` draws the draft with the
 * shared card and edge in edit mode — at the spec's own positions (the
 * builder never re-lays the graph by itself), each edge from its branch's
 * handle, loop-closing edges as arcs under the cards, the selection and each
 * node's issue count on top. `flowToSpec` reads positions and edges back,
 * the branch from an edge's source handle. `layoutSpec` is the "Tidy up"
 * button: the view's auto-layout (lib/layout), snapped to the grid.
 */

export type BuilderFlowOptions = {
  catalog: readonly WorkflowNodeKindInfo[];
  issueCounts?: ReadonlyMap<string, number>;
  errorNodes?: ReadonlySet<string>;
  selection?: WorkflowBuilderSelection;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (edgeId: string) => void;
  /** The saved workflow's live schedule: the trigger's subtitle shows its next run while the config matches it. */
  savedSchedule?: WorkflowSchedule | null;
  now?: Date;
};

const branchesFor = (spec: WorkflowSpec, catalog: readonly WorkflowNodeKindInfo[]) =>
  new Map(
    spec.nodes.map((node) => [node.id, nodeBranches(node, kindInfoOf(catalog, node.kind), spec.edges)]),
  );

export function specToFlow(
  spec: WorkflowSpec,
  {
    catalog,
    issueCounts = new Map(),
    errorNodes = new Set(),
    selection = { nodes: [], edges: [] },
    onDeleteNode,
    onDeleteEdge,
    savedSchedule = null,
    now = new Date(),
  }: BuilderFlowOptions,
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const branchesOf = branchesFor(spec, catalog);
  const isTrigger = (id: string) => {
    const node = spec.nodes.find((entry) => entry.id === id);
    return node ? isTriggerKind(catalog, node.kind) : false;
  };
  const boxes: Record<string, LayoutBox> = Object.fromEntries(
    spec.nodes.map((node) => [
      node.id,
      {
        x: node.position.x,
        y: node.position.y,
        width: NODE_CARD.width,
        height: nodeCardHeight(branchesOf.get(node.id)?.length ?? 0),
      },
    ]),
  );
  const pickedNodes = new Set(selection.nodes);
  const pickedEdges = new Set(selection.edges);

  const nodes: WorkflowFlowNode[] = spec.nodes.map((node) => {
    const kindInfo = kindInfoOf(catalog, node.kind);
    const issueCount = issueCounts.get(node.id) ?? 0;
    const label = nodeLabel(node);
    const subtitle =
      node.kind === SCHEDULE_TRIGGER_KIND ? scheduleNodeSubtitle(node.config, now, savedSchedule) : null;
    return {
      id: node.id,
      type: WORKFLOW_NODE_TYPE,
      position: { x: node.position.x, y: node.position.y },
      width: NODE_CARD.width,
      height: boxes[node.id].height,
      selected: pickedNodes.has(node.id),
      // Every step, the trigger too, is deleted on the canvas (its card's
      // delete, Backspace / Delete); "exactly one trigger" is the checks' rule.
      deletable: true,
      ariaLabel: [label, kindInfo?.label ?? node.kind, issueCount ? `${issueCount} issues` : null]
        .filter(Boolean)
        .join(", "),
      data: {
        nodeId: node.id,
        kind: node.kind,
        label: node.label?.trim() ?? "",
        kindInfo,
        mode: "edit",
        branches: branchesOf.get(node.id) ?? [],
        isTrigger: isTrigger(node.id),
        issueCount,
        hasErrors: errorNodes.has(node.id),
        selected: pickedNodes.has(node.id),
        ...(subtitle ? { subtitle: subtitle.text, subtitlePaused: subtitle.paused } : {}),
        ...(onDeleteNode ? { onDelete: onDeleteNode } : {}),
      },
    };
  });

  const known = new Set(spec.nodes.map((node) => node.id));
  const valid = spec.edges.filter((edge) => known.has(edge.source) && known.has(edge.target));
  const back = findBackEdges(spec.nodes, valid, isTrigger);
  const edges: WorkflowFlowEdge[] = valid.map((edge) => {
    const isBack = back.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: sourceHandleId(edge.branch) ?? null,
      type: WORKFLOW_EDGE_TYPE,
      selected: pickedEdges.has(edge.id),
      className: ["workflow-flow-edge", isBack ? "is-back" : null].filter(Boolean).join(" "),
      data: {
        mode: "edit",
        branch: edge.branch ?? null,
        back: isBack,
        ...(isBack ? { floorY: backEdgeFloor(boxes, edge.source, edge.target) } : {}),
        ...(onDeleteEdge ? { onDelete: onDeleteEdge } : {}),
      },
    };
  });
  return { nodes, edges };
}

/** Equal as far as a card or an edge can tell: same keys, values `===` (arrays and plain objects one level down). */
function sameShallow(a: unknown, b: unknown, depth = 2): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || !a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameShallow(left[key], right[key], depth - 1));
}

/**
 * The new flow, keeping every node and edge object that did not change from
 * `previous` (and `previous`'s arrays themselves when nothing changed). A
 * keystroke in the inspector rebuilds the whole flow from the draft; without
 * this every card got a new object, so React Flow re-adopted every node and
 * re-rendered every card for a change to one. Now only the edited step's card
 * (and the edges that really changed) are new.
 */
export function reuseUnchangedFlow(
  previous: { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } | null,
  next: { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] },
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  if (!previous) return next;
  const keep = <T extends { id: string }>(before: readonly T[], after: T[]): T[] => {
    const byId = new Map(before.map((item) => [item.id, item]));
    let changed = before.length !== after.length;
    const merged = after.map((item, index) => {
      const old = byId.get(item.id);
      if (old && sameShallow(old, item, 3)) {
        if (before[index] !== old) changed = true;
        return old;
      }
      changed = true;
      return item;
    });
    return changed ? merged : (before as T[]);
  };
  const nodes = keep(previous.nodes, next.nodes);
  const edges = keep(previous.edges, next.edges);
  return nodes === previous.nodes && edges === previous.edges ? previous : { nodes, edges };
}

/** The spec with the flow's positions and edges (branch = the edge's source handle). */
export function flowToSpec(
  spec: WorkflowSpec,
  nodes: ReadonlyArray<Pick<WorkflowFlowNode, "id" | "position">>,
  edges: ReadonlyArray<Pick<WorkflowFlowEdge, "id" | "source" | "target" | "sourceHandle">>,
): WorkflowSpec {
  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  return {
    ...spec,
    nodes: spec.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, position: { x: position.x, y: position.y } } : node;
    }),
    edges: edges.map(
      (edge): WorkflowEdgeDef => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        branch: edge.sourceHandle || null,
      }),
    ),
  };
}

/** "Tidy up": every node's new position, laid out left to right on the snap grid. */
export function layoutSpec(
  spec: WorkflowSpec,
  catalog: readonly WorkflowNodeKindInfo[],
): Record<string, LayoutPoint> {
  const branchesOf = branchesFor(spec, catalog);
  const { positions } = layoutWorkflow(spec.nodes, spec.edges, {
    heightOf: (id) => nodeCardHeight(branchesOf.get(id)?.length ?? 0),
    handleTop: (id, branch) => cardHandleTop(branchesOf.get(id) ?? [], branch),
    isTrigger: (id) => {
      const node = spec.nodes.find((entry) => entry.id === id);
      return node ? isTriggerKind(catalog, node.kind) : false;
    },
  });
  return Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, snap(point)]));
}

/**
 * Where a node added by click goes: right of the selected node (or of the
 * right-most one), so it lands next to what the user is working on.
 */
export function nextNodePosition(spec: WorkflowSpec, afterId: string | null): LayoutPoint {
  const anchor =
    spec.nodes.find((node) => node.id === afterId) ??
    [...spec.nodes].sort((a, b) => b.position.x - a.position.x)[0];
  if (!anchor) return { x: 0, y: 0 };
  const x = anchor.position.x + NODE_CARD.width + LAYOUT_GAP.x;
  let y = anchor.position.y;
  // Step down past anything already standing there.
  while (
    spec.nodes.some(
      (node) => Math.abs(node.position.x - x) < NODE_CARD.width && Math.abs(node.position.y - y) < NODE_CARD.headerHeight + 16,
    )
  ) {
    y += NODE_CARD.headerHeight + LAYOUT_GAP.y;
  }
  return snap({ x, y });
}
