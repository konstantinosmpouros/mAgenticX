import { ChevronDown, History, Loader2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import type { WorkflowRun } from "@/shared/lib/types";
import { SECONDARY_BUTTON } from "@/features/workflows/lib/consts";
import { formatRelativeTime, formatTrigger } from "@/features/workflows/lib/format";
import { RUN_STATUS_META } from "@/features/workflows/lib/status";
import { StatusIcon } from "./StatusChip";

type RunPickerProps = {
  runs: WorkflowRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  now: number;
};

/**
 * The header's run picker: the selected run on the button (status icon and
 * when), the runs newest first in the menu — status, time, trigger — and
 * "Load more" at the foot, which keeps the menu open.
 */
export function RunPicker({
  runs,
  selectedRunId,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
  now,
}: RunPickerProps) {
  const selected = runs.find((run) => run.id === selectedRunId) ?? null;
  const selectedMeta = selected ? RUN_STATUS_META[selected.status] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // The one button of the header's row that gives way on a narrow
        // screen: its label truncates so Edit and Run always fit.
        className={cn(SECONDARY_BUTTON, "min-w-0 max-w-[16rem] flex-shrink")}
        aria-label={
          selected
            ? `Run from ${formatRelativeTime(selected.startedAt, now)}, change run`
            : "Choose a run"
        }
      >
        {selectedMeta ? (
          <StatusIcon meta={selectedMeta} />
        ) : (
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          {selected ? formatRelativeTime(selected.startedAt, now) : "Runs"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[80] max-h-[min(24rem,60dvh)] w-72 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Runs
        </DropdownMenuLabel>
        {runs.map((run) => {
          const meta = RUN_STATUS_META[run.status];
          const active = run.id === selectedRunId;
          return (
            <DropdownMenuItem
              key={run.id}
              onSelect={() => onSelect(run.id)}
              className={cn("min-h-[2.75rem] gap-2.5", active && "bg-primary/[0.08]")}
              aria-current={active ? "true" : undefined}
            >
              <StatusIcon meta={meta} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {formatRelativeTime(run.startedAt, now)}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {meta.label} · {formatTrigger(run.triggerKind)}
                  {run.versionNo !== null ? ` · v${run.versionNo}` : ""}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {hasMore ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                // Keep the menu open: the next page lands under the list.
                event.preventDefault();
                if (!loadingMore) onLoadMore();
              }}
              className="min-h-[2.5rem] justify-center gap-2 text-[13px] font-medium text-primary"
            >
              {loadingMore ? (
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
              ) : null}
              Load more
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
