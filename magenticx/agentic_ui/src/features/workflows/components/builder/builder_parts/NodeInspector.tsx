import * as React from "react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowNodeDef,
  WorkflowNodeKindInfo,
  WorkflowSpec,
} from "@/shared/lib/types";
import { kindMeta, humanizeKind } from "@/features/workflows/lib/kinds";
import { INPUT } from "@/features/workflows/lib/builder/consts";
import { fieldDomId, nodeIdProblem } from "@/features/workflows/lib/builder/ids";
import { SCHEDULE_TRIGGER_KIND } from "@/features/workflows/lib/builder/schedule";
import { templatePaths } from "@/features/workflows/lib/builder/templates";
import { issueIsOn, kindFields } from "@/features/workflows/lib/builder/validate";
import { Field, FieldIssues } from "./FieldShell";
import { ScheduleTriggerEditor } from "./ScheduleTriggerEditor";
import { SchemaForm } from "./SchemaForm";

/** The id field: edited freely, renamed (edges and references follow) when it is valid. */
function NodeIdField({
  nodeId,
  taken,
  onRename,
  issues,
}: {
  nodeId: string;
  taken: ReadonlySet<string>;
  onRename: (to: string) => void;
  issues: readonly WorkflowBuilderIssue[];
}) {
  const [text, setText] = React.useState(nodeId);
  React.useEffect(() => setText(nodeId), [nodeId]);
  const problem = text === nodeId ? null : nodeIdProblem(text, taken);
  const id = fieldDomId(nodeId, "id");
  const commit = () => {
    if (text === nodeId) return;
    if (problem) setText(nodeId);
    else onRename(text);
  };
  return (
    <Field
      label="Step id"
      htmlFor={id}
      issues={issues}
      hint={
        problem ? undefined : (
          <>
            Read by later steps as <span className="font-mono">{`{{nodes.${text || nodeId}.output}}`}</span>. Renaming
            updates its connections and the references to it.
          </>
        )
      }
    >
      <input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value.replace(/\s+/g, "_"))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setText(nodeId);
          }
        }}
        maxLength={64}
        spellCheck={false}
        aria-invalid={Boolean(problem) || undefined}
        className={cn(INPUT, "font-mono")}
      />
      {problem ? <p className="mt-1.5 text-xs text-destructive">{problem}</p> : null}
    </Field>
  );
}

/**
 * The inspector for one step: what kind it is, its id and label, its config
 * form (generated from the kind's schema), and its node-level issues
 * (connections, references) on top. A schedule trigger gets its own editor in
 * place of the generic form (its `assign` still from the schema). How a
 * workflow starts is the trigger step on the canvas: another start is another
 * trigger from the palette.
 */
export function NodeInspector({
  node,
  info,
  spec,
  issues,
  onRename,
  onLabel,
  onConfig,
}: {
  node: WorkflowNodeDef;
  info: WorkflowNodeKindInfo | null;
  spec: WorkflowSpec;
  /** This node's issues. */
  issues: readonly WorkflowBuilderIssue[];
  onRename: (to: string) => void;
  onLabel: (label: string) => void;
  onConfig: (config: Record<string, unknown>, cases?: WorkflowCasesChange) => void;
}) {
  const meta = kindMeta(node.kind);
  const Glyph = meta.icon;
  const fields = React.useMemo(() => (info ? kindFields(info) : []), [info]);
  const paths = React.useMemo(() => templatePaths(spec, node.id), [spec, node.id]);
  const assignPaths = React.useMemo(() => templatePaths(spec, node.id, { inAssign: true }), [spec, node.id]);
  const taken = React.useMemo(
    () => new Set([...spec.nodes.map((other) => other.id).filter((id) => id !== node.id), ...spec.state.map((f) => f.name)]),
    [spec.nodes, spec.state, node.id],
  );
  const general = issues.filter(
    (issue) => !issueIsOn(issue, "config") || issue.field === "config",
  ).filter((issue) => issue.field !== "id" && issue.field !== "label");
  const labelId = fieldDomId(node.id, "label");
  const isSchedule = node.kind === SCHEDULE_TRIGGER_KIND;
  // The schedule trigger's own editor covers everything but `assign`.
  const formFields = isSchedule ? fields.filter((field) => field.key === "assign") : fields;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: `hsl(${meta.accent} / 0.12)`, color: `hsl(${meta.accent})` }}
        >
          <Glyph className="h-[17px] w-[17px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/80">
            {info?.label ?? humanizeKind(node.kind)}
          </p>
          <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {node.label?.trim() || node.id}
          </h2>
          {info?.description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{info.description}</p>
          ) : null}
        </div>
      </div>

      {general.length ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5" id={fieldDomId(node.id, "edges")} tabIndex={-1}>
          <FieldIssues issues={general} />
        </div>
      ) : null}

      <NodeIdField nodeId={node.id} taken={taken} onRename={onRename} issues={issues.filter((i) => i.field === "id")} />

      <Field label="Label" htmlFor={labelId} hint="What the canvas and the run view call this step." issues={issues.filter((i) => i.field === "label")}>
        <input
          id={labelId}
          value={node.label ?? ""}
          onChange={(event) => onLabel(event.target.value)}
          maxLength={120}
          placeholder={info?.label ?? node.id}
          className={INPUT}
        />
      </Field>

      {isSchedule ? (
        <ScheduleTriggerEditor
          nodeId={node.id}
          config={node.config}
          inputs={spec.inputs}
          issues={issues}
          onChange={(config) => onConfig(config)}
        />
      ) : null}

      {info ? (
        formFields.length ? (
          <SchemaForm
            nodeId={node.id}
            fields={formFields}
            config={node.config}
            onChange={onConfig}
            issues={issues}
            paths={paths}
            assignPaths={assignPaths}
            barePaths={paths}
            stateNames={spec.state.map((field) => field.name).filter(Boolean)}
          />
        ) : null
      ) : isSchedule ? null : (
        <p className="text-xs text-muted-foreground">This kind isn&apos;t in the catalogue; its settings can&apos;t be edited here.</p>
      )}
    </div>
  );
}
