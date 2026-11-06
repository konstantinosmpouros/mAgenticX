import { Variable } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { EmptyNote } from "./FieldShell";

/** One variable in the "Keep for the next run" list: a checkbox, the variable's glyph and name. */
function VariableRow({
  name,
  kept,
  note,
  onToggle,
}: {
  name: string;
  kept: boolean;
  /** Why a kept name is odd (no Set step writes it). */
  note?: string;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={cn(
          "flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[hsl(var(--hover-surface))]",
          kept && "bg-primary/[0.06]",
        )}
      >
        <input
          type="checkbox"
          checked={kept}
          onChange={onToggle}
          className="h-4 w-4 flex-shrink-0 accent-[hsl(var(--primary))]"
        />
        <span
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          aria-hidden
        >
          <Variable className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12.5px] text-foreground">{name}</span>
          {note ? <span className="block truncate text-[11px] text-destructive">{note}</span> : null}
        </span>
      </label>
    </li>
  );
}

/**
 * An End step's "Keep for the next run" (`"x-widget": "keep"`): which of the
 * workflow's variables (the names its Set steps write) the next run starts
 * with, carried over from this one. A kept name no Set step writes any more
 * still shows, flagged, so it can be unticked.
 */
export function KeepField({
  id,
  value,
  onChange,
  variables,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (value: string[]) => void;
  /** The workflow's variable names (`variableNames`). */
  variables: readonly string[];
  describedBy?: string;
}) {
  const kept = Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  const offered = new Set(variables);
  const strays = [...new Set(kept.filter((name) => !offered.has(name)))];
  const toggle = (name: string) =>
    onChange(kept.includes(name) ? kept.filter((other) => other !== name) : [...new Set([...kept, name])]);

  if (!variables.length && !strays.length) {
    return (
      <div id={id} tabIndex={-1} className="outline-none" aria-describedby={describedBy}>
        <EmptyNote>Add a Set step to create variables.</EmptyNote>
      </div>
    );
  }
  return (
    <ul
      id={id}
      tabIndex={-1}
      aria-label="Variables to keep"
      aria-describedby={describedBy}
      className="max-h-60 space-y-0.5 overflow-y-auto rounded-xl border border-border/60 bg-background/50 p-1 outline-none"
    >
      {variables.map((name) => (
        <VariableRow key={name} name={name} kept={kept.includes(name)} onToggle={() => toggle(name)} />
      ))}
      {strays.map((name) => (
        <VariableRow
          key={`stray-${name}`}
          name={name}
          kept
          note="No Set step writes it."
          onToggle={() => toggle(name)}
        />
      ))}
    </ul>
  );
}
