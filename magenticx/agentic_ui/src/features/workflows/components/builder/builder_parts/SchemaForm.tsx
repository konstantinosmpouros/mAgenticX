import * as React from "react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowFormField,
  WorkflowSpec,
  WorkflowTemplatePath,
  WorkflowToolInfo,
} from "@/shared/lib/types";
import { Segmented } from "@/shared/ui/segmented";
import { useWorkflowTools } from "@/features/workflows/hooks/useWorkflowTools";
import { INPUT } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import {
  SEGMENTED_MAX_OPTIONS,
  enumLabel,
  fieldLabel,
  fieldUnit,
  mapAddLabel,
} from "@/features/workflows/lib/builder/inspectorLayout";
import { asCases, asRules } from "@/features/workflows/lib/builder/schemaForm";
import { asToolRef, findTool, pruneArgs } from "@/features/workflows/lib/builder/toolArgs";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { variableNames } from "@/features/workflows/lib/builder/variables";
import { CasesEditor } from "./CasesEditor";
import { CodeField } from "./CodeField";
import { ContextField } from "./ContextField";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { ConversationField } from "./ConversationField";
import { Field, Toggle } from "./FieldShell";
import { JsonField } from "./JsonField";
import { KeepField } from "./KeepField";
import { MapEditor } from "./MapEditor";
import { RulesEditor } from "./RulesEditor";
import { SchemaBuilderField } from "./SchemaBuilderField";
import { TemplateField } from "./TemplateField";
import { ToolArgsField } from "./ToolArgsField";
import { ToolField } from "./ToolField";

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
  const unit = fieldUnit(field.key);
  return (
    <div className="relative">
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
        className={cn(
          INPUT,
          "tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          unit && "pr-11",
        )}
      />
      {unit ? (
        <span
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
          aria-hidden
        >
          {unit}
        </span>
      ) : null}
    </div>
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
 * a Set step's variables (name → template), an End step's variables to
 * keep for the next run, rule lists and router cases, source code (a
 * monospace editor, never templated), a tool step's tool (a searchable
 * picker over `GET /v1/workflows/tools`) and that tool's own arguments, and
 * a JSON editor for anything else.
 * Templated text gets the `{ }` helper; issues sit under the field they name.
 */
