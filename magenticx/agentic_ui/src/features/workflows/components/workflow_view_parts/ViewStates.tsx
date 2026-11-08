import { CircleAlert, Play, Workflow as WorkflowIcon } from "lucide-react";

import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import { PRIMARY_BUTTON } from "@/features/workflows/lib/consts";

/** The whole view while the workflow loads: header, graph, timeline rows, details. */
export function WorkflowViewSkeleton() {
  return (
    <div
      className="flex h-full flex-col bg-background"
      aria-busy="true"
      aria-label="Loading workflow"
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-border/60 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="hidden h-10 w-10 rounded-xl sm:block" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-72 max-w-[60vw]" />
          </div>
        </div>
        <Skeleton className="h-10 w-24 rounded-full" />
      </div>
      <div className="relative h-[45%] min-h-[14rem] flex-shrink-0 border-b border-border/60">
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-6">
            <Skeleton className="h-16 w-56 rounded-[1.15rem]" />
            <Skeleton className="h-16 w-56 rounded-[1.15rem]" />
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 p-4 md:grid-cols-[minmax(16rem,22rem)_1fr]">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={`row-${index}`} className="flex items-center gap-3">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-10 flex-1 rounded-xl" />
            </div>
          ))}
        </div>
        <div className="hidden space-y-3 md:block">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** The workflow could not be loaded (missing, no access, network). */
export function WorkflowLoadError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center"
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-destructive/[0.1] text-destructive">
        <CircleAlert className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="text-base font-semibold text-foreground">This workflow could not be opened</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** No run yet: what a run is, and the Run button to start the first. */
export function NoRunsState({ onRun }: { onRun: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <WorkflowIcon className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="text-base font-semibold text-foreground">No runs yet</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Run the workflow to watch each node light up as it works. Every run is kept, with each
        step&apos;s input, output and tool calls, so you can come back to it later.
      </p>
      <button type="button" onClick={onRun} className={cn(PRIMARY_BUTTON, "mt-1")}>
        <Play className="h-4 w-4" aria-hidden />
        Run it now
      </button>
    </div>
  );
}
