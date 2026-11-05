import * as React from "react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowFormField,
  WorkflowTemplatePath,
} from "@/shared/lib/types";
import { INPUT } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { asCases, asRules } from "@/features/workflows/lib/builder/schemaForm";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { CasesEditor } from "./CasesEditor";
import { CodeField } from "./CodeField";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { Field, Toggle } from "./FieldShell";
import { JsonField } from "./JsonField";
import { MapEditor } from "./MapEditor";
import { RulesEditor } from "./RulesEditor";
import { TemplateField } from "./TemplateField";

/** A number typed as text: committed when it parses, removed when emptied (the default applies). */
function NumberInput({
  id,
  value,
  field,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: unknown;
  field: WorkflowFormField;
  onChange: (value: unknown) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const [text, setText] = React.useState(typeof value === "number" ? String(value) : "");
  React.useEffect(() => {
    if (Number(text) !== value || (value === undefined && text !== "")) {
      setText(typeof value === "number" ? String(value) : "");
    }
    // An outside change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const placeholder = typeof field.default === "number" ? `${field.default} (default)` : undefined;
  return (
    <input
      id={id}
      type="number"
      inputMode={field.integer ? "numeric" : "decimal"}
      step={field.integer ? 1 : "any"}
      min={field.minimum ?? field.exclusiveMinimum}
      max={field.maximum ?? field.exclusiveMaximum}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (!next.trim()) onChange(undefined);
        else if (Number.isFinite(Number(next))) onChange(Number(next));
      }}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(INPUT, "tabular-nums")}
    />
  );
}

const rangeHint = (field: WorkflowFormField): string | null => {
  const low = field.minimum ?? field.exclusiveMinimum;
  const high = field.maximum ?? field.exclusiveMaximum;
  if (low === undefined && high === undefined) return null;
  if (low !== undefined && high !== undefined) return `Between ${low} and ${high}.`;
  return low !== undefined ? `At least ${low}.` : `At most ${high}.`;
};

/**
 * A node's config form, generated from its kind's JSON Schema
 * (`lib/builder/schemaForm`): text, numbers with their range, on/off,
 * choices, nested objects (`tool`), maps (`headers`, `args`, `outputs`),
 * `assign` (state field → template), rule lists and router cases, source
 * code (a monospace editor, never templated), and a JSON editor for
 * anything else. Templated text gets the `{ }` helper; issues sit
 * under the field they name.
 */