export function SchemaForm({
  nodeId,
  fields,
  config,
  onChange,
  issues,
  paths,
  barePaths,
  spec,
  prefix = "config",
}: {
  nodeId: string;
  fields: readonly WorkflowFormField[];
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>, cases?: WorkflowCasesChange) => void;
  issues: readonly WorkflowBuilderIssue[];
  /** What templated fields may read. */
  paths: readonly WorkflowTemplatePath[];
  /** Rule paths: the same, without braces. */
  barePaths: readonly WorkflowTemplatePath[];
  /** The workflow: what "Data from earlier steps", "Conversation" and the variable fields offer and preview. */
  spec?: WorkflowSpec;
  prefix?: string;
}) {
  const set = (key: string, value: unknown, cases?: WorkflowCasesChange) => {
    const next = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next, cases);
  };
  // `memory` is shown inside the Conversation block, beside `thread`.
  const memoryField = fields.find((field) => field.key === "memory" && field.widget === "enum");
  const hasConversation = fields.some((field) => field.widget === "thread");
  // A tool step: its tool is picked from the tool list, and its arguments follow the picked tool's schema.
  const toolField = fields.find((field) => field.widget === "tool");
  const argsField = fields.find((field) => field.widget === "tool_args");
  const tools = useWorkflowTools(Boolean(toolField));
  const toolRef = toolField ? asToolRef(config[toolField.key]) : null;
  const pickedTool = tools.data ? findTool(tools.data.tools, toolRef) : null;
  const pickTool = (tool: WorkflowToolInfo) => {
    if (!toolField) return;
    const next: Record<string, unknown> = {
      ...config,
      [toolField.key]: { source: tool.source, name: tool.name },
    };
    if (argsField) {
      // Keep the values of the arguments the new tool also takes.
      const kept = pruneArgs(config[argsField.key], tool);
      if (Object.keys(kept).length) next[argsField.key] = kept;
      else delete next[argsField.key];
    }
    onChange(next);
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
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={hint}
                issues={direct}
                issuesId={issuesId}
              >
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
                hint={[hint, "Tab indents; Esc, then Tab, leaves the editor."]
                  .filter(Boolean)
                  .join(" ")}
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
                label={fieldLabel(field.key, field.label)}
                htmlFor={id}
                required={field.required}
                hint={[hint, rangeHint(field)].filter(Boolean).join(" ") || null}
                issues={direct}
                issuesId={issuesId}
              >
                <NumberInput
                  id={id}
                  value={value}
                  field={field}
                  onChange={(next) => set(field.key, next)}
                  invalid={invalid}
                  describedBy={direct.length ? issuesId : undefined}
                />
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
            if (field === memoryField && hasConversation) return null;
            const current =
              typeof value === "string"
                ? value
                : typeof field.default === "string"
                  ? field.default
                  : "";
            const options = field.options ?? [];
            // A short choice (JSON / text, all / any) reads better as a segmented control than a dropdown.
            if (options.length > 1 && options.length <= SEGMENTED_MAX_OPTIONS) {
              return (
                <Field
                  key={field.key}
                  label={field.label}
                  required={field.required}
                  hint={hint}
                  issues={direct}
                  issuesId={issuesId}
                >
                  <Segmented
                    idPrefix={id}
                    size="sm"
                    ariaLabel={field.label}
                    value={current || options[0]}
                    options={options.map((option) => ({ id: option, label: enumLabel(option) }))}
                    onChange={(next) => set(field.key, next)}
                  />
                </Field>
              );
            }
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={hint}
                issues={direct}
                issuesId={issuesId}
              >
                <ChoiceSelect
                  id={id}
                  value={current}
                  options={options.map((option) => ({ value: option, label: enumLabel(option) }))}
                  onChange={(next) => set(field.key, next)}
                  invalid={invalid}
                  describedBy={direct.length ? issuesId : undefined}
                />
              </Field>
            );
          }
          case "object": {
            const record =
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
            return (
              <fieldset
                key={field.key}
                className="space-y-3 rounded-2xl border border-border/60 bg-muted/15 p-3.5"
              >
                <legend className="px-1 text-xs font-semibold text-foreground/85">
                  {field.label}
                  {field.required ? (
                    <span className="ml-0.5 text-destructive/80" aria-hidden>
                      *
                    </span>
                  ) : null}
                </legend>
                <SchemaForm
                  nodeId={nodeId}
                  fields={field.fields ?? []}
                  config={record}
                  onChange={(next) => set(field.key, next)}
                  issues={issues}
                  paths={paths}
                  barePaths={barePaths}
                  spec={spec}
                  prefix={where}
                />
                {direct.length ? (
                  <Field label="" issues={direct}>
                    {null}
                  </Field>
                ) : null}
              </fieldset>
            );
          }
          case "rules":
            return (
              <Field key={field.key} label={field.label} required={field.required} hint={hint}>
                <RulesEditor
                  nodeId={nodeId}
                  field={where}
                  joiner={config.mode === "any" ? "or" : "and"}
                  rules={asRules(value)}
                  onChange={(rules) =>
                    set(field.key, rules.length || field.required ? rules : undefined)
                  }
                  paths={barePaths}
                  issues={own}
                  min={field.minItems ?? 0}
                  max={field.maxItems}
                />
              </Field>
            );
          case "cases":
            return (
              <Field
                key={field.key}
                label="Cases"
                required={field.required}
                hint="Tried top to bottom: the first case whose rules hold picks its branch. When none does, the step takes the default branch."
              >
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
            // A Set step's variables (`"x-widget": "assign"`): any name, the
            // ones other Set steps write offered while typing.
            return (
              <Field
                key={field.key}
                label={field.label}
                required={field.required}
                hint={hint}
                issues={own}
              >
                <MapEditor
                  id={id}
                  value={value}
                  onChange={(next) =>
                    set(field.key, Object.keys(next).length || field.required ? next : undefined)
                  }
                  paths={paths}
                  keySuggestions={spec ? variableNames(spec, nodeId) : []}
                  keyPlaceholder="variable"
                  addLabel="Add variable"
                  emptyText="No variables set."
                  max={field.maxProperties}
                />
              </Field>
            );
          case "keep":
            return (
              <Field
                key={field.key}
                label="Keep for the next run"
                hint="These variables start the next run with this run's values."
                issues={own}
                issuesId={issuesId}
              >
                <KeepField
                  id={id}
                  value={value}
                  onChange={(next) => set(field.key, next.length ? next : undefined)}
                  variables={spec ? variableNames(spec) : []}
                  describedBy={direct.length ? issuesId : undefined}
                />
              </Field>
            );
          case "context":
            return (
              <Field
                key={field.key}
                label="Data from earlier steps"
                issues={own}
                issuesId={issuesId}
              >
                <ContextField
                  id={id}
                  value={value}
                  onChange={(next) => set(field.key, next)}
                  spec={spec}
                  nodeId={nodeId}
                  describedBy={direct.length ? issuesId : undefined}
                />
              </Field>
            );
          case "thread": {
            const memoryWhere = memoryField ? `${prefix}.${memoryField.key}` : "";
            const memoryIssues = memoryField
              ? issues.filter((issue) => issueIsOn(issue, memoryWhere))
              : [];
            const storedMemory = memoryField ? config[memoryField.key] : undefined;
            return (
              <Field key={field.key} label="Conversation" issues={[...memoryIssues, ...own]}>
                <ConversationField
                  id={id}
                  nodeId={nodeId}
                  spec={spec}
                  memory={
                    memoryField
                      ? typeof storedMemory === "string"
                        ? storedMemory
                        : typeof memoryField.default === "string"
                          ? memoryField.default
                          : (memoryField.options?.[0] ?? "")
                      : null
                  }
                  memoryOptions={memoryField?.options ?? []}
                  thread={typeof value === "string" ? value : ""}
                  onMemory={(next) => memoryField && set(memoryField.key, next)}
                  onThread={(next) => set(field.key, next)}
                  memoryInvalid={memoryIssues.some((issue) => issue.severity === "error")}
                  threadInvalid={invalid}
                />
              </Field>
            );
          }
          case "tool":
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                issues={own}
                issuesId={issuesId}
              >
                <ToolField
                  id={id}
                  current={toolRef}
                  tools={tools}
                  onPick={pickTool}
                  invalid={own.some((issue) => issue.severity === "error")}
                  describedBy={own.length ? issuesId : undefined}
                />
              </Field>
            );
          case "tool_args":
            if (!toolField) return null;
            if (pickedTool) {
              return (
                <fieldset
                  key={field.key}
                  className="min-w-0 space-y-3 rounded-2xl border border-border/60 bg-muted/15 p-3.5"
                >
                  <legend className="px-1 text-xs font-semibold text-foreground/85">
                    Arguments
                  </legend>
                  <ToolArgsField
                    key={`${pickedTool.source}:${pickedTool.name}`}
                    nodeId={nodeId}
                    where={where}
                    value={value}
                    onChange={(next) => set(field.key, next)}
                    tool={pickedTool}
                    paths={paths}
                    issues={own}
                  />
                </fieldset>
              );
            }
            // No tool yet: nothing to fill in. The list is loading, can't be
            // read or no longer has the tool: the stored arguments as a plain map.
            if (!toolRef || (tools.isLoading && !tools.data)) return null;
            return (
              <Field key={field.key} label="Arguments" hint={hint} issues={own}>
                <MapEditor
                  id={id}
                  value={value}
                  onChange={(next) => set(field.key, Object.keys(next).length ? next : undefined)}
                  paths={paths}
                  emptyText="No arguments."
                />
              </Field>
            );
          case "map":
            return (
              <Field
                key={field.key}
                label={field.label}
                required={field.required}
                hint={hint}
                issues={own}
              >
                <MapEditor
                  id={id}
                  value={value}
                  onChange={(next) =>
                    set(field.key, Object.keys(next).length || field.required ? next : undefined)
                  }
                  paths={paths}
                  valueKind={field.valueKind}
                  addLabel={mapAddLabel(field.key)}
                  emptyText={`No ${field.label.toLowerCase()}.`}
                  max={field.maxProperties}
                />
              </Field>
            );
          default:
            if (field.jsonSchema) {
              // The reply's shape only matters in JSON mode (the llm step's `output`).
              if (config.output !== "json") return null;
              return (
                <Field
                  key={field.key}
                  label="Reply format"
                  htmlFor={id}
                  required
                  hint={hint}
                  issues={own}
                  issuesId={issuesId}
                >
                  <SchemaBuilderField
                    id={id}
                    value={value}
                    onChange={(next) => set(field.key, next)}
                    invalid={invalid}
                    describedBy={direct.length ? issuesId : undefined}
                  />
                </Field>
              );
            }
            return (
              <Field
                key={field.key}
                label={field.label}
                htmlFor={id}
                required={field.required}
                hint={
                  hint ??
                  (field.jsonType || field.strictJson
                    ? "JSON."
                    : "JSON, or text with {{…}} placeholders.")
                }
                issues={own}
              >
                {field.jsonType || field.strictJson ? (
                  <JsonField
                    id={id}
                    value={value}
                    onChange={(next) => set(field.key, next)}
                    jsonType={field.jsonType}
                    invalid={invalid}
                  />
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
