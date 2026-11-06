import * as React from "react";
import { Braces, Search, TextCursorInput, Variable } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { WorkflowTemplatePath, WorkflowTemplateSource } from "@/shared/lib/types";
import { kindMeta } from "@/features/workflows/lib/kinds";
import { INPUT, INPUT_SM } from "@/features/workflows/lib/builder/consts";
import {
  groupTemplatePaths,
  placeholder,
  runSearchEntries,
  templatePathMatches,
} from "@/features/workflows/lib/builder/templates";
import { TemplateInput, type TemplateInputHandle } from "./TemplateInput";

/** A source's small icon tile: the step's kind glyph in its accent, or the inputs / variables glyph. */
export function TemplateSourceIcon({ source, className }: { source: Pick<WorkflowTemplateSource, "group" | "kind">; className?: string }) {
  if (source.group === "node" && source.kind) {
    const meta = kindMeta(source.kind);
    const Glyph = meta.icon;
    return (
      <span
        className={cn("flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md", className)}
        style={{ background: `hsl(${meta.accent} / 0.12)`, color: `hsl(${meta.accent})` }}
        aria-hidden
      >
        <Glyph className="h-3 w-3" />
      </span>
    );
  }
  const Glyph = source.group === "input" ? TextCursorInput : Variable;
  return (
    <span
      className={cn("flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", className)}
      aria-hidden
    >
      <Glyph className="h-3 w-3" />
    </span>
  );
}

const PICK_ROW =
  "flex w-full items-baseline justify-between gap-3 rounded-lg py-1.5 pl-8 pr-2 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:outline-none";

/**
 * The template picker: a `{ }` button opening what a field may read, as
 * people name it — grouped by source (each earlier step nearest first with
 * its icon, the run's inputs, the variables), each value with its type; a
 * step that runs in a loop under "Last run" and "Runs" sub-headings (`Every
 * run`, `Run 1`…`Run 5`; searching "run 7" offers `Run 7`); the rarely
 * wanted ones (an llm step's conversation, a whole result) under "More".
 * Search covers names and paths. Picking hands the path to `onPick`.
 */
export function TemplateHelper({
  paths,
  onPick,
  bare = false,
  className,
}: {
  paths: readonly WorkflowTemplatePath[];
  onPick: (path: string) => void;
  bare?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  /** A pick moves focus into the field: the popover must not pull it back to its button. */
  const picked = React.useRef(false);
  const shown = [...paths, ...runSearchEntries(paths, query)].filter((entry) => templatePathMatches(entry, query));
  const sources = groupTemplatePaths(shown.filter((entry) => !entry.more)).filter((source) => source.entries.length);
  const more = shown.filter((entry) => entry.more);
  const pick = (path: string) => {
    picked.current = true;
    setOpen(false);
    setQuery("");
    onPick(path);
  };
  const label = bare ? "Pick a value to check" : "Insert a value from the run";
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
          aria-label={label}
          title={label}
        >
          <Braces className="h-3.5 w-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(21rem,calc(100vw-2rem))] p-1.5"
        onCloseAutoFocus={(event) => {
          if (picked.current) event.preventDefault();
          picked.current = false;
        }}
      >
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search data"
            aria-label="Search data"
            className={cn(INPUT_SM, "pl-8")}
          />
        </div>
        <div className="scrollbar-muted max-h-72 overflow-y-auto overscroll-contain">
          {sources.length || more.length ? (
            <>
              {sources.map((source) => (
                <div key={source.key} role="group" aria-label={source.title} className="py-1">
                  <p className="flex min-w-0 items-center gap-2 px-1.5 pb-0.5 pt-1">
                    <TemplateSourceIcon source={source} />
                    <span className="truncate text-[12px] font-semibold text-foreground/85">{source.title}</span>
                  </p>
                  {source.entries.map((entry, index) => (
                    <React.Fragment key={entry.path}>
                      {entry.section && entry.section !== source.entries[index - 1]?.section ? (
                        <p className="truncate pb-0.5 pl-8 pr-2 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {entry.section}
                        </p>
                      ) : null}
                      <button type="button" title={entry.path} onClick={() => pick(entry.path)} className={PICK_ROW}>
                        <span className="min-w-0 truncate text-[13px] text-foreground">{entry.label}</span>
                        <span className="flex-shrink-0 text-[11px] text-muted-foreground">{entry.hint}</span>
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              ))}
              {more.length ? (
                <div role="group" aria-label="More" className="mt-1 border-t border-border/50 py-1">
                  <p className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">More</p>
                  {more.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      title={entry.path}
                      onClick={() => pick(entry.path)}
                      className={cn(PICK_ROW, "pl-2")}
                    >
                      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                        {entry.source} <span aria-hidden>›</span> <span className="text-foreground/85">{entry.label}</span>
                      </span>
                      <span className="flex-shrink-0 text-[11px] text-muted-foreground">{entry.hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
              {paths.length
                ? "Nothing matches."
                : "Nothing to read yet: declare inputs in the workflow's settings, add a Set step, or connect a step before this one."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A dropped `{{path}}` in a bare path field: just the path. */
const BARE_DROP = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/**
 * A text field that takes `{{placeholders}}`, shown as chips
 * (`TemplateInput`), with the picker inside its right edge inserting at the
 * caret. `bare` (a rule's path) stays a plain input whose value is the path
 * itself. The `{ }` button is how a field gets data from earlier steps.
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
  const editor = React.useRef<TemplateInputHandle>(null);
  const insertPath = (path: string) => {
    if (bare) onChange(path);
    else editor.current?.insertText(placeholder(path));
  };
  const helperPosition = cn("absolute right-1", small ? "top-[3px] h-6 w-6" : "top-1.5");
  return (
    <div className="relative min-w-0 flex-1">
      {bare ? (
        <input
          id={id}
          value={value}
          placeholder={hint}
          maxLength={maxLength}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onDrop={(event) => {
            const match = BARE_DROP.exec(event.dataTransfer.getData("text/plain"));
            if (!match) return;
            event.preventDefault();
            onChange(match[1]);
          }}
          className={cn(small ? INPUT_SM : INPUT, "pr-9", mono && "font-mono text-[12.5px]")}
        />
      ) : (
        <TemplateInput
          ref={editor}
          id={id}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          paths={paths}
          multiline={multiline}
          small={small}
          placeholder={hint}
          invalid={invalid}
          describedBy={describedBy}
          ariaLabel={ariaLabel}
          mono={mono}
          maxLength={maxLength}
          className="pr-9"
        />
      )}
      <TemplateHelper paths={paths} onPick={insertPath} bare={bare} className={helperPosition} />
    </div>
  );
}
