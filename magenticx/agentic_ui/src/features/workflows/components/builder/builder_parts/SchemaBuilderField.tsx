import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Braces, ListTree, Plus, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowSchemaField, WorkflowSchemaFieldType, WorkflowSchemaItemType } from "@/shared/lib/types";
import {
  ADD_BUTTON,
  ICON_BUTTON,
  INPUT_SM,
  REVEAL,
  REVEAL_REDUCED,
  SCHEMA_KIND_OPTIONS,
} from "@/features/workflows/lib/builder/consts";
import { fieldsToSchema, schemaFieldNameProblem, schemaToFields } from "@/features/workflows/lib/builder/jsonSchema";
import { ChoiceSelect } from "./Controls";
import { EmptyNote, Toggle } from "./FieldShell";
import { JsonField } from "./JsonField";

/** The most fields the builder offers before JSON is the better tool. */
const MAX_FIELDS = 32;

/** A field's one "Type" choice: Choice for text with set values, `array:<item>` for a typed list. */
function kindOf(field: WorkflowSchemaField): string {
  if (field.type === "string" && field.options !== undefined) return "choice";
  if (field.type === "array" && field.itemType) return `array:${field.itemType}`;
  return field.type;
}

/** The patch a "Type" choice makes: the JSON type, plus allowed values or the item type it brings. */
function patchForKind(kind: string, field: WorkflowSchemaField): Partial<WorkflowSchemaField> {
  if (kind === "choice") return { type: "string", options: field.options ?? [], itemType: undefined };
  if (kind.startsWith("array:")) {
    return { type: "array", itemType: kind.slice("array:".length) as WorkflowSchemaItemType, options: undefined };
  }
  return { type: kind as WorkflowSchemaFieldType, options: undefined, itemType: undefined };
}

/**
 * A Choice field's allowed values, typed as a comma-separated list: kept as
 * typed while focused (so "a, " can be followed by "b"), written as the
 * trimmed values.
 */
function ChoiceValues({
  label,
  values,
  onChange,
}: {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = React.useState(values.join(", "));
  const written = React.useRef(values);
  React.useEffect(() => {
    if (values !== written.current) setText(values.join(", "));
  }, [values]);
  return (
    <input
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = event.target.value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        written.current = next;
        onChange(next);
      }}
      placeholder="Allowed values, e.g. low, medium, high"
      aria-label={label}
      spellCheck={false}
      className={cn(INPUT_SM, "font-mono")}
    />
  );
}

/**
 * The llm step's reply shape (`json_schema`), built as a list of fields —
 * name, type, description, required — that becomes a flat object schema
 * (`additionalProperties: false`). A type is chosen in words: Text, Choice
 * (text with set values), numbers, Yes / no, a list of one kind of value.
 * Fields are rows split by hairlines, not boxes. "Edit as JSON" swaps in the
 * plain JSON editor; a schema the list can't show (nested objects, `$ref`…)
 * opens there, and the builder stays off until it is simple again.
 */
export function SchemaBuilderField({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const reduceMotion = useReducedMotion();
  const parsed = schemaToFields(value);
  const [json, setJson] = React.useState(parsed === null);
  const [rows, setRows] = React.useState<WorkflowSchemaField[]>(() => parsed ?? []);
  const written = React.useRef(value);
  React.useEffect(() => {
    // An outside change (undo, the JSON editor): re-read it, or fall to JSON if it can't be shown.
    if (value === written.current) return;
    written.current = value;
    const next = schemaToFields(value);
    if (next === null) setJson(true);
    else setRows(next);
  }, [value]);

  const commit = (next: WorkflowSchemaField[]) => {
    setRows(next);
    const schema = fieldsToSchema(next);
    written.current = schema;
    onChange(schema);
  };
  const update = (index: number, patch: Partial<WorkflowSchemaField>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const representable = parsed !== null;
  const toggle = (
    <button
      type="button"
      className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => {
        if (json && representable) setRows(parsed);
        setJson(!json);
      }}
      disabled={json && !representable}
      title={json && !representable ? "This shape has more than the builder can show." : undefined}
      aria-pressed={json}
    >
      {json ? <ListTree className="h-3.5 w-3.5" aria-hidden /> : <Braces className="h-3.5 w-3.5" aria-hidden />}
      {json ? "Use the builder" : "Edit as JSON"}
    </button>
  );

  if (json) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted-foreground">
            {representable ? "The reply's shape, as JSON Schema." : "Nested fields: edited as JSON Schema."}
          </p>
          {toggle}
        </div>
        <JsonField id={id} value={value} onChange={onChange} jsonType="object" invalid={invalid} describedBy={describedBy} />
      </div>
    );
  }

  return (
    <div className="space-y-2" id={id} role="group" aria-label="Reply fields" aria-describedby={describedBy}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">The fields the reply must have.</p>
        {toggle}
      </div>
      {rows.length ? (
        <ol className="divide-y divide-border/50 border-y border-border/50">
          <AnimatePresence initial={false}>
            {rows.map((row, index) => {
              const problem = schemaFieldNameProblem(rows, index);
              const n = index + 1;
              const kind = kindOf(row);
              return (
                <motion.li
                  key={index}
                  {...(reduceMotion ? REVEAL_REDUCED : REVEAL)}
                  className="space-y-1.5 py-3"
                  role="group"
                  aria-label={`Reply field ${n}`}
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      value={row.name}
                      onChange={(event) => update(index, { name: event.target.value.replace(/\s+/g, "_") })}
                      maxLength={64}
                      placeholder="name"
                      aria-label={`Reply field ${n} name`}
                      aria-invalid={Boolean(problem && row.name) || undefined}
                      spellCheck={false}
                      className={cn(INPUT_SM, "min-w-0 flex-1 font-mono font-medium")}
                    />
                    <div className="w-[9.5rem] flex-shrink-0">
                      <ChoiceSelect
                        value={kind}
                        options={SCHEMA_KIND_OPTIONS}
                        onChange={(next) => update(index, patchForKind(next, row))}
                        small
                        ariaLabel={`Reply field ${n} type`}
                      />
                    </div>
                    <button
                      type="button"
                      className={cn(ICON_BUTTON, "hover:text-destructive")}
                      onClick={() => commit(rows.filter((_, other) => other !== index))}
                      aria-label={`Remove reply field ${n}`}
                      title="Remove field"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  {kind === "choice" ? (
                    <div className="pr-8">
                      <ChoiceValues
                        label={`Reply field ${n} allowed values`}
                        values={row.options ?? []}
                        onChange={(options) => update(index, { options })}
                      />
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 pr-8">
                    <input
                      value={row.description}
                      onChange={(event) => update(index, { description: event.target.value })}
                      maxLength={500}
                      placeholder="What it holds (helps the model)"
                      aria-label={`Reply field ${n} description`}
                      className={cn(INPUT_SM, "min-w-0 flex-1")}
                    />
                    <label className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Toggle checked={row.required} onChange={(required) => update(index, { required })} label={`Reply field ${n} required`} />
                      Required
                    </label>
                  </div>
                  {problem && row.name ? <p className="text-xs text-destructive">{problem}</p> : null}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      ) : (
        <EmptyNote>No fields yet. Add the fields the model must fill in.</EmptyNote>
      )}
      <button
        type="button"
        className={ADD_BUTTON}
        disabled={rows.length >= MAX_FIELDS}
        onClick={() => commit([...rows, { name: "", type: "string", description: "", required: true }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add field
      </button>
    </div>
  );
}
