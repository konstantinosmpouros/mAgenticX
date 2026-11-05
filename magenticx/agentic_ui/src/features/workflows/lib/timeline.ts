import type {
  WorkflowExecution,
  WorkflowNodeKindInfo,
  WorkflowRunView,
  WorkflowSpec,
  WorkflowTimelineRow,
} from "@/shared/lib/types";
import { kindView, nodeLabel } from "./kinds";

/**
 * The execution timeline as rows: one per execution, in the order they
 * started (`startSeq`), each indented by how deep it sits under
 * `parentExecutionId` — a loop's body one lane in from the loop — so the
 * iterations read as a group, the way a git graph shows a branch.
 */

/** Deeper nesting than this shares the last lane: the rows stay readable on a phone. */
export const MAX_TIMELINE_DEPTH = 4;

/** The executions ordered by when they started. */
export const orderedExecutions = (view: WorkflowRunView | null): WorkflowExecution[] =>
  view ? [...view.executions].sort((a, b) => a.startSeq - b.startSeq) : [];

/** The execution that started last — what the view follows while a run is live. */
export function newestExecution(view: WorkflowRunView | null): WorkflowExecution | null {
  const ordered = orderedExecutions(view);
  return ordered.length ? ordered[ordered.length - 1] : null;
}

export function buildTimelineRows(
  view: WorkflowRunView | null,
  spec: WorkflowSpec | null,
  catalog: WorkflowNodeKindInfo[],
): WorkflowTimelineRow[] {
  const ordered = orderedExecutions(view);
  const byId = new Map(ordered.map((execution) => [execution.executionId, execution]));
  const nodes = new Map((spec?.nodes ?? []).map((node) => [node.id, node]));
  const depths = new Map<string, number>();

  // Hops up the parent chain; a missing parent ends it, a cycle is cut by `seen`.
  const depthOf = (execution: WorkflowExecution): number => {
    const cached = depths.get(execution.executionId);
    if (cached !== undefined) return cached;
    let depth = 0;
    const seen = new Set<string>([execution.executionId]);
    let parentId = execution.parentExecutionId;
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentExecutionId ?? null;
    }
    const capped = Math.min(depth, MAX_TIMELINE_DEPTH);
    depths.set(execution.executionId, capped);
    return capped;
  };

  return ordered.map((execution) => {
    const depth = depthOf(execution);
    const node = nodes.get(execution.nodeId);
    return {
      execution,
      depth,
      // Lane 0 runs through every row; each deeper lane through the rows of
      // its group, which start contiguously after their parent.
      rails: Array.from({ length: depth + 1 }, (_, level) => level),
      label: nodeLabel(node, execution.nodeId),
      kindLabel: node ? kindView(catalog, node.kind).label : "",
    };
  });
}
