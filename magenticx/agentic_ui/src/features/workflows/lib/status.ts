import { Check, CircleDashed, CircleSlash, Loader2, Pause, X, type LucideIcon } from "lucide-react";

import type { WorkflowExecutionStatus, WorkflowRunStatus } from "@/shared/lib/types";

/**
 * How a run or execution status reads in the workflow view — label, icon and
 * tones — so the graph overlay, the timeline, the run picker and the details
 * panel all say the same thing. Colour is never the only signal: every status
 * has its own icon and label (the app's accessibility rule).
 *
 * - `chip`  — the pill (background + text) next to a name.
 * - `text`  — the icon colour on its own (timeline dot, picker row).
 * - `ring`  — the graph node's border + ring while it shows this status.
 * - `dot`   — the timeline lane dot's fill.
 * - `spin`  — the icon turns (only with motion allowed: `motion-safe:`).
 */
export type WorkflowStatusMeta = {
  label: string;
  icon: LucideIcon;
  chip: string;
  text: string;
  ring: string;
  dot: string;
  spin?: boolean;
};

export const EXECUTION_STATUS_META: Record<WorkflowExecutionStatus, WorkflowStatusMeta> = {
  running: {
    label: "Running",
    icon: Loader2,
    chip: "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]",
    text: "text-[hsl(var(--subagent-active))]",
    ring: "border-[hsl(var(--subagent-active))] ring-2 ring-[hsl(var(--subagent-active)/0.25)]",
    dot: "bg-[hsl(var(--subagent-active))]",
    spin: true,
  },
  waiting: {
    label: "Waiting",
    icon: Pause,
    chip: "bg-warning/15 text-warning",
    text: "text-warning",
    ring: "border-warning/80 ring-2 ring-warning/20",
    dot: "bg-warning",
  },
  succeeded: {
    label: "Succeeded",
    icon: Check,
    chip: "bg-success/15 text-success",
    text: "text-success",
    ring: "border-success/60",
    dot: "bg-success",
  },
  failed: {
    label: "Failed",
    icon: X,
    chip: "bg-destructive/[0.12] text-destructive",
    text: "text-destructive",
    ring: "border-destructive/70 ring-2 ring-destructive/15",
    dot: "bg-destructive",
  },
  cancelled: {
    label: "Cancelled",
    icon: CircleSlash,
    chip: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    ring: "border-border",
    dot: "bg-muted-foreground/60",
  },
};

export const RUN_STATUS_META: Record<WorkflowRunStatus, WorkflowStatusMeta> = {
  queued: {
    label: "Queued",
    icon: CircleDashed,
    chip: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    ring: "border-border",
    dot: "bg-muted-foreground/60",
  },
  running: EXECUTION_STATUS_META.running,
  waiting: { ...EXECUTION_STATUS_META.waiting, label: "Waiting for approval" },
  succeeded: EXECUTION_STATUS_META.succeeded,
  failed: EXECUTION_STATUS_META.failed,
  cancelled: EXECUTION_STATUS_META.cancelled,
};
