import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowApprovalDecision,
  WorkflowRun,
  WorkflowRunView,
  WorkflowTimelineRow,
} from "@/shared/lib/types";
import { formatDuration } from "@/features/workflows/lib/format";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { outputSummary } from "@/features/workflows/lib/valueView";
import { VIEW_MOTION } from "@/features/workflows/lib/consts";
import { StepTile } from "../workflow_parts/KindTile";
import { ExecutionDetails } from "./ExecutionDetails";
import { RunResult } from "./RunResult";

/** A card's element by execution id (ids come from the server: no selector strings). */
const cardElement = (list: HTMLElement | null, executionId: string): HTMLElement | null =>
  Array.from(list?.querySelectorAll<HTMLElement>("[data-feed-id]") ?? []).find(
    (element) => element.dataset.feedId === executionId,
  ) ?? null;

function FeedStep({
  row,
  order,
  open,
  onToggle,
  onResume,
}: {
  row: WorkflowTimelineRow;
  /** Its place in the list, for the staggered entrance. */
  order: number;
  open: boolean;
  onToggle: () => void;
  onResume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
}) {
  const { execution } = row;
  const meta = EXECUTION_STATUS_META[execution.status];
  const duration = formatDuration(execution.durationMs);
  const summary =
    execution.status === "failed"
      ? execution.error?.message ?? "Failed"
      : execution.status === "running"
        ? "Running…"
        : execution.status === "waiting"
          ? "Waiting for approval"
          : outputSummary(execution.output, execution.text);
  const panelId = React.useId();
  const reduceMotion = useReducedMotion();
  return (
    <motion.li
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: VIEW_MOTION.slow,
        ease: VIEW_MOTION.ease,
        delay: Math.min(order, VIEW_MOTION.staggerMax) * VIEW_MOTION.stagger,
      }}
      data-feed-id={execution.executionId}
      className={cn(
        "min-w-0 scroll-mt-3 rounded-2xl border bg-card/50 transition-[background-color,border-color,box-shadow] duration-300",
        open ? "border-primary/25 bg-card shadow-[0_12px_32px_-22px_hsl(var(--primary)/0.6)]" : "border-border/60",
      )}
      style={row.depth ? { marginLeft: `${Math.min(row.depth, 3) * 0.75}rem` } : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <StepTile kind={row.kind} status={execution.status} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">{row.label}</span>
            {row.passes > 1 ? (
              <span className="flex-shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] tabular-nums text-muted-foreground">
                Run {execution.iteration}
              </span>
            ) : null}
            <span className="sr-only">{meta.label}</span>
          </span>
          {summary ? (
            <span
              className={cn(
                "block truncate text-[12px]",
                execution.status === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {summary}
            </span>
          ) : null}
        </span>
        {duration ? (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">{duration}</span>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            open && "rotate-180",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="details"
            id={panelId}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : VIEW_MOTION.slow, ease: VIEW_MOTION.ease }}
            className="min-w-0 overflow-hidden"
          >
            <div className="min-w-0 border-t border-border/60 px-3 pb-3 pt-3">
              <ExecutionDetails
                execution={execution}
                label={row.label}
                kind={row.kind}
                kindLabel={row.kindLabel}
                passes={row.passes}
                onResume={onResume}
                hideTitle
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  );
}

/**
 * The run as a conversation-like feed (the phone's panel): the result first,
 * then every step as a card with what it produced in one line, opening in
 * place to its full details. `openId` is the step opened from the graph: it
 * opens and scrolls into view.
 */
export function RunFeed({
  run,
  view,
  rows,
  now,
  openId,
  onResume,
}: {
  run: WorkflowRun;
  view: WorkflowRunView | null;
  rows: readonly WorkflowTimelineRow[];
  now: number;
  openId: string | null;
  onResume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
}) {
  const listRef = React.useRef<HTMLOListElement>(null);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set(openId ? [openId] : []));

  const reveal = React.useCallback((executionId: string) => {
    setOpen((current) => new Set([...current, executionId]));
    window.requestAnimationFrame(() =>
      cardElement(listRef.current, executionId)?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  }, []);

  React.useEffect(() => {
    if (openId) reveal(openId);
  }, [openId, reveal]);

  const toggle = (executionId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(executionId)) next.delete(executionId);
      else next.add(executionId);
      return next;
    });

  return (
    <div className="min-w-0 space-y-6">
      <RunResult
        run={run}
        view={view}
        rows={rows}
        now={now}
        onOpenStep={reveal}
        onShowSteps={() => undefined}
        onResume={onResume}
        showStepsLink={false}
      />
      {rows.length ? (
        <section aria-label="Steps" className="min-w-0">
          <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-foreground">
            How it ran
            <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
              {rows.length}
            </span>
          </h3>
          <ol ref={listRef} className="min-w-0 space-y-2">
            {rows.map((row, index) => (
              <FeedStep
                key={row.execution.executionId}
                row={row}
                order={index}
                open={open.has(row.execution.executionId)}
                onToggle={() => toggle(row.execution.executionId)}
                onResume={onResume}
              />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
