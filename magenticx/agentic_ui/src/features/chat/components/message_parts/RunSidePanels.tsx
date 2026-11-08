import { Fragment, useMemo, useState } from "react";
import { Bot, ChevronRight, ListChecks } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { cn } from "@/shared/lib/utils";
import { SubagentTreeCard } from "./SubagentTreeCard";
import { TaskApprovals } from "./TaskApprovals";
import { STATUS_META } from "./subagentStatus";
import { TaskStopButton } from "./TaskStopButton";
import { TaskTreeCards } from "./TaskTreeCards";
import { TimelineSequence } from "./TimelineSequence";
import { PlanChecklist } from "../plan/PlanChecklist";
import { PlanProgressRing } from "../plan/PlanProgressRing";
import {
  isTaskSettled,
  subagentRunStatus,
  subagentTree,
  taskAncestry,
  taskChildrenIndex,
  taskDisplayStatus,
  toTitleCase,
  useBackgroundTasksContext,
  type BackgroundTasksContextValue,
} from "@/features/inference";
import type { PlanSnapshot } from "@/features/inference/agui";
import { buildPlanAnswer, planProgressLabel } from "@/features/chat/lib/conversationPlans";
import {
  taskElapsedLabel,
  taskSubagentStatus,
  taskUsageLabel,
} from "@/features/chat/lib/taskTreeAdapter";
import { useTaskClock } from "@/features/chat/hooks/useTaskClock";
import type { AsyncTask, PlanStepTiming, RunTimeline, SubagentBlock } from "@/shared/lib/types";

// Post-run side panels behind two action-bar buttons: one answer's plan (the
// same checklist as the composer's plan panel), and its sub-agents — the cards
// stay inline and the sub-agents panel lists them again, all together, as the
// same tree (a sub-agent's own sub-agents inside its card). Both panels replay
// state derived from the same run timeline.

