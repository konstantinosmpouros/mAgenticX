import * as React from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, CalendarClock, Pause, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowNodeCardData } from "@/shared/lib/types";
import { humanizeKind, kindMeta } from "@/features/workflows/lib/kinds";
import {
  HEADER_HANDLE_TOP,
  NODE_CARD,
  branchHandleTop,
  sourceHandleId,
} from "@/features/workflows/lib/nodeCard";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { TOOL_KIND } from "@/features/workflows/lib/builder/graph";
import { StatusChip } from "../workflow_view_parts/StatusChip";

type WorkflowNodeCardProps = NodeProps<Node<WorkflowNodeCardData>>;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Stop a click on the card's own control from also picking (or panning) the node. */
const own = (event: React.SyntheticEvent) => event.stopPropagation();

/**
 * The shared workflow node card — a React Flow custom node for both the run
 * view's graph and the builder's canvas, in the agent builder's visual
 * language (rounded card, soft top sheen, icon tile, small-caps kind over a
 * semibold label, hover lift, a primary ring when selected).
 *
 * Flow runs left → right: the target handle on the left (none on a trigger),
 * and on the right one source handle per branch, each on its own row with the
 * branch's name beside it — or a single plain handle when the node does not
 * branch. Geometry comes from lib/nodeCard, so the layout and the edges line
 * up with the handles exactly.
 *
 * `mode: "view"` overlays the run: a status chip (a spinner while running), a
 * travelling light round the border and a sweep across the card while it
 * runs, an amber pulse while it waits, green / red / muted when it ended, a
 * ×N badge when it ran more than once, its taken branch lit, faded when the
 * run has not reached it. `mode: "edit"` shows the issue badge and, on hover,
 * focus or selection, the delete action (`onDelete`). A `subtitle` (the
 * schedule trigger's cadence and next run, or "Paused"; a tool step's tool) sits under the label
 * in either mode. Motion stops under
 * reduced motion (styles/workflow-flow.css).
 */
