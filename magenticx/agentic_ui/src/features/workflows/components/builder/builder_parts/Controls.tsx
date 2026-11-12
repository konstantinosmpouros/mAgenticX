import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import type { WorkflowTemplatePath } from "@/shared/lib/types";
import { INPUT, INPUT_SM } from "@/features/workflows/lib/builder/consts";
import { describeLoose, formatLoose, parseLoose } from "@/features/workflows/lib/builder/values";
import { TemplateField } from "./TemplateField";

/**
 * The inspector's small shared controls: a select in the agent builder's
 * style, and a value field that reads JSON-ish text (`parseLoose`) and keeps
 * what the user typed while they type.
 */

export function ChoiceSelect({
  id,
  value,
  options,
  onChange,
  small = false,
  ariaLabel,
  invalid,
  describedBy,
  placeholder = "Choose",
}: {
  id?: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: React.ReactNode }>;
  onChange: (value: string) => void;
  small?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(small ? INPUT_SM : INPUT, "h-auto justify-between gap-2")}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="rounded-lg">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const sameValue = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
};

/**
 * A free value: JSON when the text reads as JSON (a number, true, an object),
 * else the text — placeholders included. Keeps the typed text as is while
 * focused; a value changed from outside (undo) replaces it.
 */
export function LooseValueField({
  id,
  value,
  onChange,
  paths,
  small = true,
  multiline = false,
  placeholder,
  ariaLabel,
  invalid,
  describedBy,
  showKind = false,
}: {
  id?: string;
  value: unknown;
  onChange: (value: unknown) => void;
  paths: readonly WorkflowTemplatePath[];
  small?: boolean;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  /** Say under the field what the text reads as (a number, text, an object). */
  showKind?: boolean;
}) {
  const [text, setText] = React.useState(() => formatLoose(value));
  React.useEffect(() => {
    if (!sameValue(parseLoose(text), value)) setText(formatLoose(value));
    // Only an outside change re-syncs; `text` is ours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="min-w-0 flex-1">
      <TemplateField
        id={id}
        value={text}
        onChange={(next) => {
          setText(next);
          onChange(parseLoose(next));
        }}
        paths={paths}
        small={small}
        multiline={multiline}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        invalid={invalid}
        describedBy={describedBy}
      />
      {showKind && text.trim() && typeof parseLoose(text) !== "string" ? (
        // Only when the text is taken as something else (a number, a list, an object): plain text needs no note.
        <p className="mt-1 text-[11px] text-muted-foreground">Reads as {describeLoose(parseLoose(text))}.</p>
      ) : null}
    </div>
  );
}