type PlanSidePanelProps = {
  plan: PlanSnapshot;
  /** The steps' start and finish times, when the timeline knows them. */
  timings?: PlanStepTiming[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PlanSidePanel({ plan, timings, open, onOpenChange }: PlanSidePanelProps) {
  const answer = useMemo(
    () =>
      buildPlanAnswer({
        messageId: "",
        number: 1,
        question: "",
        plan: { plan, timings: timings ?? [] },
        live: false,
      }),
    [plan, timings],
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border/70 px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <PlanProgressRing
              completed={answer?.completed ?? 0}
              total={answer?.total ?? 0}
              size={34}
              strokeWidth={3}
              className="text-primary"
            >
              <ListChecks className="relative h-4 w-4" aria-hidden />
            </PlanProgressRing>
            Plan
          </SheetTitle>
          <SheetDescription>{answer ? planProgressLabel(answer) : "No steps"}</SheetDescription>
        </SheetHeader>
        <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {answer ? <PlanChecklist steps={answer.steps} label="Plan" /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type SubagentsSidePanelProps = {
  timeline: RunTimeline;
  // Whether the run still streams to this view. The panel opens from the
  // action bar of a settled message today, so it defaults to false; the cards
  // show the same status (and ring) as their inline twins either way.
  isLive?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SubagentsSidePanel({
  timeline,
  isLive = false,
  open,
  onOpenChange,
}: SubagentsSidePanelProps) {
  // Spawned only. A sub-agent block is opened by TASK_SUBAGENT, which fires when
  // the orchestrator *calls* the `task` tool — before the HITL gate. A call the
  // user rejected leaves an unspawned block behind: it is a refused tool
  // execution, not a sub-agent, and listing it showed a card with no response
  // and no tool activity next to ones that really ran.
  const subagents = useMemo(
    () =>
      timeline.blocks.filter(
        (block): block is SubagentBlock => block.kind === "subagent" && Boolean(block.spawned),
      ),
    [timeline.blocks],
  );
  const tree = useMemo(() => subagentTree({ blocks: subagents }), [subagents]);
  const nestedCount = subagents.length - tree.roots.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <SheetHeader className="border-b border-border/70 px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
              <Bot className="h-4 w-4" />
            </span>
            Sub-agents
          </SheetTitle>
          <SheetDescription>
            {subagents.length} delegated task{subagents.length === 1 ? "" : "s"} in this run
            {nestedCount ? ` — ${nestedCount} by other sub-agents` : ""}
          </SheetDescription>
        </SheetHeader>
        {/* Block container, NOT flex-col: SubagentCard's root is overflow-hidden,
            which zeroes a flex item's automatic min-height — a flex column would
            squash the cards to fit instead of overflowing into this scroll. */}
        <div className="scrollbar-muted min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {tree.roots.map((block, index) => (
            <SubagentTreeCard
              key={block.id}
              block={block}
              index={index}
              childrenOf={tree.childrenOf}
              statusOf={(item) => subagentRunStatus(item, timeline, isLive)}
              defaultCollapsedSections
            />
          ))}
          {!subagents.length ? (
            <p className="px-1 text-sm text-muted-foreground">No sub-agent activity in this run.</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The drill-down of one background task, at any depth (plan 41 §3.9): its
 * live events folded like a run of its own, its approval when it waits on
 * one, its own sub-agents (each opens the same panel one level down), and
 * Stop in the header. One panel for the whole conversation, opened by the
 * task tree's `openTask` — from a card, a notice row, an inline marker or the
 * composer's approval prompt. The path above the title walks back up.
 */
export function TaskSidePanel() {
  const tasks = useBackgroundTasksContext();
  const openId = tasks?.openTaskId ?? null;
  const task = openId && tasks ? tasks.tree.tasks[openId] : undefined;
  return (
    <Sheet open={Boolean(task)} onOpenChange={(open) => (open ? null : tasks?.openTask(null))}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        {task && tasks ? <TaskSidePanelBody key={task.taskId} task={task} tasks={tasks} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function TaskSidePanelBody({
  task,
  tasks,
}: {
  task: AsyncTask;
  tasks: BackgroundTasksContextValue;
}) {
  const { tree, openTask, stopTask } = tasks;
  const status = taskDisplayStatus(tree, task.taskId) ?? task.status;
  const active = !isTaskSettled(task.status);
  const now = useTaskClock(active);
  const node = tree.nodes[task.taskId];
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const meta = STATUS_META[taskSubagentStatus(status)];
  const ancestry = useMemo(() => taskAncestry(tree, task.taskId), [tree, task.taskId]);
  const elapsed = taskElapsedLabel(task, now);
  const usage = taskUsageLabel(task.usage);
  // Its own sub-agents not already drawn at their launch point in its events.
  const children = useMemo(() => {
    const referenced = new Set(
      (node?.timeline.blocks ?? []).flatMap((block) =>
        block.kind === "task_ref" ? [block.taskId] : [],
      ),
    );
    return (taskChildrenIndex(tree).get(task.taskId) ?? []).filter(
      (child) => !referenced.has(child.taskId),
    );
  }, [node?.timeline, task.taskId, tree]);
  const hasEvents = Boolean(node && node.timeline.blocks.length);

  return (
    <>
      <SheetHeader className="space-y-2 border-b border-border/70 px-5 py-4 text-left">
        {ancestry.length > 1 ? (
          <nav aria-label="Task path" className="min-w-0 pr-8">
            <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
              {ancestry.map((step, index) => {
                const last = index === ancestry.length - 1;
                return (
                  <Fragment key={step.taskId}>
                    {index > 0 ? (
                      <li aria-hidden="true">
                        <ChevronRight className="h-3 w-3" />
                      </li>
                    ) : null}
                    <li className="min-w-0 max-w-[10rem]">
                      {last ? (
                        <span aria-current="page" className="block truncate text-foreground">
                          {toTitleCase(step.name)}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openTask(step.taskId)}
                          className="block max-w-full truncate rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                        >
                          {toTitleCase(step.name)}
                        </button>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          </nav>
        ) : null}
        {/* pr-8 keeps the row clear of the sheet's own close button (top-right). */}
        <div className="flex min-w-0 items-start gap-2.5 pr-8">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-base">{toTitleCase(task.name)}</SheetTitle>
            <SheetDescription asChild>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-medium",
                    meta.chip,
                  )}
                >
                  {meta.icon}
                  {meta.label}
                </span>
                {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
                {task.model ? (
                  <span className="min-w-0 max-w-[12rem] truncate" title={task.model}>
                    {task.model}
                  </span>
                ) : null}
                {usage ? <span className="whitespace-nowrap tabular-nums">{usage}</span> : null}
              </div>
            </SheetDescription>
          </div>
          <TaskStopButton
            name={task.name}
            status={status}
            onStop={() => void stopTask(task.taskId)}
          />
        </div>
      </SheetHeader>
      {/* Block container, NOT flex-col — see SubagentsSidePanel: the cards'
          overflow-hidden roots would be squashed by a flex column. */}
      <div className="scrollbar-muted min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <TaskApprovals task={task} tasks={tasks} />
        {task.description ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
            {task.description}
          </p>
        ) : null}
        {hasEvents && node ? (
          <div className="min-w-0 space-y-3">
            <TimelineSequence
              timeline={node.timeline}
              runId={`task:${task.taskId}`}
              isStreaming={active}
              expandedThinking={expandedThinking}
              onToggleThinking={(key, next) =>
                setExpandedThinking((prev) => ({ ...prev, [key]: next ?? !prev[key] }))
              }
            />
          </div>
        ) : active ? (
          <div className="space-y-2" aria-label="Loading the task's activity">
            <div className="loading-skeleton h-4 w-3/4 rounded-full" />
            <div className="loading-skeleton h-4 w-1/2 rounded-full" />
          </div>
        ) : task.resultPreview ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-foreground">
            {task.resultPreview}
          </p>
        ) : null}
        {task.status === "error" && task.error ? (
          <p className="rounded-2xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]">
            {task.error}
          </p>
        ) : null}
        {children.length ? (
          <section aria-label="Sub-agents" className="space-y-1.5">
            <p className="px-1 text-xs text-muted-foreground">Sub-agents</p>
            <TaskTreeCards roots={children} tasks={tasks} defaultCollapsedSections />
          </section>
        ) : null}
      </div>
    </>
  );
}
