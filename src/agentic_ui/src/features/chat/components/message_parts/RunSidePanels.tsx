import { useMemo } from "react";
import { Bot, ListTodo } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { PlanItems } from "./PlanningContainer";
import { SubagentCard } from "./SubagentContainer";
import { subagentBlockToItem } from "@/features/inference";
import type { PlanSnapshot } from "@/features/inference/agui";
import type { RunTimeline, SubagentBlock } from "@/shared/lib/types";

// Post-run side panels: once a run terminates, the plan card and the
// sub-agent panels leave the message body and live behind two action-bar
// buttons. Both panels replay state derived from the same run timeline.

type PlanSidePanelProps = {
  plan: PlanSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PlanSidePanel({ plan, open, onOpenChange }: PlanSidePanelProps) {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/70 px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
              <ListTodo className="h-4 w-4" />
            </span>
            Agent plan
          </SheetTitle>
          <SheetDescription>
            {completed} of {plan.items.length} steps completed
          </SheetDescription>
        </SheetHeader>
        <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <PlanItems plan={plan} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

type SubagentsSidePanelProps = {
  timeline: RunTimeline;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SubagentsSidePanel({ timeline, open, onOpenChange }: SubagentsSidePanelProps) {
  const subagents = useMemo(
    () => timeline.blocks.filter((block): block is SubagentBlock => block.kind === "subagent"),
    [timeline.blocks],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border/70 px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
              <Bot className="h-4 w-4" />
            </span>
            Sub-agents
          </SheetTitle>
          <SheetDescription>
            {subagents.length} delegated task{subagents.length === 1 ? "" : "s"} in this run
          </SheetDescription>
        </SheetHeader>
        {/* Block container, NOT flex-col: SubagentCard's root is overflow-hidden,
            which zeroes a flex item's automatic min-height — a flex column would
            squash the cards to fit instead of overflowing into this scroll. */}
        <div className="scrollbar-muted min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {subagents.map((block, index) => (
            <SubagentCard
              key={block.id}
              subagent={subagentBlockToItem(block)}
              index={index}
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
