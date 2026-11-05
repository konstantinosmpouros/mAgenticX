import * as React from "react";
import { CircleAlert, Clock, GitBranch, Timer } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowApprovalDecision,
  WorkflowDetailTab,
  WorkflowExecution,
} from "@/shared/lib/types";
import { DETAIL_TABS } from "@/features/workflows/lib/consts";
import {
  executionStateWrites,
  formatClock,
  formatDuration,
  hasContent,
} from "@/features/workflows/lib/format";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { ApprovalCard } from "./ApprovalCard";
import { JsonView } from "./JsonView";
import { StatusChip } from "./StatusChip";
import { ToolCallList } from "./ToolCallList";

type ExecutionDetailsProps = {
  execution: WorkflowExecution;
  label: string;
  kindLabel: string;
  onResume: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
  /** Hide the title row (the mobile sheet shows its own). */
  hideTitle?: boolean;
};

const STATE_EMPTY: Partial<Record<WorkflowExecution["status"], string>> = {
  running: "Nothing saved yet — the step is still running.",
  waiting: "Nothing saved yet — the step is waiting.",
  failed: "The step failed, so it saved nothing.",
  cancelled: "The step was cancelled, so it saved nothing.",
};

function StateTab({ execution }: { execution: WorkflowExecution }) {
  const writes = React.useMemo(() => executionStateWrites(execution), [execution]);
  if (!writes.length) {
    return (
      <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">
        {STATE_EMPTY[execution.status] ?? "This step saved nothing."}
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Saved to state">
      {writes.map((write, index) => (
        <li
          key={`${write.kind}-${write.path}-${index}`}
          className="rounded-xl border border-border/60 bg-card px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex-shrink-0 rounded-full bg-primary/[0.1] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-primary">
              {write.action}
            </span>
            <code className="min-w-0 truncate font-mono text-[12px] text-foreground" title={write.path}>
              {write.path}
            </code>
          </div>
          {write.note ? (
            <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">{write.note}</p>
          ) : null}
          {write.hasValue ? (
            <JsonView value={write.value} openDepth={1} className="mt-1.5" emptyText="(empty)" />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * One execution's details: its header (node, id, status, timing, branch), its
 * error, the approval it waits on, and tabs — Input (the resolved config it
 * ran with), Output (streamed text and the output), State (what it saved:
 * its result, an llm turn, declared fields), Tool calls (the chat's tool
 * views). The chosen tab is kept when
 * another execution is selected, so stepping through a loop compares like
 * with like.
 */
export function ExecutionDetails({
  execution,
  label,
  kindLabel,
  onResume,
  hideTitle = false,
}: ExecutionDetailsProps) {
  const [tab, setTab] = React.useState<WorkflowDetailTab>("output");
  const meta = EXECUTION_STATUS_META[execution.status];
  const tabsId = React.useId();
  const tablistRef = React.useRef<HTMLDivElement>(null);
  const duration = formatDuration(execution.durationMs);

  const counts: Partial<Record<WorkflowDetailTab, number>> = {
    tools: execution.toolCalls.length,
  };

  const focusTab = (offset: number) => {
    const index = DETAIL_TABS.findIndex((entry) => entry.id === tab);
    const next = DETAIL_TABS[(index + offset + DETAIL_TABS.length) % DETAIL_TABS.length];
    setTab(next.id);
    Array.from(tablistRef.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])
      .find((element) => element.id === `${tabsId}-tab-${next.id}`)
      ?.focus();
  };

  return (
    <section aria-label={`Execution ${execution.executionId}`} className="min-w-0 space-y-4">
      {!hideTitle ? (
        <header className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground">
              {label}
            </h3>
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {execution.executionId}
            </code>
            <StatusChip meta={meta} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {kindLabel ? <span>{kindLabel}</span> : null}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden />
              {formatClock(execution.startedAt)}
            </span>
            {duration ? (
              <span className="inline-flex items-center gap-1">
                <Timer className="h-3 w-3" aria-hidden />
                {duration}
              </span>
            ) : null}
            {execution.branch ? (
              <span className="inline-flex items-center gap-1 text-primary">
                <GitBranch className="h-3 w-3" aria-hidden />
                {execution.branch}
              </span>
            ) : null}
          </p>
        </header>
      ) : null}

      {execution.error ? (
        <div
          role="alert"
          className="flex gap-2.5 rounded-2xl border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-destructive">
              {execution.error.code ? (
                <code className="mr-1.5 font-mono text-[12px]">{execution.error.code}</code>
              ) : null}
              Failed
            </p>
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]">
              {execution.error.message}
            </p>
          </div>
        </div>
      ) : null}

      {execution.status === "waiting" && execution.approval ? (
        <ApprovalCard
          key={execution.executionId}
          approval={execution.approval}
          onResolve={onResume}
        />
      ) : null}

      <div>
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Execution details"
          className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto overflow-y-hidden px-1 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              focusTab(event.key === "ArrowRight" ? 1 : -1);
            }
          }}
        >
          {DETAIL_TABS.map((entry) => {
            const active = entry.id === tab;
            const count = counts[entry.id];
            return (
              <button
                key={entry.id}
                id={`${tabsId}-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${tabsId}-panel`}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(entry.id)}
                className={cn(
                  "relative inline-flex min-h-[2.5rem] flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground supports-[hover:hover]:hover:text-foreground",
                )}
              >
                {entry.label}
                {count ? (
                  <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${tab}`}
          tabIndex={0}
          className="pt-3 focus-visible:outline-none"
        >
          {tab === "input" ? (
            <JsonView
              value={execution.input}
              title="Input"
              emptyText="This node ran with no input."
            />
          ) : null}
          {tab === "output" ? (
            <div className="space-y-3">
              {execution.text ? (
                <section aria-label="Streamed text">
                  <h4 className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Text
                  </h4>
                  <p className="slim-scrollbar max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 px-3 py-2.5 text-[13px] leading-6 text-foreground">
                    {execution.text}
                  </p>
                </section>
              ) : null}
              {hasContent(execution.output) || !execution.text ? (
                <JsonView
                  value={execution.output}
                  title="Output"
                  emptyText={execution.status === "running" ? "Still running…" : "No output."}
                />
              ) : null}
            </div>
          ) : null}
          {tab === "state" ? <StateTab execution={execution} /> : null}
          {tab === "tools" ? <ToolCallList calls={execution.toolCalls} /> : null}
        </div>
      </div>
    </section>
  );
}
