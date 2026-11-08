import * as React from "react";
import { CircleAlert, Flag } from "lucide-react";

import { useIsMobile } from "@/shared/hooks/use-mobile";
import { cn } from "@/shared/lib/utils";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import type {
  WorkflowExecutionPick,
  WorkflowInputDef,
  WorkflowRunPanelTab,
  WorkflowViewPageProps,
} from "@/shared/lib/types";
import { useWorkflow } from "@/features/workflows/hooks/useWorkflow";
import { useWorkflowRun } from "@/features/workflows/hooks/useWorkflowRun";
import { useWorkflowRuns } from "@/features/workflows/hooks/useWorkflowRuns";
import { useWorkflowSchedulePause } from "@/features/workflows/hooks/useWorkflowSchedulePause";
import { useWorkflowMutations } from "@/features/workflows/hooks/useWorkflowMutations";
import { useRunPanelWidth } from "@/features/workflows/hooks/useRunPanelWidth";
import { latestExecution } from "@/features/workflows/lib/graph";
import { isLiveRunStatus } from "@/features/workflows/lib/runStatus";
import { RUN_STATUS_META } from "@/features/workflows/lib/status";
import { buildTimelineRows } from "@/features/workflows/lib/timeline";
import { RunFeed } from "./workflow_view_parts/RunFeed";
import { RunInputDialog } from "./workflow_view_parts/RunInputDialog";
import { RunPanel } from "./workflow_view_parts/RunPanel";
import { RunPicker } from "./workflow_view_parts/RunPicker";
import { SectionBoundary } from "./workflow_view_parts/SectionBoundary";
import { StatusIcon } from "./workflow_view_parts/StatusChip";
import {
  NoRunsState,
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

/**
 * The workflow view (plan 38, step 2), in place of the chat body: the header
 * (name, run picker, Cancel while live, Run ▸ with a form generated from the
 * spec's inputs), then the graph across the full height with the run's
 * overlay, and beside it the run panel — **Result** first (what the run
 * produced, where it failed or waits), **Steps** for the timeline and each
 * step's details (a graph node opens its step there). On a phone the graph
 * takes the screen; a "Result" button and a tapped node open the run as a
 * feed in a sheet — the result, then the steps as cards opening in place.
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
  onHistory,
  onDeleted,
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
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const { remove: removeWorkflow } = useWorkflowMutations();
  const [pick, setPick] = React.useState<WorkflowExecutionPick | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [panelTab, setPanelTab] = React.useState<WorkflowRunPanelTab>("result");
  const [stepOpen, setStepOpen] = React.useState(false);
  /** The step a tapped node opens in the phone's feed. */
  const [feedOpenId, setFeedOpenId] = React.useState<string | null>(null);
  const panelWidth = useRunPanelWidth();

  // Another run opens on its result.
  React.useEffect(() => {
    setPanelTab("result");
    setStepOpen(false);
    setFeedOpenId(null);
  }, [shownRunId]);

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
    if (isMobile) {
      setFeedOpenId(executionId);
      setSheetOpen(true);
    } else {
      setPanelTab("steps");
      setStepOpen(true);
    }
  };

  const chooseNode = (nodeId: string) => {
    const execution = latestExecution(view, nodeId);
    if (execution) choose(execution.executionId);
  };

  const handleStart = async (inputs: Record<string, unknown>) => {
    const newRunId = await startRun(inputs);
    setPick(null);
    setPanelTab("result");
    setStepOpen(false);
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

  // Delete from the ⋯ menu, after the confirm: the dialog stays open (and
  // says why) if it fails; on success the caller leaves the gone workflow.
  const handleDelete = async () => {
    try {
      await removeWorkflow(workflowId);
    } catch (err) {
      toastError(toast, "The workflow wasn't deleted", err);
      throw err;
    }
    toast({ title: "Workflow deleted" });
    onDeleted?.();
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

  let panel: React.ReactNode;
  if (noRuns) {
    panel = <NoRunsState onRun={() => setRunDialogOpen(true)} />;
  } else if (!run) {
    panel = (
      <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading the run">
        <Skeleton className="h-8 w-40 rounded-xl" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  } else {
    panel = (
      <RunPanel
        run={run}
        view={view}
        rows={rows}
        now={now}
        tab={panelTab}
        onTab={(next) => {
          setPanelTab(next);
          if (next === "result") setStepOpen(false);
        }}
        selectedRow={selectedRow}
        stepOpen={stepOpen}
        onOpenStep={choose}
        onCloseStep={() => setStepOpen(false)}
        following={following}
        onFollow={() => setPick(null)}
        isLive={runIsLive}
        onResume={resume}
      />
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-background">
        <WorkflowHeader
          name={name}
          description={spec?.description || workflow.description}
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
          onHistory={onHistory}
          onDelete={onDeleted ? () => setConfirmDelete(true) : undefined}
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

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="relative min-w-0 flex-1 bg-muted/[0.18]" data-testid="workflow-graph-pane">
            {spec ? (
              <SectionBoundary label="graph">
                <React.Suspense fallback={<GraphFallback />}>
                  <WorkflowGraph
                    spec={spec}
                    schedule={workflow.schedule ?? null}
                    view={shownRunId ? view : null}
                    catalog={catalog}
                    selectedNodeId={stepOpen || sheetOpen ? selected?.nodeId ?? null : null}
                    onSelectNode={chooseNode}
                  />
                </React.Suspense>
              </SectionBoundary>
            ) : (
              <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
                This workflow has no definition yet.
              </p>
            )}
            {isMobile && run ? (
              <button
                type="button"
                onClick={() => {
                  setFeedOpenId(null);
                  setSheetOpen(true);
                }}
                className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-10 inline-flex items-center gap-2 rounded-full bg-primary motion-safe:duration-300 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:slide-in-from-bottom-3 px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground shadow-[0_10px_28px_-10px_hsl(var(--primary)/0.9)] transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {run.status === "succeeded" ? (
                  <Flag className="h-4 w-4" aria-hidden />
                ) : (
                  <StatusIcon meta={RUN_STATUS_META[run.status]} className="h-4 w-4 text-primary-foreground" />
                )}
                Result
              </button>
            ) : null}
            {isMobile && noRuns ? (
              <div className="absolute inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 rounded-2xl border border-border/60 bg-background/95 shadow-lg backdrop-blur">
                <NoRunsState onRun={() => setRunDialogOpen(true)} />
              </div>
            ) : null}
          </div>
          {!isMobile ? (
            <aside
              ref={panelWidth.panelRef}
              aria-label="Run"
              className={cn(
                "relative flex min-w-0 flex-shrink-0 flex-col border-l border-border/60 bg-background",
                !panelWidth.dragging &&
                  "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              )}
              style={{ width: panelWidth.width }}
            >
              <div
                {...panelWidth.separatorProps}
                className="group absolute inset-y-0 -left-1.5 z-20 flex w-3 cursor-col-resize justify-center focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-full w-px bg-transparent transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
                    panelWidth.dragging && "bg-primary",
                  )}
                />
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-muted-foreground/25 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                    panelWidth.dragging && "opacity-100",
                  )}
                />
              </div>
              {panel}
            </aside>
          ) : null}
        </div>
      </div>

      <RunInputDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        workflowName={name}
        inputs={spec?.inputs ?? NO_INPUTS}
        onStart={handleStart}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${name.trim() || "this workflow"}”?`}
        description="Its versions and its whole run history go with it. Live runs are cancelled. This can't be undone."
        confirmLabel="Delete workflow"
        onConfirm={handleDelete}
      />

      {isMobile && run ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            aria-describedby={undefined}
            className="slim-scrollbar h-[88dvh] overflow-y-auto overflow-x-hidden rounded-t-[1.6rem] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6"
          >
            <SheetTitle className="mb-4 text-base font-semibold">{name}</SheetTitle>
            <SectionBoundary label="run">
              <RunFeed run={run} view={view} rows={rows} now={now} openId={feedOpenId} onResume={resume} />
            </SectionBoundary>
          </SheetContent>
        </Sheet>
      ) : null}
    </TooltipProvider>
  );
}

export default WorkflowViewPage;