export function WorkflowNodeCard({ data, selected: flowSelected }: WorkflowNodeCardProps) {
  const meta = kindMeta(data.kind);
  const Glyph = meta.icon;
  const status = data.mode === "view" ? (data.status ?? null) : null;
  const statusMeta = status ? EXECUTION_STATUS_META[status] : null;
  const selected = Boolean(data.selected || flowSelected);
  const count = data.executionCount ?? 0;
  const issues = data.mode === "edit" ? (data.issueCount ?? 0) : 0;
  const kindLabel = data.kindInfo?.label ?? humanizeKind(data.kind);
  const editable = data.mode === "edit";
  const handleClass = cn("workflow-node-handle", !editable && "is-readonly");
  const label = data.label.trim();

  return (
    <div
      className={cn(
        "workflow-node group/node relative h-full w-full",
        `workflow-node--${status ?? "idle"}`,
      )}
      style={{ "--wf-accent": meta.accent } as React.CSSProperties}
      data-testid={`workflow-node-${data.nodeId}`}
      data-status={status ?? "idle"}
      data-mode={data.mode}
      data-kind={meta.category}
      data-selected={selected ? "true" : "false"}
      data-dimmed={data.dimmed ? "true" : "false"}
      data-errors={data.hasErrors ? "true" : "false"}
    >
      <div className="workflow-node-card agent-map-flow-card relative flex h-full flex-col overflow-hidden rounded-[1.1rem] border border-border/70 bg-card">
        <span className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-primary/[0.06] to-transparent" />
        {status === "running" ? (
          <span className="workflow-node-sweep pointer-events-none absolute inset-0" aria-hidden />
        ) : null}

        <div
          className="relative flex flex-shrink-0 items-center gap-3 px-3"
          style={{ height: NODE_CARD.headerHeight }}
        >
          <span className="workflow-node-tile relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl">
            <Glyph className="h-[17px] w-[17px]" aria-hidden />
          </span>
          <span className="relative min-w-0 flex-1">
            <span className="workflow-node-kind block truncate text-[9.5px] font-semibold uppercase tracking-[0.16em]">
              {kindLabel}
            </span>
            <span
              className={cn(
                "block truncate text-[13.5px] font-semibold tracking-tight",
                label ? "text-foreground" : "font-medium italic text-muted-foreground",
              )}
            >
              {label || data.nodeId || "Untitled step"}
            </span>
            {data.subtitle ? (
              <span
                className="mt-px flex min-w-0 items-center gap-1 text-[10.5px] font-medium text-muted-foreground"
                title={data.subtitle}
                data-testid={`workflow-node-subtitle-${data.nodeId}`}
                data-paused={data.subtitlePaused ? "true" : "false"}
              >
                {data.subtitlePaused ? (
                  <Pause className="h-2.5 w-2.5 flex-shrink-0" aria-hidden />
                ) : data.kind === TOOL_KIND ? null : (
                  <CalendarClock
                    className="workflow-node-kind h-2.5 w-2.5 flex-shrink-0"
                    aria-hidden
                  />
                )}
                <span className="truncate">{data.subtitle}</span>
              </span>
            ) : null}
          </span>
          {statusMeta ? <StatusChip meta={statusMeta} iconOnly className="relative" /> : null}
          {issues > 0 ? (
            <span
              className={cn(
                "relative flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums",
                data.hasErrors
                  ? "bg-destructive/12 text-destructive"
                  : "bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]",
              )}
              title={plural(issues, "issue")}
              data-testid={`workflow-node-issues-${data.nodeId}`}
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {issues}
              <span className="sr-only"> {issues === 1 ? "issue" : "issues"}</span>
            </span>
          ) : null}
        </div>

        {data.branches.length ? (
          <ul
            className="relative border-t border-dashed border-border/70"
            style={{ paddingBlock: NODE_CARD.branchPadding }}
            aria-label="Branches"
          >
            {data.branches.map((branch) => {
              const taken = data.mode === "view" && data.takenBranch === branch;
              return (
                <li
                  key={branch}
                  className="flex items-center justify-end pr-3.5"
                  style={{ height: NODE_CARD.branchRowHeight }}
                  data-branch={branch}
                  data-taken={taken ? "true" : "false"}
                >
                  <span
                    className={cn(
                      "workflow-node-branch max-w-[75%] truncate rounded-full px-2 py-px text-[10.5px] font-medium",
                      taken && "is-taken",
                    )}
                    title={branch}
                  >
                    {branch}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {count > 1 ? (
        <span
          className="workflow-node-count absolute -right-2 -top-2 z-10 rounded-full border border-border/70 bg-card px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-foreground"
          title={`Ran ${count} times`}
          data-testid={`workflow-node-count-${data.nodeId}`}
        >
          ×{count}
        </span>
      ) : null}

      {editable && data.onDelete ? (
        <div className="workflow-node-reveal absolute -top-3.5 right-3 z-10 flex items-center rounded-full border border-border/70 bg-card p-0.5 shadow-[0_6px_16px_-10px_hsl(var(--foreground)/0.4)]">
          <button
            type="button"
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`Delete ${label || data.nodeId}`}
            title="Delete"
            onClick={(event) => {
              own(event);
              data.onDelete?.(data.nodeId);
            }}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ) : null}

      {data.isTrigger ? null : (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={editable}
          className={cn(handleClass, "is-target")}
          style={{ top: HEADER_HANDLE_TOP }}
        />
      )}
      {data.branches.length ? (
        data.branches.map((branch, index) => (
          <Handle
            key={branch}
            id={sourceHandleId(branch)}
            type="source"
            position={Position.Right}
            isConnectable={editable}
            className={cn(
              handleClass,
              data.mode === "view" && data.takenBranch === branch && "is-taken",
            )}
            style={{ top: branchHandleTop(index) }}
          />
        ))
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={editable}
          className={handleClass}
          style={{ top: HEADER_HANDLE_TOP }}
        />
      )}
    </div>
  );
}

export default WorkflowNodeCard;
