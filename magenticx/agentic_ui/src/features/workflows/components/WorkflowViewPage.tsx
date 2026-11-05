import * as React from "react";
import { CircleAlert, MousePointerClick } from "lucide-react";

import { useIsMobile } from "@/shared/hooks/use-mobile";
import { cn } from "@/shared/lib/utils";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type {
  WorkflowExecutionPick,
  WorkflowInputDef,
  WorkflowViewPageProps,
} from "@/shared/lib/types";
import { useGraphSplit } from "@/features/workflows/hooks/useGraphSplit";
import { useWorkflow } from "@/features/workflows/hooks/useWorkflow";
import { useWorkflowRun } from "@/features/workflows/hooks/useWorkflowRun";
import { useWorkflowRuns } from "@/features/workflows/hooks/useWorkflowRuns";
import { useWorkflowSchedulePause } from "@/features/workflows/hooks/useWorkflowSchedulePause";
import { latestExecution } from "@/features/workflows/lib/graph";
import { isLiveRunStatus } from "@/features/workflows/lib/runStatus";
import { buildTimelineRows } from "@/features/workflows/lib/timeline";
import { ExecutionDetails } from "./workflow_view_parts/ExecutionDetails";
import { ExecutionTimeline } from "./workflow_view_parts/ExecutionTimeline";
import { RunInputDialog } from "./workflow_view_parts/RunInputDialog";
import { RunPicker } from "./workflow_view_parts/RunPicker";
import { SectionBoundary } from "./workflow_view_parts/SectionBoundary";
import {
  NoRunsState,
  RunSummary,
  WorkflowLoadError,
  WorkflowViewSkeleton,
} from "./workflow_view_parts/ViewStates";
import { WorkflowHeader } from "./workflow_view_parts/WorkflowHeader";

// The graph brings React Flow along: its own chunk, fetched when a workflow first opens.
const loadWorkflowGraph = () => import("./workflow_view_parts/WorkflowGraph");
const WorkflowGraph = React.lazy(loadWorkflowGraph);

/** Stable empty inputs, so the Run dialog does not reset its form on every render. */
const NO_INPUTS: WorkflowInputDef[] = [];

function GraphFallback() {
  return (
    <div
      className="absolute inset-0 grid place-items-center"
      aria-busy="true"
      aria-label="Loading graph"
    >
      <div className="flex flex-col items-center gap-6">
        <Skeleton className="h-16 w-56 rounded-[1.15rem]" />
        <Skeleton className="h-16 w-56 rounded-[1.15rem]" />
      </div>
    </div>
  );
}

function NoSelection() {
  return (
    <div className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
      <MousePointerClick className="h-5 w-5" aria-hidden />
      Select a step in the timeline or the graph to see its input, output and tool calls.
    </div>
  );
}

/**
 * The workflow view (plan 38, step 2), in place of the chat body: the header
 * (name, version, run picker, Cancel while live, Run ▸ with a form generated
 * from the spec's inputs), the graph with the run's overlay on top (the
 * larger share by default; the handle under it resizes the split, remembered
 * per device), the run's summary strip (status, error banner, final output), and below the
 * timeline on the left and the selected execution's details on the right. On
 * a phone the panes stack and a picked execution's details rise as a sheet.
 *
 * Selection: until the user picks an execution the view follows the newest
 * one (so a live run walks along by itself); a pick — a timeline row or a
 * graph node — stops following, "Follow live" resumes it. A pick belongs to
 * its run, so opening another run starts following again. `runId` null shows
 * the latest run.
 */
