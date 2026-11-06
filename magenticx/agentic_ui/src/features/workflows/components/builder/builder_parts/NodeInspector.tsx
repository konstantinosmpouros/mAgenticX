import * as React from "react";

import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowNodeDef,
  WorkflowNodeKindInfo,
  WorkflowSpec,
} from "@/shared/lib/types";
import { kindMeta, humanizeKind } from "@/features/workflows/lib/kinds";
import { INPUT, NO_ADVANCED_KINDS } from "@/features/workflows/lib/builder/consts";
import { fieldDomId, slugFromLabel } from "@/features/workflows/lib/builder/ids";
import { SCHEDULE_TRIGGER_KIND } from "@/features/workflows/lib/builder/schedule";
import { templatePaths } from "@/features/workflows/lib/builder/templates";
import { issueIsOn, kindFields } from "@/features/workflows/lib/builder/validate";
import { Disclosure, Field, FieldIssues } from "./FieldShell";
import { ScheduleTriggerEditor } from "./ScheduleTriggerEditor";
import { SchemaForm } from "./SchemaForm";

/**
 * The inspector for one step: what kind it is, its label, its config form
 * (generated from the kind's schema), and its node-level issues
 * (connections, references) on top. The id is never typed: it follows the
 * label when the label is committed (blur, Enter), through the same rename
 * that moves edges and references; it sits in a folded "Advanced" at the
 * end. A schedule trigger gets its own editor in place of the generic form.
 * How a workflow starts is the trigger step on the canvas: another start is
 * another trigger from the palette. Data from earlier steps comes in through
 * each field's own `{ }` picker; variables are written by Set steps. Triggers
 * and the kinds in `NO_ADVANCED_KINDS` leave the Advanced fold out (unless
 * there is an id issue to deal with).
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
  const isTrigger = info?.isTrigger ?? node.kind.startsWith("trigger.");
  const taken = React.useMemo(
    () => new Set(spec.nodes.map((other) => other.id).filter((id) => id !== node.id)),
    [spec.nodes, node.id],
  );
  const general = issues
    .filter((issue) => !issueIsOn(issue, "config") || issue.field === "config")
    .filter((issue) => issue.field !== "id" && issue.field !== "label");
  const labelId = fieldDomId(node.id, "label");
  const isSchedule = node.kind === SCHEDULE_TRIGGER_KIND;
  // The schedule trigger's own editor covers its whole config.
  const mainFields = isSchedule ? [] : fields;
  const idIssues = issues.filter((i) => i.field === "id");
  const showAdvanced = !(isTrigger || NO_ADVANCED_KINDS.has(node.kind)) || idIssues.length > 0;
  // The label as it was when the field took focus: the id follows only a label that changed.
  const labelAtFocus = React.useRef<string | null>(null);
  const commitLabel = () => {
    const before = labelAtFocus.current;
    labelAtFocus.current = null;
    const label = node.label ?? "";
    if (before === null || before === label) return;
    const derived = slugFromLabel(label, node.kind, taken);
    if (derived !== node.id) onRename(derived);
  };

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
        <div
          className="rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5"
          id={fieldDomId(node.id, "edges")}
          tabIndex={-1}
        >
          <FieldIssues issues={general} />
        </div>
      ) : null}

      <Field
        label="Label"
        htmlFor={labelId}
        hint="What the canvas and the run view call this step."
        issues={issues.filter((i) => i.field === "label")}
      >
        <input
          id={labelId}
          value={node.label ?? ""}
          onChange={(event) => onLabel(event.target.value)}
          onFocus={() => {
            labelAtFocus.current = node.label ?? "";
          }}
          onBlur={commitLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitLabel();
            }
          }}
          maxLength={120}
          placeholder={info?.label ?? node.id}
          className={INPUT}
        />
      </Field>

      {isSchedule ? (
        <ScheduleTriggerEditor
          nodeId={node.id}
          config={node.config}
          issues={issues}
          onChange={(config) => onConfig(config)}
        />
      ) : null}

      {info ? (
        mainFields.length ? (
          <SchemaForm
            nodeId={node.id}
            fields={mainFields}
            config={node.config}
            onChange={onConfig}
            issues={issues}
            paths={paths}
            barePaths={paths}
            spec={spec}
          />
        ) : null
      ) : isSchedule ? null : (
        <p className="text-xs text-muted-foreground">
          This kind isn&apos;t in the catalogue; its settings can&apos;t be edited here.
        </p>
      )}

      {showAdvanced ? (
        <Disclosure
          id={fieldDomId(node.id, "advanced")}
          title="Advanced"
          defaultOpen={idIssues.length > 0}
          issueCount={idIssues.filter((issue) => issue.severity === "error").length}
        >
          <div id={fieldDomId(node.id, "id")} tabIndex={-1}>
            <p className="text-xs text-muted-foreground">
              Internal id: <span className="break-all font-mono text-foreground/80">{node.id}</span>
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
              It follows the label automatically.
            </p>
            <FieldIssues issues={idIssues} />
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
