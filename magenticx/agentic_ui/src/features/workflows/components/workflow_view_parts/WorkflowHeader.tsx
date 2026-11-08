import type { ReactNode } from "react";
import {
  CalendarClock,
  History,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Square,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import type { WorkflowSchedule } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  describeWorkflowSchedule,
  scheduleLastRun,
  scheduleNextLine,
} from "@/shared/lib/workflowSchedule";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/workflows/lib/consts";

type WorkflowHeaderProps = {
  name: string;
  description: string | null;
  /** The run picker (absent before the first run). */
  picker?: ReactNode;
  /** Shown while the selected run is live. */
  onCancel?: () => void;
  cancelling?: boolean;
  onRun: () => void;
  runDisabled?: boolean;
  /** Open the builder (the ⋯ menu's "Edit"). */
  onEdit?: () => void;
  /** Open the version history (the ⋯ menu's "Version history"). */
  onHistory?: () => void;
  /** Ask to delete the workflow (the ⋯ menu's "Delete workflow", last). */
  onDelete?: () => void;
  /** The workflow's schedule (its `trigger.schedule` start node): a line under the name. */
  schedule?: WorkflowSchedule | null;
  /** The clock the schedule line reads relative times against (ms). */
  now?: number;
  /** Pause (true) or resume (false) the schedule; no button without it. */
  onSetSchedulePaused?: (paused: boolean) => void;
  scheduleBusy?: boolean;
};

/**
 * The workflow view's header, in the Automations page's style: the
 * workflow's name and description on the left; the run picker,
 * Cancel (while the run is live) and the primary Run ▸ on the right. On a
 * phone the sidebar toggle leads, since the view covers the chat header's.
 * A scheduled workflow adds a line under the name: its cadence, next run (or
 * paused / finished), the last scheduled run and how it went, and Pause /
 * Resume. With `onHistory`, the ⋯ menu's "Version history" opens the builder's version history (as the agent page's version row opens its
 * History tab).
 */
export function WorkflowHeader({
  name,
  description,
  picker,
  onCancel,
  cancelling = false,
  onRun,
  runDisabled = false,
  onEdit,
  onHistory,
  onDelete,
  schedule = null,
  now = Date.now(),
  onSetSchedulePaused,
  scheduleBusy = false,
}: WorkflowHeaderProps) {
  const at = new Date(now);
  const lastRun = schedule ? scheduleLastRun(schedule, at) : null;
  const paused = schedule?.status === "paused";
  return (
    <header className="relative flex-shrink-0 border-b border-border/60 px-4 pb-3 pt-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="inline-flex h-10 w-10 flex-shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
          />
          <span className="hidden h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-primary/10 text-primary sm:grid">
            <WorkflowIcon className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {name}
              </h1>
            </div>
            {description ? (
              <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{description}</p>
            ) : null}
            {schedule ? (
              <div
                className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                data-testid="workflow-header-schedule"
                data-schedule-status={schedule.status}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground/90">
                  {paused ? (
                    <Pause
                      className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <CalendarClock className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
                  )}
                  <span className="truncate">{describeWorkflowSchedule(schedule)}</span>
                </span>
                <span aria-hidden>·</span>
                <span className="truncate">{scheduleNextLine(schedule, at)}</span>
                {lastRun ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden
                        className={cn(
                          "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                          lastRun.failed ? "bg-destructive" : "bg-success",
                        )}
                      />
                      <span className="truncate">{lastRun.label}</span>
                    </span>
                  </>
                ) : null}
                {onSetSchedulePaused && schedule.status !== "finished" ? (
                  <button
                    type="button"
                    onClick={() => onSetSchedulePaused(!paused)}
                    disabled={scheduleBusy}
                    className="inline-flex min-h-[1.75rem] items-center gap-1 rounded-full border border-border/60 px-2.5 py-0.5 text-[11px] font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
                  >
                    {scheduleBusy ? (
                      <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
                    ) : paused ? (
                      <CalendarClock className="h-3 w-3" aria-hidden />
                    ) : (
                      <Pause className="h-3 w-3" aria-hidden />
                    )}
                    {paused ? "Resume schedule" : "Pause schedule"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Below the title on a phone, the full width: the run picker shrinks
            (truncating its label) so every action stays on screen. */}
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-shrink-0">
          {picker}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className={cn(
                SECONDARY_BUTTON,
                "supports-[hover:hover]:hover:border-destructive/40 supports-[hover:hover]:hover:text-destructive",
              )}
            >
              {cancelling ? (
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Square className="h-3.5 w-3.5" aria-hidden />
              )}
              Cancel
            </button>
          ) : null}
          {onEdit || onHistory || onDelete ? (
            // Not modal, like the builder's ⋯ menu: a modal menu's body lock
            // could be left behind when the item navigates away.
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(SECONDARY_BUTTON, "w-10 justify-center px-0")}
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[11rem] rounded-xl p-1">
                {onEdit ? (
                  <DropdownMenuItem onSelect={onEdit} className="gap-2 rounded-lg">
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {onHistory ? (
                  <DropdownMenuItem onSelect={onHistory} className="gap-2 rounded-lg">
                    <History className="h-3.5 w-3.5" aria-hidden />
                    Version history
                  </DropdownMenuItem>
                ) : null}
                {onDelete ? (
                  <>
                    {onEdit || onHistory ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem
                      onSelect={onDelete}
                      className="gap-2 rounded-lg text-destructive focus:bg-destructive/10 focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Delete workflow
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <button type="button" onClick={onRun} disabled={runDisabled} className={PRIMARY_BUTTON}>
            <Play className="h-4 w-4" aria-hidden />
            Run
          </button>
        </div>
      </div>
    </header>
  );
}