export function WorkflowViewPage({
  workflowId,
  runId,
  onSelectRun,
  onEdit,
}: WorkflowViewPageProps) {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const { workflow, catalog, isLoading, error, setSchedule } = useWorkflow(workflowId);
  const setSchedulePaused = useWorkflowSchedulePause();
  const [scheduleBusy, setScheduleBusy] = React.useState(false);
  const { runs, hasMore, loadMore, isLoading: runsLoading, startRun } = useWorkflowRuns(workflowId);
  const shownRunId = runId ?? runs[0]?.id ?? null;
  const { run, view, error: runError, resume, cancel } = useWorkflowRun(shownRunId);

  const [runDialogOpen, setRunDialogOpen] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [pick, setPick] = React.useState<WorkflowExecutionPick | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const graphSplit = useGraphSplit();

  const runIsLive = Boolean(run && isLiveRunStatus(run.status));

  // A clock for durations: every second while the run is live, else twice a minute.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), runIsLive ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [runIsLive]);

  const spec = workflow?.spec ?? null;
  const rows = React.useMemo(() => buildTimelineRows(view, spec, catalog), [view, spec, catalog]);
  const pickedId = pick && pick.runId === shownRunId ? pick.executionId : null;
  const following = pickedId === null;
  const selectedRow =
    (pickedId ? rows.find((row) => row.execution.executionId === pickedId) : null) ??
    rows[rows.length - 1] ??
    null;
  const selected = selectedRow?.execution ?? null;

  const choose = (executionId: string) => {
    if (!shownRunId) return;
    setPick({ runId: shownRunId, executionId });
    if (isMobile) setSheetOpen(true);
  };

  const chooseNode = (nodeId: string) => {
    const execution = latestExecution(view, nodeId);
    if (execution) choose(execution.executionId);
  };

  const handleStart = async (inputs: Record<string, unknown>) => {
    const newRunId = await startRun(inputs);
    setPick(null);
    onSelectRun(newRunId);
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancel();
    } catch (err) {
      toastError(toast, "Could not cancel the run", err);
    } finally {
      setCancelling(false);
    }
  };

  // Pause / resume from the header: shown at once, rolled back on failure.
  const handleSchedulePaused = async (paused: boolean) => {
    const current = workflow?.schedule;
    if (!current) return;
    setScheduleBusy(true);
    try {
      await setSchedulePaused(workflowId, current, paused, setSchedule);
    } catch (err) {
      toastError(
        toast,
        paused ? "Could not pause the schedule" : "Could not resume the schedule",
        err,
      );
    } finally {
      setScheduleBusy(false);
    }
  };

  if (isLoading && !workflow) return <WorkflowViewSkeleton />;
  if (error && !workflow) return <WorkflowLoadError message={error} />;
  if (!workflow) return <WorkflowViewSkeleton />;

  const name = spec?.name || workflow.name;
  const noRuns = !runsLoading && runs.length === 0;
  const details = selectedRow ? (
    <ExecutionDetails
      execution={selectedRow.execution}
      label={selectedRow.label}
      kindLabel={selectedRow.kindLabel}
      passes={selectedRow.passes}
      onResume={resume}
    />
  ) : (
    <NoSelection />
  );

  let lower: React.ReactNode;
  if (noRuns) {
    lower = <NoRunsState onRun={() => setRunDialogOpen(true)} />;
  } else if (runsLoading && runs.length === 0) {
    lower = (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading runs">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={`run-skeleton-${index}`} className="flex items-center gap-3">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-10 flex-1 rounded-xl" />
          </div>
        ))}
      </div>
    );
  } else {
    lower = (
      <div className="grid h-full min-h-0 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <div className="min-h-0 md:border-r md:border-border/60">
          <SectionBoundary label="timeline">
            <ExecutionTimeline
              rows={rows}
              selectedId={selected?.executionId ?? null}
              onSelect={choose}
              following={following}
              onFollow={() => setPick(null)}
              isLive={runIsLive}
            />
          </SectionBoundary>
        </div>
        {!isMobile ? (
          <div className="slim-scrollbar hidden min-h-0 overflow-y-auto overflow-x-hidden px-5 py-4 md:block">
            <SectionBoundary label="details">{details}</SectionBoundary>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-background">
        <WorkflowHeader
          name={name}
          description={spec?.description || workflow.description}
          versionNo={workflow.latestVersionNo}
          picker={
            runs.length ? (
              <RunPicker
                runs={runs}
                selectedRunId={shownRunId}
                onSelect={onSelectRun}
                hasMore={hasMore}
                loadingMore={runsLoading}
                onLoadMore={loadMore}
                now={now}
              />
            ) : null
          }
          onCancel={runIsLive ? () => void handleCancel() : undefined}
          cancelling={cancelling}
          onRun={() => setRunDialogOpen(true)}
          runDisabled={!spec}
          onEdit={onEdit}
          schedule={workflow.schedule ?? null}
          now={now}
          onSetSchedulePaused={(paused) => void handleSchedulePaused(paused)}
          scheduleBusy={scheduleBusy}
        />

        {runError ? (
          <p
            role="alert"
            className="mx-4 mt-2 flex flex-shrink-0 items-center gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive sm:mx-6"
          >
            <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {runError}
          </p>
        ) : null}

        <div ref={graphSplit.areaRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="relative min-h-[13rem] flex-shrink-0 bg-muted/[0.18]"
            style={{ height: isMobile ? "42%" : `${(graphSplit.split * 100).toFixed(1)}%` }}
            data-testid="workflow-graph-pane"
          >
            {spec ? (
              <SectionBoundary label="graph">
                <React.Suspense fallback={<GraphFallback />}>
                  <WorkflowGraph
                    spec={spec}
                    schedule={workflow.schedule ?? null}
                    view={shownRunId ? view : null}
                    catalog={catalog}
                    selectedNodeId={selected?.nodeId ?? null}
                    onSelectNode={chooseNode}
                  />
                </React.Suspense>
              </SectionBoundary>
            ) : (
              <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
                This workflow has no definition yet.
              </p>
            )}
          </div>
          {isMobile ? (
            <div className="h-px flex-shrink-0 bg-border/60" aria-hidden />
          ) : (
            <div
              {...graphSplit.separatorProps}
              className="group relative z-10 -my-1.5 flex h-3 flex-shrink-0 cursor-row-resize items-center focus-visible:outline-none"
            >
              <span
                className={cn(
                  "h-px w-full bg-border/60 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
                  graphSplit.dragging && "bg-primary",
                )}
                aria-hidden
              />
              <span
                className="absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/25 transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary"
                aria-hidden
              />
            </div>
          )}

          <RunSummary run={run} view={run ? view : null} now={now} />

          <div className="min-h-[8rem] flex-1 overflow-hidden">{lower}</div>
        </div>
      </div>

      <RunInputDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        workflowName={name}
        inputs={spec?.inputs ?? NO_INPUTS}
        onStart={handleStart}
      />

      {isMobile ? (
        <Sheet open={sheetOpen && Boolean(selectedRow)} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            aria-describedby={undefined}
            className="slim-scrollbar max-h-[85dvh] overflow-y-auto overflow-x-hidden rounded-t-[1.6rem] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5"
          >
            <SheetTitle className="sr-only">
              {selectedRow
                ? selectedRow.passes > 1
                  ? `${selectedRow.label} · pass ${selectedRow.execution.iteration}`
                  : selectedRow.label
                : "Step details"}
            </SheetTitle>
            <SectionBoundary label="details">{details}</SectionBoundary>
          </SheetContent>
        </Sheet>
      ) : null}
    </TooltipProvider>
  );
}

export default WorkflowViewPage;
