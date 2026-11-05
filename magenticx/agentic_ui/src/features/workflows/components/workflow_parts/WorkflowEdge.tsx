import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowEdgeData } from "@/shared/lib/types";
import { edgeTone } from "@/features/workflows/lib/nodeCard";
import { arrowHeadPath, backEdgePath } from "@/features/workflows/lib/layout";

type WorkflowEdgeProps = EdgeProps<Edge<WorkflowEdgeData>>;

/** A target this far left of (or this close to) its source gets the arc, not an S-curve. */
const BACK_THRESHOLD = 32;

/**
 * The shared workflow edge (run view and builder): a smooth bezier from a
 * source handle on a card's right edge to the target handle on the next
 * card's left, ending in one small arrowhead. An edge that closes a loop —
 * flagged `back` by the layout, or simply pointing back left — runs as an arc
 * under the cards instead, so it never cuts through one. Branch names are on
 * the cards, next to their handles, never on the line.
 *
 * View mode reads the run: the taken path lit, a flowing dash into a running
 * node (the edge's `animated` flag; off under reduced motion), a red tint into
 * a failed one, branches the run did not take muted. Edit mode: a delete
 * button comes up on hover or selection — `data.onDelete`, else React Flow's
 * `deleteElements` (so a controlled canvas sees it in `onEdgesChange`).
 */
export function WorkflowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected,
  style,
}: WorkflowEdgeProps) {
  const { deleteElements } = useReactFlow();
  const [hovered, setHovered] = React.useState(false);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const mode = data?.mode ?? "view";
  const tone = edgeTone(data ?? {});
  const back = Boolean(data?.back) || targetX < sourceX + BACK_THRESHOLD;

  let path: string;
  let mid: { x: number; y: number };
  if (back) {
    // The arc's floor: as the layout said, else under both cards.
    const bottom = (node: typeof sourceNode) =>
      node ? node.internals.positionAbsolute.y + (node.measured.height ?? node.height ?? 0) : 0;
    const floorY = data?.floorY ?? Math.max(bottom(sourceNode), bottom(targetNode), sourceY, targetY) + 36;
    ({ path, mid } = backEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, floorY));
  } else {
    const [bezier, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition: Position.Right,
      targetX,
      targetY,
      targetPosition: Position.Left,
    });
    path = bezier;
    mid = { x: labelX, y: labelY };
  }

  const remove = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (data?.onDelete) data.onDelete(id);
    else void deleteElements({ edges: [{ id }] });
  };
  const showDelete = mode === "edit" && (hovered || selected);

  return (
    <>
      <g
        className={cn("workflow-edge", `is-${tone}`, back && "is-back", selected && "is-selected")}
        data-tone={tone}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {tone === "running" ? <path d={path} className="workflow-edge-glow" fill="none" /> : null}
        <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
        <path
          d={arrowHeadPath({ x: targetX + 1, y: targetY })}
          className="workflow-edge-arrow"
          aria-hidden
        />
      </g>
      {mode === "edit" ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={cn(
              "workflow-edge-delete nodrag nopan absolute flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-[0_4px_12px_-6px_hsl(var(--foreground)/0.4)] transition-[opacity,color,background-color] hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              showDelete ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
            aria-label={data?.branch ? `Delete the ${data.branch} connection` : "Delete connection"}
            title="Delete connection"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={remove}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export default WorkflowEdge;
