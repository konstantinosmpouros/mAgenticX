import * as React from "react";
import { Braces, Search } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { WorkflowTemplatePath } from "@/shared/lib/types";
import { INPUT, INPUT_SM } from "@/features/workflows/lib/builder/consts";
import { placeholder } from "@/features/workflows/lib/builder/templates";

const GROUP_LABELS: Record<WorkflowTemplatePath["group"], string> = {
  input: "Run inputs",
  state: "State",
  node: "Earlier steps",
  output: "This step's result",
};

/**
 * The template helper: a `{ }` button that lists what a field may read —
 * run inputs, state fields, earlier steps' outputs (and, in `assign`, this
 * step's own result) — and inserts the one picked. `bare` inserts the path
 * itself (a rule's path), else a `{{placeholder}}`.
 */
export function TemplateHelper({
  paths,
  onPick,
  bare = false,
  className,
}: {
  paths: readonly WorkflowTemplatePath[];
  onPick: (text: string) => void;
  bare?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const shown = paths.filter((entry) => entry.path.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = (Object.keys(GROUP_LABELS) as Array<WorkflowTemplatePath["group"]>)
    .map((group) => ({ group, items: shown.filter((entry) => entry.group === group) }))
    .filter((entry) => entry.items.length);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            className,
          )}
          aria-label={bare ? "Pick a path" : "Insert a value from the run"}
          title={bare ? "Pick a path" : "Insert a value from the run"}
        >
          <Braces className="h-3.5 w-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter paths"
            aria-label="Filter paths"
            className={cn(INPUT_SM, "pl-8")}
          />
        </div>
        <div className="scrollbar-muted max-h-64 overflow-y-auto">
          {groups.length ? (
            groups.map(({ group, items }) => (
              <div key={group} className="py-1">
                <p className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {GROUP_LABELS[group]}
                </p>
                {items.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                      onPick(bare ? entry.path : placeholder(entry.path));
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:outline-none"
                  >
                    <span className="min-w-0 truncate font-mono text-[12px] text-foreground">{entry.path}</span>
                    <span className="flex-shrink-0 text-[10.5px] text-muted-foreground">{entry.hint}</span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
              {paths.length
                ? "Nothing matches."
                : "Nothing to read yet: declare inputs or state in the workflow's settings, or connect a step before this one."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A text field that takes `{{placeholders}}`: the helper sits inside its
 * right edge and inserts at the caret (or, `bare`, replaces the value).
 */
export function TemplateField({
  id,
  value,
  onChange,
  onBlur,
  paths,
  multiline = false,
  bare = false,
  small = false,
  placeholder: hint,
  invalid,
  describedBy,
  ariaLabel,
  mono = true,
  maxLength,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  paths: readonly WorkflowTemplatePath[];
  multiline?: boolean;
  bare?: boolean;
  small?: boolean;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  ariaLabel?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  const ref = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    if (bare) {
      onChange(text);
      return;
    }
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      element?.focus({ preventScroll: true });
      element?.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const shared = {
    id,
    value,
    placeholder: hint,
    maxLength,
    "aria-label": ariaLabel,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    onBlur,
    spellCheck: false,
    className: cn(small ? INPUT_SM : INPUT, "pr-9", mono && "font-mono text-[12.5px]"),
  };
  return (
    <div className="relative min-w-0 flex-1">
      {multiline ? (
        <textarea
          ref={ref}
          rows={3}
          {...shared}
          className={cn(shared.className, "block resize-y leading-relaxed")}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input ref={ref} {...shared} onChange={(event) => onChange(event.target.value)} />
      )}
      <TemplateHelper
        paths={paths}
        onPick={insert}
        bare={bare}
        className={cn("absolute right-1", small ? "top-[3px] h-6 w-6" : "top-1.5")}
      />
    </div>
  );
}
