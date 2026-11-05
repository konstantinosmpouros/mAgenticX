import type {
  WorkflowConnectCheck,
  WorkflowEdgeDef,
  WorkflowNodeKindInfo,
  WorkflowSpec,
} from "@/shared/lib/types";
import { nodeBranches } from "@/features/workflows/lib/nodeCard";

/**
 * The graph rules the builder needs at once — which branches a node has,
 * whether an edge may be drawn, which nodes come before another — mirroring
 * the engine's validator (`validator.py`: `_graph_issues`, `_find_cycle`) so
 * the canvas refuses a bad edge the moment it is dropped. The server stays
 * the authority on save.
 */

export const LOOP_KIND = "loop";
export const END_KIND = "end";
export const ROUTER_KIND = "router";
/** The branch of a loop that may lead back into the loop's body (the back-edge). */
export const LOOP_CONTINUE = "continue";

export const kindInfoOf = (
  catalog: readonly WorkflowNodeKindInfo[],
  kind: string,
): WorkflowNodeKindInfo | null => catalog.find((entry) => entry.kind === kind) ?? null;

export const isTriggerKind = (catalog: readonly WorkflowNodeKindInfo[], kind: string): boolean =>
  kindInfoOf(catalog, kind)?.isTrigger ?? kind.startsWith("trigger.");

/** Edges as `source → [(target, branch)]`. */
export function adjacencyOf(edges: readonly WorkflowEdgeDef[]): Map<string, Array<{ target: string; branch: string | null }>> {
  const adjacency = new Map<string, Array<{ target: string; branch: string | null }>>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push({ target: edge.target, branch: edge.branch ?? null });
    adjacency.set(edge.source, list);
  }
  return adjacency;
}

/**
 * A cycle left once every loop's `continue` edge is removed, as the node ids
 * along it (first repeated at the end), or null. Same walk as the engine's.
 */
export function findCycle(spec: Pick<WorkflowSpec, "nodes" | "edges">): string[] | null {
  const kinds = new Map(spec.nodes.map((node) => [node.id, node.kind]));
  const adjacency = adjacencyOf(spec.edges);
  const next = (id: string) =>
    (adjacency.get(id) ?? [])
      .filter((edge) => !(kinds.get(id) === LOOP_KIND && edge.branch === LOOP_CONTINUE))
      .map((edge) => edge.target);
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const target of next(id)) {
      if (state.get(target) === 1) return [...path.slice(path.indexOf(target)), target];
      if (!state.has(target)) {
        const found = visit(target);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of [...kinds.keys()].sort()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Every node reachable from `start` along the edges (itself included). */
export function reachableFrom(start: string, edges: readonly WorkflowEdgeDef[]): Set<string> {
  const adjacency = adjacencyOf(edges);
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const { target } of adjacency.get(stack.pop() as string) ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return seen;
}

/** The nodes with a path into `nodeId` — what its templates may read as `nodes.<id>.output`. */
export function upstreamOf(nodeId: string, edges: readonly WorkflowEdgeDef[]): Set<string> {
  const reverse = edges.map((edge) => ({ ...edge, source: edge.target, target: edge.source }));
  const seen = reachableFrom(nodeId, reverse);
  seen.delete(nodeId);
  return seen;
}

/**
 * Whether an edge from `source` (on `branch`) to `target` may be added — the
 * instant check behind dropping a connection on the canvas. Refused: a self
 * edge, an unknown end, anything into the trigger or out of an `end`, a
 * missing or unknown branch, a second edge on the same (source, branch), the
 * same edge twice, and a cycle that does not pass through a loop's `continue`.
 */
export function canConnect(
  spec: Pick<WorkflowSpec, "nodes" | "edges">,
  catalog: readonly WorkflowNodeKindInfo[],
  connection: { source: string; target: string; branch: string | null },
): WorkflowConnectCheck {
  const { source, target } = connection;
  const branch = connection.branch || null;
  const from = spec.nodes.find((node) => node.id === source);
  const to = spec.nodes.find((node) => node.id === target);
  if (!from || !to) return { ok: false, reason: "Connect two steps on the canvas." };
  if (source === target) return { ok: false, reason: "A step can't lead to itself." };
  if (isTriggerKind(catalog, to.kind)) return { ok: false, reason: "Nothing may lead into the trigger." };
  if (from.kind === END_KIND) return { ok: false, reason: "An end step has no way out." };
  const branches = nodeBranches(from, kindInfoOf(catalog, from.kind));
  if (branches.length && !branch) {
    return { ok: false, reason: `Drag from one of its branches: ${branches.join(", ")}.` };
  }
  if (!branches.length && branch) return { ok: false, reason: "This step does not branch." };
  if (branch && !branches.includes(branch)) return { ok: false, reason: `Unknown branch '${branch}'.` };
  const existing = spec.edges.find(
    (edge) => edge.source === source && (edge.branch ?? null) === branch,
  );
  if (existing) {
    if (existing.target === target) return { ok: false, reason: "These steps are already connected." };
    return {
      ok: false,
      reason: branch
        ? `'${branch}' already leads somewhere: a workflow runs one path at a time.`
        : "This step already leads somewhere: a workflow runs one path at a time.",
    };
  }
  const cycle = findCycle({
    nodes: spec.nodes,
    edges: [...spec.edges, { id: "__probe__", source, target, branch }],
  });
  // A graph that already has a bad cycle (an import) is the validator's to
  // report; only a cycle this edge would create is refused here.
  if (cycle && !findCycle(spec)) {
    return { ok: false, reason: "That makes a cycle. Loops go back through a Loop step's 'continue'." };
  }
  return { ok: true };
}
