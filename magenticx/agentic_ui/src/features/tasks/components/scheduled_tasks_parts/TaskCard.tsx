import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Building2,
  CalendarClock,
  Check,
  CircleAlert,
  Clock,
  EyeOff,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";

import type { Agent, ScheduledTask } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  describeSchedule,
  foreignTimezone,
  formatRelative,
  formatRunTime,
  targetModeLabel,
  taskStatusKind,
  type TaskStatusKind,
} from "@/features/tasks/lib/schedule";

// The status chips read like the sub-agent chips (message_parts/subagentStatus):
// same shape, the same running colour and spinner.
const STATUS_CHIP: Record<TaskStatusKind, { label: string; chip: string; icon: React.ReactNode }> =
  {
    running: {
      label: "Running",
      chip: "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]",
      icon: <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />,
    },
    scheduled: {
      label: "Scheduled",
      chip: "bg-primary/10 text-primary",
      icon: <Clock className="h-3 w-3" aria-hidden />,
    },
    paused: {
      label: "Paused",
      chip: "bg-muted text-muted-foreground",
      icon: <Pause className="h-3 w-3" aria-hidden />,
    },
    failed: {
      label: "Failed",
      chip: "bg-destructive/[0.12] text-destructive",
      icon: <CircleAlert className="h-3 w-3" aria-hidden />,
    },
    lastFailed: {
      label: "Last run failed",
      chip: "bg-destructive/[0.12] text-destructive",
      icon: <CircleAlert className="h-3 w-3" aria-hidden />,
    },
    completed: {
      label: "Completed",
      chip: "bg-success/15 text-success",
      icon: <Check className="h-3 w-3" aria-hidden />,
    },
  };

export function TaskStatusChip({ kind }: { kind: TaskStatusKind }) {
  const meta = STATUS_CHIP[kind];
  return (
    <span
      data-status={kind}
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.chip,
      )}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

/** A small neutral chip (target mode, private). */
function MetaChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}

/** An icon-only action with a tooltip; hover/focus surfaces match the sidebar. */
function ActionButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-50",
            danger
              ? "supports-[hover:hover]:hover:bg-destructive/10 supports-[hover:hover]:hover:text-destructive"
              : "supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export type TaskCardProps = {
  task: ScheduledTask;
  agents: Agent[];
  now: Date;
  index: number;
  reduceMotion: boolean;
  onToggle: (task: ScheduledTask) => Promise<void>;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onOpenResult: (conversationId: string, agentId?: string | null) => void;
};

