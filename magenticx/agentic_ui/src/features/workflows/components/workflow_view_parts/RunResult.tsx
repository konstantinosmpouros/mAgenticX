import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Ban, CircleAlert, ListTree } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowApprovalDecision,
  WorkflowRun,
  WorkflowRunView,
  WorkflowTimelineRow,
} from "@/shared/lib/types";
import { formatDuration, formatTrigger, hasContent, runDurationMs } from "@/features/workflows/lib/format";
import { RUN_STATUS_META } from "@/features/workflows/lib/status";
import { VIEW_MOTION } from "@/features/workflows/lib/consts";
import { formatNumber, humanizeKey, valueShape } from "@/features/workflows/lib/valueView";
import { KindTile } from "../workflow_parts/KindTile";
import { ApprovalCard } from "./ApprovalCard";
import { CopyJsonButton } from "./JsonView";
import { StatusChip } from "./StatusChip";
import { Readable } from "./ValueView";

/** A short value that reads best as a tile: a number, yes / no, or a few words. */
const TILE_TEXT_MAX = 40;
const isTile = (value: unknown): boolean => {
  const shape = valueShape(value);
  return shape === "number" || shape === "boolean" || (shape === "text" && String(value).length <= TILE_TEXT_MAX);
};

/** Fades and lifts an item in, `order` items after the first (capped), unless motion is reduced. */
function Appear({ order = 0, className, children }: { order?: number; className?: string; children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: VIEW_MOTION.slow,
        ease: VIEW_MOTION.ease,
        delay: Math.min(order, VIEW_MOTION.staggerMax) * VIEW_MOTION.stagger,
      }}
    >
      {children}
    </motion.div>
  );
}

function Tile({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "number" ? formatNumber(value) : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  return (
    <div className="min-w-0 rounded-xl bg-muted/35 px-3.5 py-3 ring-1 ring-inset ring-border/40">
      <p className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground" title={label}>
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate font-semibold tabular-nums text-foreground",
          typeof value === "number" ? "text-[1.5rem] leading-8" : "text-[15px] leading-8",
        )}
        title={text}
      >
        {text}
      </p>
    </div>
  );
}

/** The run's output: short values as tiles, the rest (reports, lists) under their names. */
function Output({ output }: { output: unknown }) {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return <Readable value={output} depth={1} />;
  }
  const entries = Object.entries(output as Record<string, unknown>);
  const tiles = entries.filter(([, value]) => isTile(value));
  const blocks = entries.filter(([, value]) => !isTile(value) && hasContent(value));
  return (
    <div className="space-y-5">
      {tiles.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
          {tiles.map(([key, value], index) => (
            <Appear key={key} order={index} className="min-w-0">
              <Tile label={humanizeKey(key)} value={value} />
            </Appear>
          ))}
        </div>
      ) : null}
      {blocks.map(([key, value], index) => (
        <Appear key={key} order={tiles.length + index}>
          <section aria-label={humanizeKey(key)} className="min-w-0">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{humanizeKey(key)}</h4>
            <Readable value={value} depth={1} />
          </section>
        </Appear>
      ))}
    </div>
  );
}

