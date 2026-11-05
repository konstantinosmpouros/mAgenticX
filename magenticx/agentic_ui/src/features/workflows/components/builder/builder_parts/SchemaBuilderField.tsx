import * as React from "react";
import { Braces, ListTree, Plus, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowSchemaField, WorkflowSchemaFieldType } from "@/shared/lib/types";
import { ICON_BUTTON, INPUT_SM, SCHEMA_FIELD_TYPES, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldsToSchema, schemaFieldNameProblem, schemaToFields } from "@/features/workflows/lib/builder/jsonSchema";
import { ChoiceSelect } from "./Controls";
import { EmptyNote, Toggle } from "./FieldShell";
import { JsonField } from "./JsonField";

const TYPE_OPTIONS = SCHEMA_FIELD_TYPES.map((type) => ({ value: type, label: type }));

/** The most fields the builder offers before JSON is the better tool. */
const MAX_FIELDS = 32;

/**
 * The llm step's reply shape (`json_schema`), built as a list of fields —
 * name, type, description, required — that becomes a flat object schema
 * (`additionalProperties: false`). "Edit as JSON" swaps in the plain JSON
 * editor; a schema the list can't show (nested objects, `$ref`, enums…)
 * opens there, with a note, and the builder stays off until it is flat again.
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
      className={cn(SMALL_BUTTON, "px-2 py-1")}
      onClick={() => {
        if (json && representable) setRows(parsed);
        setJson(!json);
      }}
      disabled={json && !representable}
      title={json && !representable ? "This schema is more than the builder can show." : undefined}
      aria-pressed={json}
    >
      {json ? <ListTree className="h-3.5 w-3.5" aria-hidden /> : <Braces className="h-3.5 w-3.5" aria-hidden />}
      {json ? "Use the builder" : "Edit as JSON"}
    </button>
  );

  if (json) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">{toggle}</div>
        {!representable ? (
          <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            This schema uses more than the builder shows (nested fields, references, lists of a type…), so it opens as JSON.
          </p>
        ) : null}
        <JsonField id={id} value={value} onChange={onChange} jsonType="object" invalid={invalid} describedBy={describedBy} />
      </div>
    );
  }

  return (
    <div className="space-y-2.5" id={id} role="group" aria-label="Reply fields" aria-describedby={describedBy}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">The fields the reply must have.</p>
        {toggle}
      </div>
      {rows.length ? (
        rows.map((row, index) => {
          const problem = schemaFieldNameProblem(rows, index);
          const n = index + 1;
          return (
            <div key={index} className="space-y-1.5 rounded-xl border border-border/60 bg-muted/20 p-2.5" role="group" aria-label={`Reply field ${n}`}>
              <div className="flex items-center gap-1.5">
                <input
                  value={row.name}
                  onChange={(event) => update(index, { name: event.target.value.replace(/\s+/g, "_") })}
                  maxLength={64}
                  placeholder="name"
                  aria-label={`Reply field ${n} name`}
                  aria-invalid={Boolean(problem && row.name) || undefined}
                  spellCheck={false}
                  className={cn(INPUT_SM, "min-w-0 flex-1 font-mono")}
                />
                <div className="w-[6.5rem] flex-shrink-0">
                  <ChoiceSelect
                    value={row.type}
                    options={TYPE_OPTIONS}
                    onChange={(type) => update(index, { type: type as WorkflowSchemaFieldType })}
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
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <div className="flex items-center gap-2">
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
            </div>
          );
        })
      ) : (
        <EmptyNote>No fields yet. Add the fields the model must fill in.</EmptyNote>
      )}
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={rows.length >= MAX_FIELDS}
        onClick={() => commit([...rows, { name: "", type: "string", description: "", required: true }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add field
      </button>
    </div>
  );
}