export const TaskCard = React.forwardRef<HTMLDivElement, TaskCardProps>(function TaskCard(
  { task, agents, now, index, reduceMotion, onToggle, onEdit, onDelete, onOpenResult },
  ref,
) {
  const [busy, setBusy] = React.useState(false);
  const kind = taskStatusKind(task);
  const running = kind === "running";
  const isPaused = task.status === "paused";
  const canToggle =
    task.status === "active" || task.status === "paused" || task.status === "failed";
  const resultConversationId = task.lastRunConversationId;
  const AgentIcon = agents.find((agent) => agent.id === task.agentId)?.icon ?? Building2;
  const title = task.title?.trim() || task.prompt || "Untitled task";
  const tz = foreignTimezone(task);
  const lastFailed =
    String(task.lastRunStatus ?? task.liveStatus ?? "") === "failed" || kind === "lastFailed";

  const toggle = async () => {
    setBusy(true);
    try {
      await onToggle(task);
    } finally {
      setBusy(false);
    }
  };

  // The second line under the schedule: what happens next.
  let nextLine: React.ReactNode;
  if (running) {
    nextLine = <span className="text-[hsl(var(--subagent-active))]">Running now</span>;
  } else if (task.status === "active" && task.nextRunAt) {
    nextLine = (
      <>
        <span className="font-medium text-foreground">
          Next {formatRelative(task.nextRunAt, now)}
        </span>
        <span className="text-muted-foreground/70"> · {formatRunTime(task.nextRunAt, now)}</span>
      </>
    );
  } else if (isPaused) {
    nextLine = "Paused — no upcoming runs";
  } else if (task.status === "completed") {
    nextLine = "Finished — no more runs";
  } else {
    nextLine = "No upcoming runs";
  }

  return (
    <motion.div
      ref={ref}
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: 0 } }
          : { opacity: 0, scale: 0.96, transition: { duration: 0.16, ease: "easeIn" } }
      }
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              opacity: { duration: 0.24, delay: Math.min(index * 0.04, 0.32) },
              y: { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: Math.min(index * 0.04, 0.32) },
              scale: {
                duration: 0.28,
                ease: [0.22, 1, 0.36, 1],
                delay: Math.min(index * 0.04, 0.32),
              },
              layout: { type: "spring", stiffness: 520, damping: 42, mass: 0.8 },
            }
      }
      data-testid="scheduled-task-card"
      whileHover={
        reduceMotion ? undefined : { y: -2, transition: { duration: 0.2, ease: "easeOut" } }
      }
      className="subagent-card group/task rounded-2xl"
      data-active={running ? "true" : "false"}
    >
      <div
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-2xl border transition-[border-color,box-shadow] duration-200",
          "bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.55)_100%)]",
          "shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] supports-[hover:hover]:group-hover/task:shadow-card",
          running
            ? "border-transparent"
            : "border-border/70 supports-[hover:hover]:group-hover/task:border-primary/30",
          isPaused && "opacity-[0.88]",
        )}
      >
        <span className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-primary/[0.05] to-transparent" />

        {/* Head: agent, title, status. */}
        <div className="relative flex items-start gap-3 px-4 pt-4">
          <span
            className={cn(
              "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl transition-transform duration-300 ease-out motion-safe:supports-[hover:hover]:group-hover/task:scale-105",
              running
                ? "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]"
                : "bg-primary/10 text-primary",
            )}
          >
            <AgentIcon className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <h3
                className="line-clamp-2 min-w-0 text-[14.5px] font-semibold leading-snug text-foreground"
                title={title}
              >
                {title}
              </h3>
              <TaskStatusChip kind={kind} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 truncate text-xs text-muted-foreground">
                {task.agentName || "Agent"}
              </span>
              <MetaChip
                icon={
                  task.targetMode === "bound" ? (
                    <MessageSquare className="h-3 w-3" aria-hidden />
                  ) : (
                    <MessagesSquare className="h-3 w-3" aria-hidden />
                  )
                }
              >
                {targetModeLabel(String(task.targetMode))}
              </MetaChip>
              {task.isPrivate ? (
                <MetaChip icon={<EyeOff className="h-3 w-3" aria-hidden />}>Private</MetaChip>
              ) : null}
            </div>
          </div>
        </div>

        {/* When. */}
        <div className="relative mx-4 mt-3.5 flex items-start gap-2.5 rounded-xl bg-background/60 px-3 py-2.5 ring-1 ring-inset ring-border/50">
          <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 text-[13px] leading-5">
            <div className="truncate font-medium text-foreground">
              {describeSchedule(task)}
              {tz ? <span className="font-normal text-muted-foreground"> · {tz}</span> : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">{nextLine}</div>
          </div>
        </div>

        {/* Last run + error. */}
        <div className="relative mt-3 flex-1 space-y-2 px-4">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                !task.lastRunAt
                  ? "bg-muted-foreground/40"
                  : lastFailed
                    ? "bg-destructive"
                    : "bg-success",
              )}
            />
            {task.lastRunAt ? (
              <span className="min-w-0 truncate">
                Last run {formatRelative(task.lastRunAt, now)}
                {task.runCount > 0
                  ? ` · ${task.runCount} run${task.runCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            ) : (
              <span>Not run yet</span>
            )}
          </div>
          {task.lastError ? (
            <p
              className="line-clamp-2 rounded-lg bg-destructive/[0.07] px-2.5 py-1.5 text-xs leading-relaxed text-destructive"
              title={task.lastError}
            >
              {task.lastError}
            </p>
          ) : null}
        </div>

        {/* Actions. */}
        <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-2">
          {resultConversationId ? (
            <button
              type="button"
              onClick={() => onOpenResult(resultConversationId, task.agentId)}
              className="group/open inline-flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
            >
              <span className="truncate">Open latest result</span>
              <ArrowUpRight
                className="h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 motion-safe:group-hover/open:-translate-y-px motion-safe:group-hover/open:translate-x-px"
                aria-hidden
              />
            </button>
          ) : (
            <span className="px-2.5 text-xs text-muted-foreground/70">No result yet</span>
          )}
          <div className="flex flex-shrink-0 items-center gap-0.5">
            {canToggle ? (
              <ActionButton
                label={isPaused ? "Resume" : "Pause"}
                onClick={() => void toggle()}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : isPaused ? (
                  <Play className="h-4 w-4" aria-hidden />
                ) : (
                  <Pause className="h-4 w-4" aria-hidden />
                )}
              </ActionButton>
            ) : null}
            <ActionButton label="Edit" onClick={() => onEdit(task)}>
              <Pencil className="h-4 w-4" aria-hidden />
            </ActionButton>
            <ActionButton label="Delete" onClick={() => onDelete(task)} disabled={busy} danger>
              <Trash2 className="h-4 w-4" aria-hidden />
            </ActionButton>
          </div>
        </div>
      </div>
    </motion.div>
  );
});

/** The loading placeholder for one card. */
export function TaskCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4" aria-hidden>
      <div className="flex items-start gap-3">
        <div className="loading-skeleton h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2 pt-0.5">
          <div className="loading-skeleton h-3.5 w-3/5 rounded-full" />
          <div className="loading-skeleton h-3 w-2/5 rounded-full" />
        </div>
        <div className="loading-skeleton h-5 w-16 rounded-full" />
      </div>
      <div className="loading-skeleton mt-4 h-12 rounded-xl" />
      <div className="loading-skeleton mt-3 h-3 w-1/3 rounded-full" />
      <div className="mt-4 flex justify-between border-t border-border/50 pt-3">
        <div className="loading-skeleton h-5 w-28 rounded-full" />
        <div className="loading-skeleton h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}
