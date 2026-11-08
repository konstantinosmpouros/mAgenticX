import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowApprovalDecision,
  WorkflowRun,
  WorkflowRunPanelTab,
  WorkflowRunView,
  WorkflowTimelineRow,
} from "@/shared/lib/types";
import { ICON_BUTTON, VIEW_MOTION } from "@/features/workflows/lib/consts";
import { ExecutionDetails } from "./ExecutionDetails";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { RunResult } from "./RunResult";
import { SectionBoundary } from "./SectionBoundary";

type RunPanelProps = {
  run: WorkflowRun;
  view: WorkflowRunView | null;
  rows: readonly WorkflowTimelineRow[];
  now: number;
  tab: WorkflowRunPanelTab;
  onTab: (tab: WorkflowRunPanelTab) => void;
  /** The step shown in Steps (a pick, else the newest); its details open only when `stepOpen`. */
  selectedRow: WorkflowTimelineRow | null;
  stepOpen: boolean;
  onOpenStep: (executionId: string) => void;
  onCloseStep: () => void;
  following: boolean;
  onFollow: () => void;
  isLive: boolean;
  onResume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
};

const TABS: ReadonlyArray<{ id: WorkflowRunPanelTab; label: string }> = [
  { id: "result", label: "Result" },
  { id: "steps", label: "Steps" },
];

/**
 * Where a view sits, left to right — Result, the step list, then each step in
 * run order — so a change slides the way the user moved (forward from the
 * right, back from the left).
 */
const viewRank = (tab: WorkflowRunPanelTab, stepOpen: boolean, index: number) =>
  tab === "result" ? -2 : stepOpen ? index : -1;

/**
 * The run panel beside the graph: **Result** (the outcome, what matters) and
 * **Steps** (the timeline; a step — picked there or on the graph — opens its
 * details in place, with a way back and to its neighbours). The tab underline
 * glides, and views slide in the direction the user went.
 */
export function RunPanel({
  run,
  view,
  rows,
  now,
  tab,
  onTab,
  selectedRow,
  stepOpen,
  onOpenStep,
  onCloseStep,
  following,
  onFollow,
  isLive,
  onResume,
}: RunPanelProps) {
  const tabsId = React.useId();
  const reduceMotion = useReducedMotion();
  const index = selectedRow
    ? rows.findIndex((row) => row.execution.executionId === selectedRow.execution.executionId)
    : -1;
  const step = (offset: number) => {
    const next = rows[index + offset];
    if (next) onOpenStep(next.execution.executionId);
  };

  const rank = viewRank(tab, stepOpen && Boolean(selectedRow), index);
  const lastRank = React.useRef(rank);
  const direction = rank >= lastRank.current ? 1 : -1;
  React.useEffect(() => {
    lastRank.current = rank;
  }, [rank]);

  const viewKey =
    tab === "result" ? "result" : stepOpen && selectedRow ? `step:${selectedRow.execution.executionId}` : "steps";
  const shift = reduceMotion ? 0 : VIEW_MOTION.shift;
  const slide = {
    initial: { opacity: 0, x: direction * shift },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -direction * shift },
    transition: { duration: reduceMotion ? 0 : VIEW_MOTION.base, ease: VIEW_MOTION.ease },
  };

  let content: React.ReactNode;
  if (tab === "result") {
    content = (
      <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-8 pt-4">
        <SectionBoundary label="result">
          <RunResult
            run={run}
            view={view}
            rows={rows}
            now={now}
            onOpenStep={onOpenStep}
            onShowSteps={() => onTab("steps")}
            onResume={onResume}
          />
        </SectionBoundary>
      </div>
    );
  } else if (stepOpen && selectedRow) {
    content = (
      <>
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
          <button
            type="button"
            onClick={onCloseStep}
            className="group inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground"
          >
            <ArrowLeft
              className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5"
              aria-hidden
            />
            All steps
          </button>
          <span className="flex items-center gap-0.5">
            <span className="mr-1 text-xs tabular-nums text-muted-foreground">
              {index + 1} / {rows.length}
            </span>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Previous step"
              disabled={index <= 0}
              onClick={() => step(-1)}
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Next step"
              disabled={index < 0 || index >= rows.length - 1}
              onClick={() => step(1)}
            >
              <ChevronDown className="h-4 w-4" aria-hidden />
            </button>
          </span>
        </div>
        <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-8 pt-4">
          <SectionBoundary label="details">
            <ExecutionDetails
              execution={selectedRow.execution}
              label={selectedRow.label}
              kind={selectedRow.kind}
              kindLabel={selectedRow.kindLabel}
              passes={selectedRow.passes}
              onResume={onResume}
            />
          </SectionBoundary>
        </div>
      </>
    );
  } else {
    content = (
      <SectionBoundary label="timeline">
        <ExecutionTimeline
          rows={[...rows]}
          selectedId={null}
          onSelect={onOpenStep}
          following={following}
          onFollow={onFollow}
          isLive={isLive}
          showTitle={false}
        />
      </SectionBoundary>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Run"
        className="flex flex-shrink-0 items-end gap-5 border-b border-border/60 px-5"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next = TABS[(TABS.findIndex((entry) => entry.id === tab) + 1) % TABS.length];
          onTab(next.id);
          document.getElementById(`${tabsId}-${next.id}`)?.focus();
        }}
      >
        {TABS.map((entry) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              id={`${tabsId}-${entry.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${tabsId}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => onTab(entry.id)}
              className={cn(
                "relative inline-flex min-h-[3rem] items-center gap-1.5 text-[13.5px] font-medium transition-colors duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60",
                active ? "text-foreground" : "text-muted-foreground supports-[hover:hover]:hover:text-foreground",
              )}
            >
              {entry.label}
              {entry.id === "steps" && rows.length ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] tabular-nums transition-colors duration-200",
                    active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  {rows.length}
                </span>
              ) : null}
              {active ? (
                <motion.span
                  layoutId={`run-tab-${tabsId}`}
                  aria-hidden
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                  transition={
                    reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40, mass: 0.6 }
                  }
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}`}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={viewKey} className="flex min-h-0 flex-1 flex-col" {...slide}>
            {content}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
