import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowInputDef,
  WorkflowReducer,
  WorkflowStateFieldDef,
  WorkflowStateFieldType,
} from "@/shared/lib/types";
import {
  ICON_BUTTON,
  INPUT_SM,
  REDUCERS,
  REDUCER_HINTS,
  SMALL_BUTTON,
  VALUE_TYPES,
} from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { formatTyped, parseTyped } from "@/features/workflows/lib/builder/values";
import { ChoiceSelect } from "./Controls";
import { EmptyNote, FieldIssues, Toggle } from "./FieldShell";

const TYPE_OPTIONS = VALUE_TYPES.map((type) => ({ value: type, label: type }));
const REDUCER_OPTIONS = REDUCERS.map((reducer) => ({ value: reducer, label: reducer }));

/** A default typed as text and written when it fits the type (empty = none). */
function DefaultField({
  id,
  type,
  value,
  onChange,
  label,
}: {
  id: string;
  type: WorkflowStateFieldType;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const [text, setText] = React.useState(() => formatTyped(type, value));
  const [error, setError] = React.useState<string | null>(null);
  const written = React.useRef(value);
  React.useEffect(() => {
    if (value !== written.current) {
      written.current = value;
      setText(formatTyped(type, value));
      setError(null);
    }
  }, [value, type]);
  return (
    <div className="min-w-0 flex-1">
      <input
        id={id}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = parseTyped(type, next);
          if (parsed.ok) {
            setError(null);
            written.current = parsed.value;
            onChange(parsed.value);
          } else {
            setError(parsed.message);
          }
        }}
        placeholder={type === "string" ? "Default (optional)" : `Default ${type} (JSON)`}
        aria-label={label}
        aria-invalid={Boolean(error) || undefined}
        spellCheck={false}
        className={cn(INPUT_SM, "font-mono")}
      />
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function NameField({
  id,
  value,
  onChange,
  label,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  invalid: boolean;
}) {
  return (
    <input
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\s+/g, "_"))}
      maxLength={64}
      placeholder="name"
      aria-label={label}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      className={cn(INPUT_SM, "font-mono")}
    />
  );
}

/**
 * The run's inputs: what whoever starts a run supplies (the Run dialog's
 * form), read as `{{input.<name>}}`. Name, type, required, default, and a
 * description the Run dialog shows.
 */
