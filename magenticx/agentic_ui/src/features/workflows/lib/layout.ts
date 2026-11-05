import type { WorkflowEdgeDef, WorkflowNodeDef } from "@/shared/lib/types";
import { HEADER_HANDLE_TOP, NODE_CARD, branchHandleTop } from "./nodeCard";

/**
 * Left-to-right layout for a workflow graph — the run view's display layout
 * when the spec's own positions would read badly, and the builder's
 * "auto-layout" button. A small layered (Sugiyama-style) layout, with no
 * dependency:
 *
 * 1. **Back-edges** — the edges that close a loop (found by a depth-first walk
 *    from the trigger) are left out of the ranking, so the rest is a DAG. The
 *    canvas draws them as an arc under the cards (`backEdgeFloor`).
 * 2. **Ranks** — longest path from the roots: every forward edge goes at least
 *    one column right.
 * 3. **Order** — within a column, barycentre sweeps (left → right, then back)
 *    over the y of the handles the edges actually leave from, so a condition's
 *    `true` target sits above its `false` one and lines do not cross.
 * 4. **y** — each card is aimed so its target handle is level with its inputs'
 *    handles (straight lines where possible), then pushed apart to keep a gap.
 *
 * Pure: positions are the cards' top-left corners, as the spec stores them.
 */

export type LayoutPoint = { x: number; y: number };
export type LayoutBox = LayoutPoint & { width: number; height: number };

export type WorkflowLayout = {
  positions: Record<string, LayoutPoint>;
  /** Ids of the edges that close a loop (drawn as an arc under the cards). */
  backEdges: Set<string>;
};

type LayoutNode = Pick<WorkflowNodeDef, "id"> & { position?: LayoutPoint };
type LayoutEdge = Pick<WorkflowEdgeDef, "id" | "source" | "target" | "branch">;

/**
 * Spacing between columns and between cards in one column (px): wide enough
 * that a curve leaving a branch row has room to bend before the next column,
 * and that stacked cards read as separate steps. A column pitch of
 * `NODE_CARD.width + x` (400) stays on the builder's 16px snap grid.
 */
export const LAYOUT_GAP = { x: 160, y: 64 } as const;

/**
 * The least room a set of positions must leave to count as clean (the run
 * view keeps the spec's own positions only then): this far between a forward
 * edge's two handles, and this far between any two cards.
 */
export const CLEAN_MIN_GAP = { x: 120, y: 48 } as const;

/** Barycentre sweeps; a handful settles any graph the builder can make. */
const SWEEPS = 4;

/**
 * The edges that close a cycle: a depth-first walk from the roots (triggers
 * first, then any node nothing leads into, then the rest), an edge into a node
 * still on the walk's stack is a back-edge.
 */