export function SchemaForm({
  nodeId,
  fields,
  config,
  onChange,
  issues,
  paths,
  assignPaths,
  barePaths,
  stateNames,
  prefix = "config",
}: {
  nodeId: string;
  fields: readonly WorkflowFormField[];
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>, cases?: WorkflowCasesChange) => void;
  issues: readonly WorkflowBuilderIssue[];
  /** What templated fields may read. */
  paths: readonly WorkflowTemplatePath[];
  /** …and `assign` values (this step's own `output` too). */
  assignPaths: readonly WorkflowTemplatePath[];
  /** Rule paths: the same, without braces. */
  barePaths: readonly WorkflowTemplatePath[];
  stateNames: readonly string[];
  prefix?: string;
}) {
  const set = (key: string, value: unknown, cases?: WorkflowCasesChange) => {
    const next = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next, cases);
  };

  return (
    <div className="space-y-5">
      {fields.map((field) => {
        const where = `${prefix}.${field.key}`;
        const id = fieldDomId(nodeId, where);
        const own = issues.filter((issue) => issueIsOn(issue, where));
        const direct = own.filter((issue) => issue.field === where);
        const invalid = direct.some((issue) => issue.severity === "error");
        const issuesId = `${id}-issues`;
        const value = config[field.key];
        const hint = field.description ? field.description.replace(/\.?$/, ".") : null;

        switch (field.widget) {
          case "text":
          case "textarea": {
            const text = typeof value === "string" ? value : "";
            const control = field.templated ? (
              <TemplateField
                id={id}
                value={text}
                onChange={(next) => set(field.key, next)}
                paths={paths}
                multiline={field.widget === "textarea"}
                mono={false}
                maxLength={field.maxLength}
                invalid={invalid}
                describedBy={direct.length ? issuesId : undefined}
                placeholder={typeof field.default === "string" ? field.default : undefined}
              />
            ) : field.widget === "textarea" ? (
              <textarea
                id={id}
                value={text}
                rows={3}
                maxLength={field.maxLength}
                onChange={(event) => set(field.key, event.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={direct.length ? issuesId : undefined}
                className={cn(INPUT, "block resize-y leading-relaxed")}
              />
            ) : (
              <input
                id={id}
                value={text}
                maxLength={field.maxLength}
                onChange={(event) => set(field.key, event.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={direct.length ? issuesId : undefined}
                className={INPUT}
              />
            );
            return (
              <Field key={field.key} label={field.label} htmlFor={id} required={field.required} hint={hint} issues={direct} issuesId={issuesId}>
                {control}
              </Field>
            );
          }
          case "code":
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={[hint, "Tab indents; Esc, then Tab, leaves the editor."].filter(Boolean).join(" ")}
                issues={direct}
                issuesId={issuesId}
              >
                <CodeField
                  id={id}
                  value={typeof value === "string" ? value : ""}
                  onChange={(next) => set(field.key, next)}
                  maxLength={field.maxLength}
                  invalid={invalid}
                  describedBy={direct.length ? issuesId : undefined}
                />
              </Field>
            );
          case "number":
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={[hint, rangeHint(field)].filter(Boolean).join(" ") || null}
                issues={direct}
                issuesId={issuesId}
              >
                <NumberInput id={id} value={value} field={field} onChange={(next) => set(field.key, next)} invalid={invalid} describedBy={direct.length ? issuesId : undefined} />
              </Field>
            );
          case "boolean":
            return (
              <Field key={field.key} label={field.label} htmlFor={id} hint={hint} issues={direct}>
                <Toggle
                  id={id}
                  checked={typeof value === "boolean" ? value : field.default === true}
                  onChange={(next) => set(field.key, next)}
                  label={field.label}
                />
              </Field>
            );
          case "enum": {
            const current = typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";
            return (
              <Field key={field.key} label={field.label} htmlFor={id} required={field.required} hint={hint} issues={direct} issuesId={issuesId}>
                <ChoiceSelect
                  id={id}
                  value={current}
                  options={(field.options ?? []).map((option) => ({
                    value: option,
                    label: option === field.default ? `${option} (default)` : option,
                  }))}
                  onChange={(next) => set(field.key, next)}
                  invalid={invalid}
                  describedBy={direct.length ? issuesId : undefined}
                />
              </Field>
            );
          }
          case "object": {
            const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
            return (
              <fieldset key={field.key} className="space-y-3 rounded-2xl border border-border/60 bg-muted/15 p-3.5">
                <legend className="px-1 text-xs font-semibold text-foreground/85">
                  {field.label}
                  {field.required ? <span className="ml-0.5 text-destructive/80" aria-hidden>*</span> : null}
                </legend>
                <SchemaForm
                  nodeId={nodeId}
                  fields={field.fields ?? []}
                  config={record}
                  onChange={(next) => set(field.key, next)}
                  issues={issues}
                  paths={paths}
                  assignPaths={assignPaths}
                  barePaths={barePaths}
                  stateNames={stateNames}
                  prefix={where}
                />
                {direct.length ? <Field label="" issues={direct}>{null}</Field> : null}
              </fieldset>
            );
          }
          case "rules":
            return (
              <Field key={field.key} label={field.label} required={field.required} hint={hint}>
                <RulesEditor
                  nodeId={nodeId}
                  field={where}
                  rules={asRules(value)}
                  onChange={(rules) => set(field.key, rules.length || field.required ? rules : undefined)}
                  paths={barePaths}
                  issues={own}
                  min={field.minItems ?? 0}
                  max={field.maxItems}
                />
              </Field>
            );
          case "cases":
            return (
              <Field key={field.key} label="Cases" required={field.required} hint="Tried in order; the first whose rules hold picks its branch.">
                <CasesEditor
                  nodeId={nodeId}
                  field={where}
                  cases={asCases(value)}
                  onChange={(cases, change) => set(field.key, cases, change)}
                  paths={barePaths}
                  issues={own}
                  max={field.maxItems}
                />
              </Field>
            );
          case "assign":
            // A state-write map the schema names itself (`"x-widget": "assign"`,
            // the set step's `values`): the same editor, under its own label;
            // its values are the step's input, so they can't read its output.
            if (field.key !== "assign") {
              return (
                <Field
                  key={field.key}
                  label={field.label}
                  required={field.required}
                  hint={
                    stateNames.length
                      ? hint ?? "State field → value; values may use {{…}} placeholders."
                      : "Declare state fields in the workflow's settings (click the empty canvas) to write them here."
                  }
                  issues={own}
                >
                  <MapEditor
                    id={id}
                    value={value}
                    onChange={(next) => set(field.key, Object.keys(next).length || field.required ? next : undefined)}
                    paths={paths}
                    keyOptions={stateNames}
                    addLabel="Add state write"
                    emptyText="Nothing written to state."
                    max={field.maxProperties}
                  />
                </Field>
              );
            }
            return (
              <Field
                key={field.key}
                label="Write to state"
                hint={
                  stateNames.length
                    ? "After this step runs, set state fields. Values may read {{output.…}}, this step's result."
                    : "Declare state fields in the workflow's settings (click the empty canvas) to write them here."
                }
                issues={own}
              >
                <MapEditor
                  id={id}
                  value={value}
                  onChange={(next) => set(field.key, Object.keys(next).length ? next : undefined)}
                  paths={assignPaths}
                  keyOptions={stateNames}
                  addLabel="Add state write"
                  emptyText="Nothing written to state."
                  max={field.maxProperties}
                />
              </Field>
            );
          case "map":
            return (
              <Field key={field.key} label={field.label} required={field.required} hint={hint} issues={own}>
                <MapEditor
                  id={id}
                  value={value}
                  onChange={(next) => set(field.key, Object.keys(next).length || field.required ? next : undefined)}
                  paths={paths}
                  valueKind={field.valueKind}
                  emptyText={`No ${field.label.toLowerCase()}.`}
                  max={field.maxProperties}
                />
              </Field>
            );
          default:
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={hint ?? (field.jsonType || field.strictJson ? "JSON." : "JSON, or text with {{…}} placeholders.")}
                issues={own}
              >
                {field.jsonType || field.strictJson ? (
                  <JsonField id={id} value={value} onChange={(next) => set(field.key, next)} jsonType={field.jsonType} invalid={invalid} />
                ) : (
                  <LooseValueField
                    id={id}
                    value={value ?? null}
                    onChange={(next) => set(field.key, next === null ? undefined : next)}
                    paths={paths}
                    small={false}
                    multiline
                    showKind
                    placeholder='{"key": "{{input.x}}"}'
                    invalid={invalid}
                  />
                )}
              </Field>
            );
        }
      })}
    </div>
  );
}
