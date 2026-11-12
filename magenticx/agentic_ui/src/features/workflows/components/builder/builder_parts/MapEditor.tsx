import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import type { WorkflowMapValueKind, WorkflowTemplatePath } from "@/shared/lib/types";
import { ADD_BUTTON, ICON_BUTTON, INPUT_SM } from "@/features/workflows/lib/builder/consts";
import { LooseValueField } from "./Controls";
import { TemplateField } from "./TemplateField";

type Row = { key: string; value: unknown };

const rowsOf = (value: unknown): Row[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({ key, value: entry }))
    : [];

/**
 * A name → value map: `headers`, `query`, `args`, `outputs`, and a Set step's
 * `values` (variable name → template, with the names other Set steps use
 * offered as suggestions). Rows keep their order and an unfinished row (no
 * name yet) stays on screen without being written; a name typed twice is
 * flagged on its row (only the first is written). Values are templated
 * text, or — for `scalar` / `any` maps — JSON-ish text (`200`, `true`,
 * `{"a": 1}`).
 */
export function MapEditor({
  id,
  value,
  onChange,
  paths,
  valueKind = "any",
  keySuggestions,
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
  /** Names offered while typing one (a Set step: the variables other Set steps write); any name may be typed. */
  keySuggestions?: readonly string[];
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
  // The names not yet used here; the suggestions list is shared by every row of this map.
  const reactId = React.useId();
  const suggestionsId = keySuggestions?.length ? `${id ?? reactId}-names` : undefined;
  const suggested = keySuggestions?.filter((name) => !rows.some((row) => row.key.trim() === name)) ?? [];
  // A name an earlier row already has: it is not written, so say so on its row.
  const repeated = rows.map(
    (row, index) => Boolean(row.key.trim()) && rows.slice(0, index).some((other) => other.key.trim() === row.key.trim()),
  );

  return (
    <div id={id} className="space-y-2" tabIndex={-1}>
      {suggestionsId ? (
        <datalist id={suggestionsId}>
          {suggested.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      {rows.length ? (
        rows.map((row, index) => (
          <div key={`row-${index}`} className="flex items-start gap-1.5">
            <div className="w-[38%] flex-shrink-0">
              <input
                value={row.key}
                onChange={(event) => update(index, { key: event.target.value })}
                placeholder={keyPlaceholder}
                aria-label={`Entry ${index + 1} name`}
                aria-invalid={repeated[index] || undefined}
                aria-describedby={repeated[index] ? `${id ?? reactId}-repeat-${index}` : undefined}
                list={suggestionsId}
                spellCheck={false}
                autoComplete="off"
                className={`${INPUT_SM} font-mono`}
              />
              {repeated[index] ? (
                <p id={`${id ?? reactId}-repeat-${index}`} className="mt-0.5 text-[11px] leading-snug text-destructive">
                  Used above: not saved.
                </p>
              ) : null}
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
        // Empty: the add action says it all; the empty text stays for screen readers.
        <p className="sr-only">{emptyText}</p>
      )}
      <button
        type="button"
        className={ADD_BUTTON}
        disabled={max !== undefined && rows.length >= max}
        onClick={() => commit([...rows, { key: "", value: valueKind === "string" ? "" : null }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {addLabel}
      </button>
    </div>
  );
}