export function findBackEdges(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  isTrigger: (id: string) => boolean = () => false,
): Set<string> {
  const out = new Map<string, LayoutEdge[]>();
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    (out.get(edge.source) ?? out.set(edge.source, []).get(edge.source)!).push(edge);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const roots = [
    ...nodes.filter((node) => isTrigger(node.id)),
    ...nodes.filter((node) => !isTrigger(node.id) && indegree.get(node.id) === 0),
    ...nodes,
  ];
  const state = new Map<string, "open" | "done">();
  const back = new Set<string>();
  // Iterative DFS (a long chain must not blow the call stack).
  for (const root of roots) {
    if (state.has(root.id)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    state.set(root.id, "open");
    while (stack.length) {
      const top = stack[stack.length - 1];
      const children = out.get(top.id) ?? [];
      if (top.next >= children.length) {
        state.set(top.id, "done");
        stack.pop();
        continue;
      }
      const edge = children[top.next++];
      const seen = state.get(edge.target);
      if (seen === "open") back.add(edge.id);
      else if (!seen) {
        state.set(edge.target, "open");
        stack.push({ id: edge.target, next: 0 });
      }
    }
  }
  return back;
}

/**
 * Lay the graph out left to right. `heightOf` gives a card's height and
 * `handleTop` the y (from the card's top) of the source handle an edge leaves
 * by — the shared card's geometry unless the caller draws something else.
 */
export function layoutWorkflow(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  {
    heightOf,
    handleTop,
    isTrigger,
    width = NODE_CARD.width,
  }: {
    heightOf: (id: string) => number;
    /** Source handle y for an edge leaving `id` by `branch`. */
    handleTop: (id: string, branch: string | null | undefined) => number;
    isTrigger?: (id: string) => boolean;
    width?: number;
  },
): WorkflowLayout {
  const ids = new Set(nodes.map((node) => node.id));
  const valid = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const backEdges = findBackEdges(nodes, valid, isTrigger);
  const forward = valid.filter((edge) => !backEdges.has(edge.id) && edge.source !== edge.target);

  // 2. Ranks: longest path, in topological order (Kahn).
  const incoming = new Map<string, LayoutEdge[]>(nodes.map((node) => [node.id, []]));
  const outgoing = new Map<string, LayoutEdge[]>(nodes.map((node) => [node.id, []]));
  for (const edge of forward) {
    incoming.get(edge.target)!.push(edge);
    outgoing.get(edge.source)!.push(edge);
  }
  const pending = new Map(nodes.map((node) => [node.id, incoming.get(node.id)!.length]));
  const queue = nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id);
  const rank = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const edge of outgoing.get(id)!) {
      rank.set(edge.target, Math.max(rank.get(edge.target)!, rank.get(id)! + 1));
      pending.set(edge.target, pending.get(edge.target)! - 1);
      if (pending.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  // Anything left (a cycle the walk missed) keeps rank 0 rather than vanishing.
  for (const node of nodes) if (!topo.includes(node.id)) topo.push(node.id);

  const columns: string[][] = [];
  for (const id of topo) (columns[rank.get(id)!] ??= []).push(id);
  for (let index = 0; index < columns.length; index += 1) columns[index] ??= [];

  // 3. Order within each column by barycentre of the neighbours' slot (the
  // handle's row counts, so `true` sorts above `false`).
  const slot = new Map<string, number>();
  const renumber = () =>
    columns.forEach((column) => column.forEach((id, index) => slot.set(id, index)));
  renumber();
  const branchIndex = (edge: LayoutEdge) => handleTop(edge.source, edge.branch) / 1000;
  const sortBy = (column: string[], key: (id: string) => number | null) => {
    const keyed = column.map((id, index) => ({ id, index, key: key(id) }));
    keyed.sort((a, b) => (a.key ?? a.index) - (b.key ?? b.index) || a.index - b.index);
    column.splice(0, column.length, ...keyed.map((entry) => entry.id));
  };
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const forwardSweep = () => {
    for (let index = 1; index < columns.length; index += 1) {
      sortBy(columns[index], (id) =>
        mean(incoming.get(id)!.map((edge) => slot.get(edge.source)! + branchIndex(edge))),
      );
      renumber();
    }
  };
  // Back from the right, by the targets' slots alone (ties keep the forward
  // order, which already holds the branch order).
  const backwardSweep = () => {
    for (let index = columns.length - 2; index >= 0; index -= 1) {
      sortBy(columns[index], (id) =>
        mean(outgoing.get(id)!.map((edge) => slot.get(edge.target)!)),
      );
      renumber();
    }
  };
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    forwardSweep();
    backwardSweep();
  }
  // End going forward, so each column follows the branch order of the one before.
  forwardSweep();

  // 4. y: aim each card's target handle at its inputs' handles, then keep the gap.
  const y = new Map<string, number>();
  columns.forEach((column) => {
    let floor = -Infinity;
    for (const id of column) {
      const wanted = mean(
        incoming
          .get(id)!
          .filter((edge) => y.has(edge.source))
          .map((edge) => y.get(edge.source)! + handleTop(edge.source, edge.branch) - HEADER_HANDLE_TOP),
      );
      const top = Math.max(wanted ?? (floor === -Infinity ? 0 : floor), floor);
      y.set(id, top);
      floor = top + heightOf(id) + LAYOUT_GAP.y;
    }
  });
  const minY = Math.min(0, ...Array.from(y.values()));

  const positions: Record<string, LayoutPoint> = {};
  for (const node of nodes) {
    positions[node.id] = {
      x: rank.get(node.id)! * (width + LAYOUT_GAP.x),
      y: y.get(node.id)! - minY,
    };
  }
  return { positions, backEdges };
}

const overlaps = (a: LayoutBox, b: LayoutBox, margin: number) =>
  a.x < b.x + b.width + margin &&
  b.x < a.x + a.width + margin &&
  a.y < b.y + b.height + margin &&
  b.y < a.y + a.height + margin;

