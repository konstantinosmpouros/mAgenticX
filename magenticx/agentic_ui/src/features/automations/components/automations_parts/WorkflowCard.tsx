import * as React from "react";
import {
  ArrowUpRight,
  CalendarCheck,
  CalendarClock,
  Clock,
  Hand,
  Loader2,
  Pause,
  Pencil,
  Play,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";

import type { WorkflowAutomationItem, WorkflowScheduleStatus } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  ActionButton,
  AutomationCardFrame,
  KindBadge,
  MetaChip,
} from "@/features/automations/components/automations_parts/AutomationCardChrome";
import {
  describeWorkflowSchedule,
  workflowLastRun,
  workflowScheduleLine,
} from "@/shared/lib/workflowSchedule";

export type WorkflowCardProps = {
  item: WorkflowAutomationItem;
  now: Date;
  index: number;
  reduceMotion: boolean;
  onOpen: (workflowId: string) => void;
  onEdit: (workflowId: string) => void;
  /** Resolves when the run started (or the view opened); the button spins until then. */
  onRunNow: (workflowId: string) => Promise<void>;
  onDelete: (workflowId: string) => void;
  /**
   * Pause (true) or resume (false) the workflow's schedule; resolves once the
   * server answered. Only offered while it has a schedule that isn't finished.
   */
  onSetSchedulePaused?: (workflowId: string, paused: boolean) => Promise<void>;
};

// The schedule's state, in the schedule cards' chip shape.
const SCHEDULE_CHIP: Record<
  WorkflowScheduleStatus,
  { label: string; chip: string; icon: React.ReactNode }
> = {
  active: {
    label: "Scheduled",
    chip: "bg-primary/10 text-primary",
    icon: <Clock className="h-3 w-3" aria-hidden />,
  },
  paused: {
    label: "Paused",
    chip: "bg-muted text-muted-foreground",
    icon: <Pause className="h-3 w-3" aria-hidden />,
  },
  finished: {
    label: "Finished",
    chip: "bg-success/15 text-success",
    icon: <CalendarCheck className="h-3 w-3" aria-hidden />,
  },
};

/**
 * One workflow on the Automations page (its Workflows area), in the schedule
 * card's chrome: name, description, version, its schedule when its start node
 * sets one (its state, next run, the last scheduled run and how it went), and
 * Open / Run now / Pause or Resume (a scheduled one) / Edit / Delete.
 *
 * No latest-run line for a workflow started by hand: the runs list has no page
 * size, so reading it per card would cost one request per workflow.
 */
export const WorkflowCard = React.forwardRef<HTMLDivElement, WorkflowCardProps>(
  function WorkflowCard(
    { item, now, index, reduceMotion, onOpen, onEdit, onRunNow, onDelete, onSetSchedulePaused },
    ref,
  ) {
    const { workflow } = item;
    const [starting, setStarting] = React.useState(false);
    const [toggling, setToggling] = React.useState(false);
    const schedule = workflow.schedule ?? null;
    const paused = schedule?.status === "paused";
    const scheduleLine = workflowScheduleLine(workflow, now);
    const lastRun = workflowLastRun(workflow, now);
    const canToggle = Boolean(onSetSchedulePaused && schedule && schedule.status !== "finished");
    const chip = schedule ? SCHEDULE_CHIP[schedule.status] : null;

    const toggleSchedule = async () => {
      if (!onSetSchedulePaused) return;
      setToggling(true);
      try {
        await onSetSchedulePaused(workflow.id, !paused);
      } finally {
        setToggling(false);
      }
    };

    const runNow = async () => {
      setStarting(true);
      try {
        await onRunNow(workflow.id);
      } finally {
        setStarting(false);
      }
    };

    return (
      <AutomationCardFrame
        ref={ref}
        kind={item.kind}
        index={index}
        reduceMotion={reduceMotion}
        dimmed={paused}
      >
        {/* Head: icon, name, kind and version. */}
        <div className="relative flex items-start gap-3 px-4 pt-4">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform duration-300 ease-out motion-safe:supports-[hover:hover]:group-hover/task:scale-105">
            <WorkflowIcon className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3
              className="line-clamp-2 min-w-0 text-[14.5px] font-semibold leading-snug text-foreground"
              title={workflow.name}
            >
              {workflow.name}
            </h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <KindBadge kind={item.kind} />
              {workflow.latestVersionNo !== null ? (
                <MetaChip>v{workflow.latestVersionNo}</MetaChip>
              ) : null}
              {chip && schedule ? (
                <span
                  data-schedule-status={schedule.status}
                  className={cn(
                    "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    chip.chip,
                  )}
                >
                  {chip.icon}
                  {chip.label}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* When: its schedule (from the start node), or by hand. */}
        <div className="relative mx-4 mt-3.5 flex items-start gap-2.5 rounded-xl bg-background/60 px-3 py-2.5 ring-1 ring-inset ring-border/50">
          {schedule ? (
            paused ? (
              <Pause className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
            )
          ) : (
            <Hand className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 text-[13px] leading-5">
            <div className="truncate font-medium text-foreground">
              {schedule ? describeWorkflowSchedule(schedule) : "Runs when you start it"}
            </div>
            <div
              className="truncate text-xs text-muted-foreground"
              data-testid="workflow-schedule-line"
            >
              {scheduleLine}
            </div>
          </div>
        </div>

        {/* Description, and the last scheduled run when there is one. */}
        <div className="relative mt-3 flex-1 space-y-2 px-4">
          {workflow.description ? (
            <p
              className="line-clamp-2 text-xs leading-relaxed text-muted-foreground"
              title={workflow.description}
            >
              {workflow.description}
            </p>
          ) : null}
          {lastRun ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                  lastRun.failed ? "bg-destructive" : "bg-success",
                )}
              />
              <span className="min-w-0 truncate">{lastRun.label}</span>
            </div>
          ) : null}
        </div>

        {/* Actions. */}
        <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-2">
          <button
            type="button"
            onClick={() => onOpen(workflow.id)}
            className="group/open inline-flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
          >
            <span className="truncate">Open</span>
            <ArrowUpRight
              className="h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 motion-safe:group-hover/open:-translate-y-px motion-safe:group-hover/open:translate-x-px"
              aria-hidden
            />
          </button>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <ActionButton label="Run now" onClick={() => void runNow()} disabled={starting}>
              {starting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
            </ActionButton>
            {canToggle ? (
              <ActionButton
                label={paused ? "Resume schedule" : "Pause schedule"}
                onClick={() => void toggleSchedule()}
                disabled={toggling}
              >
                {toggling ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : paused ? (
                  <CalendarClock className="h-4 w-4" aria-hidden />
                ) : (
                  <Pause className="h-4 w-4" aria-hidden />
                )}
              </ActionButton>
            ) : null}
            <ActionButton label="Edit" onClick={() => onEdit(workflow.id)}>
              <Pencil className="h-4 w-4" aria-hidden />
            </ActionButton>
            <ActionButton
              label="Delete"
              onClick={() => onDelete(workflow.id)}
              disabled={starting}
              danger
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </ActionButton>
          </div>
        </div>
      </AutomationCardFrame>
    );
  },
);
