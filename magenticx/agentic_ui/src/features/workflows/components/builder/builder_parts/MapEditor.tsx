import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import type { WorkflowMapValueKind, WorkflowTemplatePath } from "@/shared/lib/types";
import { ICON_BUTTON, INPUT_SM, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { EmptyNote } from "./FieldShell";
import { TemplateField } from "./TemplateField";

type Row = { key: string; value: unknown };

const rowsOf = (value: unknown): Row[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({ key, value: entry }))
    : [];

/**
 * A name → value map: `headers`, `query`, `args`, `outputs`, and `assign`
 * (where the names are the declared state fields, picked from a list). Rows
 * keep their order and an unfinished row (no name yet) stays on screen
 * without being written. Values are templated text, or — for `scalar` / `any`
 * maps — JSON-ish text (`200`, `true`, `{"a": 1}`).
 */
export function MapEditor({
  id,
  value,
  onChange,
  paths,
  valueKind = "any",
  keyOptions,
  keyPlaceholder = "name",
  valuePlaceholder = "value or {{…}}",
  addLabel = "Add entry",
  emptyText,
  max,
}: {
  id?: string;
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
  paths: readonly WorkflowTemplatePath[];
  valueKind?: WorkflowMapValueKind;
  /** The names allowed (assign: the state fields); a free text name otherwise. */
  keyOptions?: readonly string[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  emptyText: React.ReactNode;
  max?: number;
}) {
  const [rows, setRows] = React.useState<Row[]>(() => rowsOf(value));
  // An outside change (undo, another node picked) replaces the rows; our own write does not.
  const written = React.useRef(value);
  React.useEffect(() => {
    if (value !== written.current) {
      written.current = value;
      setRows(rowsOf(value));
    }
  }, [value]);

  const commit = (next: Row[]) => {
    setRows(next);
    const out: Record<string, unknown> = {};
    for (const row of next) if (row.key.trim() && !(row.key.trim() in out)) out[row.key.trim()] = row.value;
    written.current = out;
    onChange(out);
  };
  const update = (index: number, patch: Partial<Row>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const free = keyOptions?.filter((name) => !rows.some((row) => row.key === name)) ?? [];

  return (
    <div id={id} className="space-y-2" tabIndex={-1}>
      {rows.length ? (
        rows.map((row, index) => (
          <div key={`row-${index}`} className="flex items-start gap-1.5">
            <div className="w-[38%] flex-shrink-0">
              {keyOptions ? (
                <ChoiceSelect
                  value={row.key}
                  options={[...(row.key ? [row.key] : []), ...free].map((name) => ({ value: name, label: name }))}
                  onChange={(key) => update(index, { key })}
                  small
                  ariaLabel={`Entry ${index + 1} name`}
                  placeholder="State field"
                />
              ) : (
                <input
                  value={row.key}
                  onChange={(event) => update(index, { key: event.target.value })}
                  placeholder={keyPlaceholder}
                  aria-label={`Entry ${index + 1} name`}
                  spellCheck={false}
                  className={`${INPUT_SM} font-mono`}
                />
              )}
            </div>
            {valueKind === "string" ? (
              <TemplateField
                value={typeof row.value === "string" ? row.value : row.value == null ? "" : JSON.stringify(row.value)}
                onChange={(next) => update(index, { value: next })}
                paths={paths}
                small
                placeholder={valuePlaceholder}
                ariaLabel={`Entry ${index + 1} value`}
              />
            ) : (
              <LooseValueField
                value={row.value}
                onChange={(next) => update(index, { value: next })}
                paths={paths}
                placeholder={valuePlaceholder}
                ariaLabel={`Entry ${index + 1} value`}
              />
            )}
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => commit(rows.filter((_, at) => at !== index))}
              aria-label={`Remove entry ${index + 1}`}
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))
      ) : (
        <EmptyNote>{emptyText}</EmptyNote>
      )}
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={(max !== undefined && rows.length >= max) || (keyOptions !== undefined && free.length === 0)}
        onClick={() => commit([...rows, { key: keyOptions ? (free[0] ?? "") : "", value: valueKind === "string" ? "" : null }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {addLabel}
      </button>
    </div>
  );
}
