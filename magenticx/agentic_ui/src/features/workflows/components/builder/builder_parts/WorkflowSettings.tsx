import { Workflow as WorkflowIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowBuilderIssue, WorkflowDraftAction, WorkflowSpec } from "@/shared/lib/types";
import { INPUT } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { SCHEDULE_TRIGGER_KIND } from "@/features/workflows/lib/builder/schedule";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { Field, FieldIssues, SectionHeading } from "./FieldShell";
import { InputsEditor } from "./FieldListEditors";

/**
 * The inspector with nothing picked: the workflow itself — its name and
 * description and the run's inputs — and the issues that belong to no one
 * step (one trigger, an End step). Variables are not declared here: a Set
 * step creates one by writing it.
 */
export function WorkflowSettings({
  spec,
  dispatch,
  issues,
}: {
  spec: WorkflowSpec;
  dispatch: (action: WorkflowDraftAction, options?: { coalesce?: string }) => void;
  /** Workflow-level issues (`nodeId` null). */
  issues: readonly WorkflowBuilderIssue[];
}) {
  const nameId = fieldDomId(null, "name");
  const descriptionId = fieldDomId(null, "description");
  const general = issues.filter(
    (issue) => !["name", "description"].includes(issue.field) && !issueIsOn(issue, "inputs"),
  );
  const scheduled = spec.nodes.some((node) => node.kind === SCHEDULE_TRIGGER_KIND);
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <WorkflowIcon className="h-[17px] w-[17px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/80">Workflow</p>
          <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {spec.name.trim() || "Untitled workflow"}
          </h2>
        </div>
      </div>

      {general.length ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5" id={fieldDomId(null, "nodes")} tabIndex={-1}>
          <FieldIssues issues={general} />
        </div>
      ) : null}

      <div className="space-y-4">
        <Field label="Name" htmlFor={nameId} required issues={issues.filter((i) => i.field === "name")}>
          <input
            id={nameId}
            value={spec.name}
            onChange={(event) => dispatch({ type: "set-name", value: event.target.value }, { coalesce: "name" })}
            maxLength={120}
            placeholder="Name this workflow"
            className={INPUT}
          />
        </Field>
        <Field label="Description" htmlFor={descriptionId} issues={issues.filter((i) => i.field === "description")}>
          <textarea
            id={descriptionId}
            value={spec.description ?? ""}
            onChange={(event) => dispatch({ type: "set-description", value: event.target.value }, { coalesce: "description" })}
            maxLength={2000}
            rows={3}
            placeholder="What it does, for whoever runs it"
            className={cn(INPUT, "block resize-y leading-relaxed")}
          />
        </Field>
      </div>

      <section className="space-y-3">
        <SectionHeading
          title="Inputs"
          description={
            <>
              Asked for when a run starts; steps read them as <span className="font-mono">{"{{input.name}}"}</span>.
              {scheduled ? " A scheduled run uses each input's default." : null}
            </>
          }
        />
        <InputsEditor
          inputs={spec.inputs}
          onChange={(inputs) => dispatch({ type: "set-inputs", inputs }, { coalesce: "inputs" })}
          issues={issues}
        />
      </section>
    </div>
  );
}