export function InputsEditor({
  inputs,
  onChange,
  issues,
  max = 32,
}: {
  inputs: WorkflowInputDef[];
  onChange: (inputs: WorkflowInputDef[]) => void;
  issues: readonly WorkflowBuilderIssue[];
  max?: number;
}) {
  const update = (index: number, patch: Partial<WorkflowInputDef>) =>
    onChange(inputs.map((input, at) => (at === index ? { ...input, ...patch } : input)));
  return (
    <div className="space-y-2.5">
      {inputs.length ? (
        inputs.map((input, index) => {
          const at = `inputs[${index}]`;
          const own = issues.filter((issue) => issueIsOn(issue, at));
          return (
            <div key={`input-${index}`} className="rounded-xl border border-border/60 bg-muted/20 p-2.5" role="group" aria-label={`Input ${index + 1}`}>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <NameField
                    id={fieldDomId(null, `${at}.name`)}
                    value={input.name}
                    onChange={(name) => update(index, { name })}
                    label={`Input ${index + 1} name`}
                    invalid={own.some((issue) => issue.field === `${at}.name`)}
                  />
                </div>
                <div className="w-[6.5rem] flex-shrink-0">
                  <ChoiceSelect
                    id={fieldDomId(null, `${at}.type`)}
                    value={input.type}
                    options={TYPE_OPTIONS}
                    onChange={(type) => update(index, { type: type as WorkflowStateFieldType, default: null })}
                    small
                    ariaLabel={`Input ${index + 1} type`}
                  />
                </div>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, "hover:text-destructive")}
                  onClick={() => onChange(inputs.filter((_, other) => other !== index))}
                  aria-label={`Remove input ${index + 1}`}
                  title="Remove input"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <DefaultField
                  id={fieldDomId(null, `${at}.default`)}
                  type={input.type}
                  value={input.default ?? null}
                  onChange={(value) => update(index, { default: value })}
                  label={`Input ${index + 1} default`}
                />
                <label className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Toggle checked={Boolean(input.required)} onChange={(required) => update(index, { required })} label={`Input ${index + 1} required`} />
                  Required
                </label>
              </div>
              <input
                value={input.description ?? ""}
                onChange={(event) => update(index, { description: event.target.value })}
                maxLength={500}
                placeholder="What to enter (shown when running)"
                aria-label={`Input ${index + 1} description`}
                className={cn(INPUT_SM, "mt-1.5")}
              />
              <FieldIssues issues={own} />
            </div>
          );
        })
      ) : (
        <EmptyNote>No inputs: a run starts with nothing to fill in.</EmptyNote>
      )}
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={inputs.length >= max}
        onClick={() => onChange([...inputs, { name: "", type: "string", required: false, default: null, description: "" }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add input
      </button>
    </div>
  );
}

/**
 * Declared state: fields steps read as `{{state.<name>}}` and write through
 * `assign`. Each has a type, a reducer (how a write combines with the value),
 * a default, and whether it persists to the next run.
 */
export function StateFieldsEditor({
  state,
  onChange,
  issues,
  max = 32,
}: {
  state: WorkflowStateFieldDef[];
  onChange: (state: WorkflowStateFieldDef[]) => void;
  issues: readonly WorkflowBuilderIssue[];
  max?: number;
}) {
  const update = (index: number, patch: Partial<WorkflowStateFieldDef>) =>
    onChange(state.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  return (
    <div className="space-y-2.5">
      {state.length ? (
        state.map((field, index) => {
          const at = `state[${index}]`;
          const own = issues.filter((issue) => issueIsOn(issue, at));
          return (
            <div key={`state-${index}`} className="rounded-xl border border-border/60 bg-muted/20 p-2.5" role="group" aria-label={`Variable ${index + 1}`}>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <NameField
                    id={fieldDomId(null, `${at}.name`)}
                    value={field.name}
                    onChange={(name) => update(index, { name })}
                    label={`Variable ${index + 1} name`}
                    invalid={own.some((issue) => issue.field === `${at}.name`)}
                  />
                </div>
                <div className="w-[6.5rem] flex-shrink-0">
                  <ChoiceSelect
                    id={fieldDomId(null, `${at}.type`)}
                    value={field.type}
                    options={TYPE_OPTIONS}
                    onChange={(type) => {
                      const next = type as WorkflowStateFieldType;
                      // A reducer that no longer fits the type falls back to overwrite.
                      const reducer =
                        (field.reducer === "append" && next !== "array") || (field.reducer === "merge" && next !== "object")
                          ? "overwrite"
                          : field.reducer;
                      update(index, { type: next, reducer, default: null });
                    }}
                    small
                    ariaLabel={`Variable ${index + 1} type`}
                  />
                </div>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, "hover:text-destructive")}
                  onClick={() => onChange(state.filter((_, other) => other !== index))}
                  aria-label={`Remove variable ${index + 1}`}
                  title="Remove variable"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="w-[7.5rem] flex-shrink-0">
                  <ChoiceSelect
                    id={fieldDomId(null, `${at}.reducer`)}
                    value={field.reducer}
                    options={REDUCER_OPTIONS}
                    onChange={(reducer) => update(index, { reducer: reducer as WorkflowReducer })}
                    small
                    ariaLabel={`Variable ${index + 1} reducer`}
                  />
                </div>
                <DefaultField
                  id={fieldDomId(null, `${at}.default`)}
                  type={field.type}
                  value={field.default ?? null}
                  onChange={(value) => update(index, { default: value })}
                  label={`Variable ${index + 1} default`}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">{REDUCER_HINTS[field.reducer]}</p>
                <label className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title="Kept for the next run when a run completes">
                  <Toggle checked={Boolean(field.persist)} onChange={(persist) => update(index, { persist })} label={`Persist variable ${index + 1}`} />
                  Persist
                </label>
              </div>
              <FieldIssues issues={own} />
            </div>
          );
        })
      ) : (
        <EmptyNote>No variables yet. Add one to collect values across a loop&apos;s runs (or, with Persist, keep them between runs).</EmptyNote>
      )}
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={state.length >= max}
        onClick={() => onChange([...state, { name: "", type: "string", reducer: "overwrite", default: null, persist: false }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add variable
      </button>
    </div>
  );
}