/** A banner with a step to open: where a run failed, waits or is now. */
function StepBanner({
  tone,
  icon,
  title,
  row,
  children,
  onOpen,
}: {
  tone: "error" | "warning" | "live" | "muted";
  icon?: React.ReactNode;
  title: string;
  row?: WorkflowTimelineRow | null;
  children?: React.ReactNode;
  onOpen?: () => void;
}) {
  const tones = {
    error: "border-destructive/25 bg-destructive/[0.06]",
    warning: "border-warning/30 bg-warning/[0.06]",
    live: "border-primary/20 bg-primary/[0.05]",
    muted: "border-border/60 bg-muted/30",
  } as const;
  return (
    <div className={cn("min-w-0 rounded-2xl border px-4 py-3.5", tones[tone])}>
      <div className="flex min-w-0 items-start gap-3">
        {row ? <KindTile kind={row.kind} /> : icon}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">{title}</p>
          {row ? <p className="truncate text-[12.5px] text-muted-foreground">{row.label}</p> : null}
        </div>
        {row && onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
          >
            Open step
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}

/**
 * The run as its outcome: status, trigger, duration and version; then what
 * matters — the End step's output (short values as tiles, reports rendered),
 * where it failed (with the step to open), the approval it waits on, or the
 * step running now — and a way into the steps.
 */
export function RunResult({
  run,
  view,
  rows,
  now,
  onOpenStep,
  onShowSteps,
  onResume,
  showStepsLink = true,
}: {
  run: WorkflowRun;
  view: WorkflowRunView | null;
  rows: readonly WorkflowTimelineRow[];
  now: number;
  onOpenStep: (executionId: string) => void;
  onShowSteps: () => void;
  onResume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
  /** The "How it ran" link into the steps (the mobile feed lists them right below instead). */
  showStepsLink?: boolean;
}) {
  const meta = RUN_STATUS_META[run.status];
  const duration = formatDuration(runDurationMs(run, now));
  const output = view?.output;
  const runError = view?.runError ?? (run.status === "failed" && run.error ? { message: run.error, code: null } : null);
  const lastWith = (status: string) =>
    [...rows].reverse().find((row) => row.execution.status === status) ?? null;
  const failedRow = lastWith("failed");
  const waitingRow = [...rows].reverse().find((row) => row.execution.status === "waiting" && row.execution.approval) ?? null;
  const runningRow = lastWith("running");
  const done = rows.filter((row) => row.execution.status === "succeeded").length;
  const failedSteps = rows.filter((row) => row.execution.status === "failed").length;

  let body: React.ReactNode;
  if (run.status === "failed") {
    body = (
      <StepBanner
        tone="error"
        icon={<CircleAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" aria-hidden />}
        title={failedRow ? "The run failed at this step" : rows.length ? "The run failed" : "The run couldn't start"}
        row={failedRow}
        onOpen={failedRow ? () => onOpenStep(failedRow.execution.executionId) : undefined}
      >
        {failedRow || rows.length ? (
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]">
            {failedRow?.execution.error?.message ?? runError?.message ?? "No reason was given."}
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[12.5px] leading-5 text-foreground">
              The workflow engine stopped it before the first step, so nothing ran. Try running it again.
            </p>
            {runError?.message ? (
              <p className="break-words text-[11.5px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {runError.message}
              </p>
            ) : null}
          </div>
        )}
      </StepBanner>
    );
  } else if (run.status === "waiting" && waitingRow?.execution.approval) {
    body = (
      <StepBanner
        tone="warning"
        title="Waiting for your approval"
        row={waitingRow}
        onOpen={() => onOpenStep(waitingRow.execution.executionId)}
      >
        <ApprovalCard key={waitingRow.execution.executionId} approval={waitingRow.execution.approval} onResolve={onResume} />
      </StepBanner>
    );
  } else if (run.status === "queued" || run.status === "running" || run.status === "waiting") {
    body = (
      <StepBanner
        tone="live"
        icon={<meta.icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary motion-safe:animate-spin" aria-hidden />}
        title={runningRow ? "Running" : run.status === "queued" ? "Starting…" : "Running…"}
        row={runningRow}
        onOpen={runningRow ? () => onOpenStep(runningRow.execution.executionId) : undefined}
      >
        <p className="text-[12.5px] text-muted-foreground">
          {done} step{done === 1 ? "" : "s"} done so far. The result shows here when the run finishes.
        </p>
      </StepBanner>
    );
  } else if (run.status === "cancelled") {
    body = (
      <StepBanner
        tone="muted"
        icon={<Ban className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden />}
        title="The run was cancelled"
      >
        <p className="text-[12.5px] text-muted-foreground">It stopped before it finished, so there is no result.</p>
      </StepBanner>
    );
  } else {
    body = hasContent(output) ? (
      <Output output={output} />
    ) : (
      <p className="rounded-xl bg-muted/30 px-3.5 py-3 text-[12.5px] leading-5 text-muted-foreground">
        The run finished without a result. Give the End step outputs to see them here.
      </p>
    );
  }

  const stepsSummary =
    rows.length === 0
      ? null
      : failedSteps
        ? `${rows.length} steps · ${failedSteps} failed`
        : run.status === "succeeded"
          ? `${rows.length} steps · all succeeded`
          : `${rows.length} steps so far`;

  return (
    <section aria-label="Run result" className="min-w-0 space-y-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs tabular-nums text-muted-foreground">
        <StatusChip meta={meta} />
        <span>{formatTrigger(run.triggerKind)}</span>
        {duration ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">·</span>
            <span>{duration}</span>
          </>
        ) : null}
        {run.versionNo !== null ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">·</span>
            <span>v{run.versionNo}</span>
          </>
        ) : null}
        {run.status === "succeeded" && hasContent(output) ? (
          <span className="ml-auto">
            <CopyJsonButton value={output} label="Copy the result" />
          </span>
        ) : null}
      </div>

      <Appear key={`${run.id}:${run.status}`}>{body}</Appear>

      {stepsSummary && showStepsLink ? (
        <button
          type="button"
          onClick={onShowSteps}
          className="group flex w-full min-w-0 items-center gap-3 rounded-xl bg-muted/25 px-3.5 py-3 text-left ring-1 ring-inset ring-border/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
        >
          <ListTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-foreground">How it ran</span>
            <span className="block truncate text-xs text-muted-foreground">{stepsSummary}</span>
          </span>
          <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}
