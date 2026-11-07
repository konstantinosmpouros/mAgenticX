import { Loader2, Square } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { canStopTask } from "@/features/chat/lib/taskTreeAdapter";
import type { AsyncTaskDisplayStatus } from "@/shared/lib/types";

type TaskStopButtonProps = {
  /** The task's name, for the accessible label ("Stop researcher"). */
  name: string;
  status: AsyncTaskDisplayStatus | null;
  onStop: () => void;
  className?: string;
};

/**
 * Stop for one background task (plan 41 §3.9): cancels it and its whole
 * subtree. Shown on every active node — in the tree and in the drill-down's
 * header — and turns into a disabled "Stopping…" until the cancel lands; a
 * settled task has none. Like the composer's run Stop it asks no confirmation:
 * nothing is deleted, and the orchestrator can start the task again.
 *
 * The visible pill is 32px tall; the `after:` inset grows its hit area to the
 * 44px touch target without crowding the card's row.
 */
export function TaskStopButton({ name, status, onStop, className }: TaskStopButtonProps) {
  const stopping = status === "stopping";
  if (!stopping && !canStopTask(status)) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        // Inside a card that opens on click: stopping must not also open it.
        event.stopPropagation();
        onStop();
      }}
      disabled={stopping}
      aria-label={stopping ? `Stopping ${name}` : `Stop ${name}`}
      title={stopping ? "Stopping…" : "Stop this task and its sub-agents"}
      className={cn(
        "relative inline-flex h-8 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-background/80 px-2.5 text-xs font-medium text-muted-foreground",
        "transition-colors duration-150 after:absolute after:-inset-1.5 after:content-['']",
        "hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
        "disabled:cursor-default disabled:hover:border-border/70 disabled:hover:bg-background/80 disabled:hover:text-muted-foreground",
        className,
      )}
    >
      {stopping ? (
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Square className="h-3 w-3 fill-current" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{stopping ? "Stopping…" : "Stop"}</span>
    </button>
  );
}
