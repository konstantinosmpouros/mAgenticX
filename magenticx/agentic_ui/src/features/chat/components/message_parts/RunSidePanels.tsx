import { useMemo } from "react";
import { Bot, ListChecks } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { SubagentTreeCard } from "./SubagentTreeCard";
import { PlanChecklist } from "../plan/PlanChecklist";
import { PlanProgressRing } from "../plan/PlanProgressRing";
import { subagentRunStatus, subagentTree } from "@/features/inference";
import type { PlanSnapshot } from "@/features/inference/agui";
import { buildPlanAnswer, planProgressLabel } from "@/features/chat/lib/conversationPlans";
import type { PlanStepTiming, RunTimeline, SubagentBlock } from "@/shared/lib/types";

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
