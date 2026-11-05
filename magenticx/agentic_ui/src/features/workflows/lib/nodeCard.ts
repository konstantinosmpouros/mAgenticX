import type {
  WorkflowEdgeDef,
  WorkflowEdgeTone,
  WorkflowNodeDef,
  WorkflowNodeKindInfo,
} from "@/shared/lib/types";

/**
 * The shared workflow node card's geometry and wiring — the pure half of
 * `components/workflow_parts/WorkflowNodeCard.tsx` and `WorkflowEdge.tsx`, so
 * the run view's graph and the builder's canvas lay out, size and connect
 * nodes the same way (and it is unit-tested without React Flow).
 *
 * A card is a header (icon tile, kind, label, status) and, for a node that
 * branches, one row per branch under it; each row carries its source handle on
 * the card's right edge. Flow runs left → right: the target handle sits on the
 * left edge, level with the header.
 */

/** React Flow node / edge `type` names the card and the edge register under. */
export const WORKFLOW_NODE_TYPE = "workflowNode";
export const WORKFLOW_EDGE_TYPE = "workflowEdge";

/** Card geometry (px). The header alone is the whole card for a node with no branches. */
export const NODE_CARD = {
  width: 240,
  headerHeight: 64,
  branchRowHeight: 24,
  /** Space above and below the branch rows (with the divider line). */
  branchPadding: 6,
} as const;

/** The card's height for a node with `branchCount` branches. */
export const nodeCardHeight = (branchCount: number): number =>
  branchCount > 0
    ? NODE_CARD.headerHeight + NODE_CARD.branchPadding * 2 + branchCount * NODE_CARD.branchRowHeight
    : NODE_CARD.headerHeight;

/** Where branch `index`'s source handle sits, from the card's top (the row's middle). */
export const branchHandleTop = (index: number): number =>
  NODE_CARD.headerHeight +
  NODE_CARD.branchPadding +
  index * NODE_CARD.branchRowHeight +
  NODE_CARD.branchRowHeight / 2;

/** The target handle (and a plain source handle): level with the header's middle. */
export const HEADER_HANDLE_TOP = NODE_CARD.headerHeight / 2;

/**
 * A source handle's id: the branch name, or none for a node's one plain
 * handle. An edge sets `sourceHandle` to this, so it leaves from its row.
 */
export const sourceHandleId = (branch: string | null | undefined): string | undefined =>
  branch || undefined;

/** Router case names from its config (`cases[].name`), ignoring anything malformed. */
function configCaseNames(config: Record<string, unknown>): string[] {
  const cases = config.cases;
  if (!Array.isArray(cases)) return [];
  return cases
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

/**
 * The branches a node shows a handle for, in order: a dynamic-branch kind's
 * case names (a router's `cases`) first, then the catalogue's fixed branches,
 * then any branch an edge leaves it by that neither lists — so every edge in
 * the spec always has a handle to start from, even while the catalogue loads.
 */
export function nodeBranches(
  node: Pick<WorkflowNodeDef, "id" | "config">,
  kindInfo: WorkflowNodeKindInfo | null,
  edges: ReadonlyArray<Pick<WorkflowEdgeDef, "source" | "branch">> = [],
): string[] {
  const names: string[] = [];
  const add = (name: string | null | undefined) => {
    if (name && !names.includes(name)) names.push(name);
  };
  if (kindInfo?.dynamicBranches) configCaseNames(node.config ?? {}).forEach(add);
  kindInfo?.branches.forEach(add);
  edges.filter((edge) => edge.source === node.id).forEach((edge) => add(edge.branch));
  return names;
}

/** An edge's tone from its overlay flags (the strongest wins). */
export const edgeTone = (flags: {
  taken?: boolean;
  running?: boolean;
  failed?: boolean;
  untaken?: boolean;
}): WorkflowEdgeTone => {
  if (flags.running) return "running";
  if (flags.failed) return "failed";
  if (flags.taken) return "taken";
  if (flags.untaken) return "untaken";
  return "idle";
};