/** Points along a left → right bezier between two handles (as the canvas draws it). */
export function bezierPoints(from: LayoutPoint, to: LayoutPoint, steps = 24): LayoutPoint[] {
  const pull = Math.max(Math.abs(to.x - from.x) / 2, 40);
  const c1 = { x: from.x + pull, y: from.y };
  const c2 = { x: to.x - pull, y: to.y };
  const points: LayoutPoint[] = [];
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    });
  }
  return points;
}

const inside = (point: LayoutPoint, box: LayoutBox) =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

/**
 * Whether a set of positions reads cleanly left to right: no two cards
 * overlap (or sit closer than `CLEAN_MIN_GAP`), every forward edge goes right
 * with room for its curve, and no forward edge's curve passes through a card
 * it does not join. The run view keeps the spec's own positions when they
 * pass, and lays the graph out itself otherwise.
 */
export function layoutIsClean(
  boxes: Record<string, LayoutBox>,
  edges: ReadonlyArray<LayoutEdge>,
  backEdges: ReadonlySet<string>,
  handleTop: (id: string, branch: string | null | undefined) => number,
): boolean {
  const list = Object.entries(boxes);
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (overlaps(list[i][1], list[j][1], CLEAN_MIN_GAP.y)) return false;
    }
  }
  for (const edge of edges) {
    if (backEdges.has(edge.id)) continue;
    const source = boxes[edge.source];
    const target = boxes[edge.target];
    if (!source || !target) continue;
    const from = { x: source.x + source.width, y: source.y + handleTop(edge.source, edge.branch) };
    const to = { x: target.x, y: target.y + HEADER_HANDLE_TOP };
    if (to.x - from.x < CLEAN_MIN_GAP.x) return false;
    for (const point of bezierPoints(from, to)) {
      for (const [id, box] of list) {
        if (id !== edge.source && id !== edge.target && inside(point, box)) return false;
      }
    }
  }
  return true;
}

/**
 * How far below the cards a back-edge's arc runs: under every card whose
 * column lies between its two ends (plus its own two cards), with room to spare.
 */
export function backEdgeFloor(
  boxes: Record<string, LayoutBox>,
  sourceId: string,
  targetId: string,
  clearance = 36,
): number {
  const source = boxes[sourceId];
  const target = boxes[targetId];
  if (!source || !target) return 0;
  const left = Math.min(source.x, target.x) - 60;
  const right = Math.max(source.x + source.width, target.x + target.width) + 60;
  let bottom = Math.max(source.y + source.height, target.y + target.height);
  for (const box of Object.values(boxes)) {
    if (box.x < right && box.x + box.width > left) bottom = Math.max(bottom, box.y + box.height);
  }
  return bottom + clearance;
}

/** The shared card's source-handle y for an edge leaving by `branch` (header middle when plain). */
export const cardHandleTop = (branches: ReadonlyArray<string>, branch: string | null | undefined) => {
  const index = branch ? branches.indexOf(branch) : -1;
  return index >= 0 ? branchHandleTop(index) : HEADER_HANDLE_TOP;
};

/** How far a back-edge's arc swings out past its two handles before turning (px). */
export const BACK_EDGE_SWING = 56;

/**
 * A back-edge's path: out of the source's right handle, round and down under
 * the cards to `floorY`, left along it, then up and into the target's left
 * handle — a racetrack arc that never crosses a card. Returns the path and the
 * middle of its floor run (for an edit-mode delete button).
 */
export function backEdgePath(
  source: LayoutPoint,
  target: LayoutPoint,
  floorY: number,
): { path: string; mid: LayoutPoint } {
  const floor = Math.max(floorY, source.y + 24, target.y + 24);
  const swing = BACK_EDGE_SWING;
  const path = [
    `M ${source.x},${source.y}`,
    `C ${source.x + swing},${source.y} ${source.x + swing},${floor} ${source.x},${floor}`,
    `L ${target.x},${floor}`,
    `C ${target.x - swing},${floor} ${target.x - swing},${target.y} ${target.x},${target.y}`,
  ].join(" ");
  return { path, mid: { x: (source.x + target.x) / 2, y: floor } };
}

/** The small arrowhead at a target handle (edges always arrive heading right). */
export function arrowHeadPath(tip: LayoutPoint, length = 7, half = 3.5): string {
  return `M ${tip.x - length},${tip.y - half} L ${tip.x},${tip.y} L ${tip.x - length},${tip.y + half} Z`;
}
