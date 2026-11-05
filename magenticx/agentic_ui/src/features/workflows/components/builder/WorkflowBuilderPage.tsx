import * as React from "react";
import { Loader2 } from "lucide-react";

import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Workflow, WorkflowBuilderPageProps, WorkflowSpec } from "@/shared/lib/types";
import { useWorkflow } from "@/features/workflows/hooks/useWorkflow";
import { useSidebarFocusMode } from "@/features/workflows/hooks/useSidebarFocusMode";
import { useWorkflowCatalog } from "@/features/workflows/hooks/useWorkflowCatalog";
import { newWorkflowSpec } from "@/features/workflows/lib/builder/draft";
import { WorkflowLoadError } from "../workflow_view_parts/ViewStates";
import { WorkflowBuilderWorkspace } from "./WorkflowBuilderWorkspace";

/**
 * `/workflows/new` and `/workflows/:workflowId/edit` (plan 38, step 3).
 *
 * Gathers what the builder starts from — the workflow's saved spec (edit) or
 * a new, empty one (no name, no steps), and the step catalogue — and wires
 * where it goes after. A create moves the URL to the new workflow's edit
 * route without remounting the builder: the workflow it just made is kept
 * here, so the edit route does not load it again.
 *
 * Focus mode: while the builder is open the app sidebar is collapsed, so the
 * canvas gets the width (still toggleable; restored on leave).
 */
export function WorkflowBuilderPage({
  workflowId,
  onSaved,
  onCreated,
  onOpenView,
  onDeleted,
  onExit,
}: WorkflowBuilderPageProps) {
  useSidebarFocusMode();
  const catalog = useWorkflowCatalog();
  // The workflow this page created: the edit route that follows is already open.
  const [created, setCreated] = React.useState<Workflow | null>(null);
  const continuing = Boolean(workflowId && created?.id === workflowId);
  const { workflow, isLoading, error } = useWorkflow(continuing ? "" : (workflowId ?? ""));
  const [fresh] = React.useState<WorkflowSpec>(() => newWorkflowSpec());

  const handleSaved = React.useCallback(
    (saved: Workflow | null) => {
      onSaved();
      if (saved && !workflowId) setCreated(saved);
    },
    [onSaved, workflowId],
  );

  if (workflowId && !continuing) {
    if (error && !workflow) return <WorkflowLoadError message={error} />;
    if (isLoading || !workflow) return <PageLoading />;
  }

  const editing = workflowId && !continuing ? workflow : null;
  const initialSpec: WorkflowSpec = editing?.spec ?? (editing ? { ...fresh, name: editing.name } : fresh);
  // One builder from the new page through its first save: same key, no remount.
  const key = editing ? `edit:${editing.id}` : "draft";

  return (
    <TooltipProvider delayDuration={200}>
      <WorkflowBuilderWorkspace
        key={key}
        workflowId={editing?.id ?? created?.id ?? null}
        initialSpec={initialSpec}
        savedVersion={editing?.latestVersionNo ?? created?.latestVersionNo ?? null}
        initialSchedule={editing?.schedule ?? created?.schedule ?? null}
        catalog={catalog.catalog}
        catalogLoading={catalog.isLoading}
        catalogError={catalog.error}
        onRetryCatalog={catalog.retry}
        backLabel={editing ? editing.name : "Back"}
        onExit={() => onExit(editing?.id ?? created?.id ?? null)}
        onSaved={handleSaved}
        onCreated={onCreated}
        onOpenView={onOpenView}
        onDeleted={onDeleted}
      />
    </TooltipProvider>
  );
}

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground" aria-busy="true" aria-label="Loading workflow">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}

export default WorkflowBuilderPage;
