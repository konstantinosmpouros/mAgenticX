import * as React from "react";
import { ArrowDownToLine, GitBranch } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowTimelineRow } from "@/shared/lib/types";
import { formatDuration } from "@/features/workflows/lib/format";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { StatusIcon } from "./StatusChip";

/** A row's element by execution id (ids come from the server: no selector strings). */
const rowElement = (list: HTMLElement | null, executionId: string): HTMLElement | null =>
  Array.from(list?.querySelectorAll<HTMLElement>("[data-execution-id]") ?? []).find(
    (element) => element.dataset.executionId === executionId,
  ) ?? null;

/** Width of one lane, in rem: the dot sits centred in its lane. */
const LANE_REM = 1.1;

type ExecutionTimelineProps = {
  rows: WorkflowTimelineRow[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
  /** Whether the list follows the newest execution (live runs). */
  following: boolean;
  /** Shown while live and not following: jump back to the newest. */
  onFollow?: () => void;
  isLive: boolean;
};

/**
 * The run's executions as a git-graph-like list: one row per execution in the
 * order they started, a lane line down the left with a dot per row coloured
 * (and iconed) by status, and a loop's body indented one lane in under its
 * loop so the iterations read as a group. A listbox: arrows move, Enter or a
 * click selects. While the run is live the newest row scrolls into view, until
 * the user picks a row themselves.
 */
export function ExecutionTimeline({
  rows,
  selectedId,
  onSelect,
  following,
  onFollow,
  isLive,
}: ExecutionTimelineProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  // Keep the selected row in view (auto-follow moves it while live).
  React.useEffect(() => {
    if (!selectedId) return;
    rowElement(listRef.current, selectedId)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId, rows.length]);

  const moveSelection = (offset: number) => {
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.execution.executionId === selectedId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (index < 0 ? 0 : index) + offset))];
    onSelect(next.execution.executionId);
    rowElement(listRef.current, next.execution.executionId)?.focus();
  };

  return (
    <section aria-label="Execution timeline" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-[2.75rem] flex-shrink-0 items-center justify-between gap-2 px-4 pt-2">
        <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Timeline
          <span className="ml-1.5 tabular-nums normal-case tracking-normal text-muted-foreground/80">
            {rows.length ? `· ${rows.length}` : ""}
          </span>
        </h3>
        {isLive && !following && onFollow ? (
          <button
            type="button"
            onClick={onFollow}
            className="inline-flex min-h-[2rem] items-center gap-1 rounded-full px-2.5 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />
            Follow live
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {isLive ? "Waiting for the first node to start…" : "This run has no executions."}
        </p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Executions"
          className="slim-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {rows.map((row, index) => {
            const { execution } = row;
            const meta = EXECUTION_STATUS_META[execution.status];
            const selected = execution.executionId === selectedId;
            const first = index === 0;
            const last = index === rows.length - 1;
            const duration = formatDuration(execution.durationMs);
            return (
              <div
                key={execution.executionId}
                role="option"
                aria-selected={selected}
                tabIndex={selected || (!selectedId && first) ? 0 : -1}
                data-execution-id={execution.executionId}
                data-depth={row.depth}
                onClick={() => onSelect(execution.executionId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(execution.executionId);
                  }
                }}
                className={cn(
                  "group/row relative flex min-h-[3.25rem] cursor-pointer items-stretch rounded-xl pr-2 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  selected
                    ? "bg-primary/[0.08]"
                    : "supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]",
                )}
              >
                {/* Lanes: a line per level down to this row's own, its dot on the last. */}
                <span
                  aria-hidden
                  className="relative flex-shrink-0"
                  style={{ width: `${(row.depth + 1) * LANE_REM + 0.4}rem` }}
                >
                  {row.rails.map((level) => {
                    const own = level === row.depth;
                    return (
                      <span
                        key={level}
                        className={cn(
                          "absolute w-px",
                          own ? "bg-border" : "bg-border/70",
                          // The main lane starts at the first dot and ends at the last.
                          level === 0 && first ? "top-1/2" : "top-0",
                          level === 0 && last ? "bottom-1/2" : "bottom-0",
                        )}
                        style={{ left: `${level * LANE_REM + LANE_REM / 2 + 0.2}rem` }}
                      />
                    );
                  })}
                  {row.depth > 0 ? (
                    // The elbow from the parent lane into this row's lane.
                    <span
                      className="absolute top-1/2 h-px bg-border/70"
                      style={{
                        left: `${(row.depth - 1) * LANE_REM + LANE_REM / 2 + 0.2}rem`,
                        width: `${LANE_REM}rem`,
                      }}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "absolute top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background",
                      meta.dot,
                      selected && "ring-2 ring-primary/50",
                    )}
                    style={{ left: `${row.depth * LANE_REM + LANE_REM / 2 + 0.2}rem` }}
                  />
                </span>

                <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-1.5 pl-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                      {row.label}
                    </span>
                    {row.passes > 1 ? (
                      <span className="flex-shrink-0 rounded bg-muted/70 px-1.5 py-px text-[10.5px] tabular-nums text-muted-foreground">
                        pass {execution.iteration}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                    {row.kindLabel ? (
                      <span className="min-w-0 truncate">{row.kindLabel}</span>
                    ) : null}
                    {execution.branch ? (
                      <span className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full bg-primary/[0.08] px-1.5 text-primary">
                        <GitBranch className="h-2.5 w-2.5" aria-hidden />
                        {execution.branch}
                      </span>
                    ) : null}
                    {duration ? <span className="flex-shrink-0">{duration}</span> : null}
                  </span>
                </span>

                <span className="flex flex-shrink-0 items-center gap-1 pl-1" title={meta.label}>
                  <StatusIcon meta={meta} />
                  <span className="sr-only">{meta.label}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
