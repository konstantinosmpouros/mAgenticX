import * as React from "react";
import { Plus, Search, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type {
  WorkflowBuilderIssue,
  WorkflowTemplatePath,
  WorkflowToolArg,
  WorkflowToolInfo,
} from "@/shared/lib/types";
import { ICON_BUTTON, INPUT_SM, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { placeholder } from "@/features/workflows/lib/builder/templates";
import { argFromText, argText, asArgs, isTemplated, toolArgs } from "@/features/workflows/lib/builder/toolArgs";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { EmptyNote, Field } from "./FieldShell";
import { JsonField } from "./JsonField";
import { TemplateField, TemplateHelper } from "./TemplateField";

/** A number argument as text: kept as typed while typing; a plain number stored as a number, a placeholder as text. */
function NumberArg({
  id,
  arg,
  value,
  onChange,
  paths,
  invalid,
  describedBy,
  hint,
}: {
  id: string;
  arg: WorkflowToolArg;
  value: unknown;
  onChange: (value: unknown) => void;
  paths: readonly WorkflowTemplatePath[];
  invalid: boolean;
  describedBy?: string;
  hint?: string;
}) {
  const [text, setText] = React.useState(() => argText(value));
  React.useEffect(() => {
    // An outside change only (undo, another node): our own writes read back as the text.
    if (argFromText(arg.type, text) !== value && !(value === undefined && !text.trim())) setText(argText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TemplateField
      id={id}
      value={text}
      onChange={(next) => {
        setText(next);
        onChange(next.trim() ? argFromText(arg.type, next) : undefined);
      }}
      paths={paths}
      mono={false}
      placeholder={hint}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}

/** One argument's control, by its type; a value holding a `{{placeholder}}` is always templated text. */
function ArgControl({
  id,
  arg,
  value,
  onChange,
  paths,
  invalid,
  describedBy,
}: {
  id: string;
  arg: WorkflowToolArg;
  value: unknown;
  onChange: (value: unknown) => void;
  paths: readonly WorkflowTemplatePath[];
  invalid: boolean;
  describedBy?: string;
}) {
  const hint = arg.hasDefault ? `${argText(arg.default)} (default)` : undefined;
  const text = (next: string) => onChange(next ? next : undefined);
  if (isTemplated(value) || (arg.type === "string" && !arg.options)) {
    return (
      <TemplateField
        id={id}
        value={argText(value)}
        onChange={text}
        paths={paths}
        mono={false}
        placeholder={hint}
        invalid={invalid}
        describedBy={describedBy}
      />
    );
  }
  if (arg.options) {
    const options = arg.options;
    return (
      <ChoiceSelect
        id={id}
        value={value === undefined ? "" : argText(value)}
        options={options.map((option) => ({
          value: String(option),
          label: arg.hasDefault && option === arg.default ? `${String(option)} (default)` : String(option),
        }))}
        onChange={(next) => onChange(options.find((option) => String(option) === next) ?? next)}
        invalid={invalid}
        describedBy={describedBy}
      />
    );
  }
  switch (arg.type) {
    case "number":
    case "integer":
      return (
        <NumberArg
          id={id}
          arg={arg}
          value={value}
          onChange={onChange}
          paths={paths}
          invalid={invalid}
          describedBy={describedBy}
          hint={hint}
        />
      );
    case "boolean":
      return (
        <ChoiceSelect
          id={id}
          value={typeof value === "boolean" ? String(value) : ""}
          options={[
            { value: "true", label: arg.default === true ? "true (default)" : "true" },
            { value: "false", label: arg.default === false ? "false (default)" : "false" },
          ]}
          onChange={(next) => onChange(next === "true")}
          invalid={invalid}
          describedBy={describedBy}
        />
      );
    case "object":
    case "array":
      return <JsonField id={id} value={value} onChange={onChange} jsonType={arg.type} invalid={invalid} describedBy={describedBy} />;
    default:
      // No type given: text, or JSON when it reads as JSON.
      return (
        <LooseValueField
          id={id}
          value={value}
          onChange={(next) => onChange(next === null || next === "" ? undefined : next)}
          paths={paths}
          small={false}
          placeholder={hint}
          invalid={invalid}
          describedBy={describedBy}
        />
      );
  }
}

/** Whether an argument's control has no `{ }` of its own (a choice, on/off, JSON), so the row offers one. */
const needsHelper = (arg: WorkflowToolArg, value: unknown): boolean =>
  !isTemplated(value) && (Boolean(arg.options) || ["boolean", "object", "array"].includes(arg.type));

/** "+ Add optional argument": the tool's optional arguments not shown yet, each with its description. */
function AddOptionalArg({ options, onAdd }: { options: readonly WorkflowToolArg[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = options.filter((arg) =>
    words.every((word) => `${arg.name} ${arg.label} ${arg.description}`.toLowerCase().includes(word)),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={SMALL_BUTTON}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add optional argument
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        {options.length > 6 ? (
          <div className="relative mb-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search arguments"
              aria-label="Search arguments"
              className={cn(INPUT_SM, "pl-8")}
            />
          </div>
        ) : null}
        <div className="scrollbar-muted max-h-64 overflow-y-auto overscroll-contain" role="menu" aria-label="Optional arguments">
          {shown.length ? (
            shown.map((arg) => (
              <button
                key={arg.name}
                type="button"
                role="menuitem"
                title={arg.description || arg.name}
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  onAdd(arg.name);
                }}
                className="flex w-full min-w-0 flex-col rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:outline-none"
              >
                <span className="truncate text-[13px] font-medium text-foreground">{arg.label}</span>
                {arg.description ? (
                  <span className="line-clamp-2 break-words text-[11.5px] leading-snug text-muted-foreground">
                    {arg.description}
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">Nothing matches.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const RemoveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className={cn(ICON_BUTTON, "h-6 w-6")} onClick={onClick} aria-label={`Remove ${label}`} title="Remove">
    <X className="h-3.5 w-3.5" aria-hidden />
  </button>
);

/**
 * A tool step's arguments, from the picked tool's input schema: every
 * required one always shown (marked, its description as the hint), optional
 * ones added from "+ Add optional argument" and removed with ×; each edited
 * by its type — text and numbers as template fields (a plain number stored
 * as a number), choices and on/off as selects, objects and lists as JSON, a
 * `{ }` beside the latter to read the value from the run instead. A stored
 * name the tool doesn't take is shown, marked, so it can be removed.
 */
export function ToolArgsField({
  nodeId,
  where,
  value,
  onChange,
  tool,
  paths,
  issues,
}: {
  nodeId: string;
  /** The args field's address (`config.args`): each argument's issues sit at `<where>.<name>`. */
  where: string;
  value: unknown;
  onChange: (args: Record<string, unknown> | undefined) => void;
  tool: WorkflowToolInfo;
  paths: readonly WorkflowTemplatePath[];
  issues: readonly WorkflowBuilderIssue[];
}) {
  const args = asArgs(value);
  const specs = React.useMemo(() => toolArgs(tool.inputSchema), [tool]);
  // Optional arguments on screen: the ones stored, and the ones added but not filled yet.
  const [added, setAdded] = React.useState<ReadonlySet<string>>(() => new Set(Object.keys(args)));
  React.useEffect(() => {
    const keys = Object.keys(asArgs(value));
    setAdded((prev) => (keys.every((key) => prev.has(key)) ? prev : new Set([...prev, ...keys])));
  }, [value]);

  const write = (name: string, next: unknown) => {
    const out = { ...args };
    if (next === undefined) delete out[name];
    else out[name] = next;
    onChange(Object.keys(out).length ? out : undefined);
  };
  const remove = (name: string) => {
    setAdded((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    write(name, undefined);
  };

  const known = new Set(specs.map((arg) => arg.name));
  const shown = specs.filter((arg) => arg.required || arg.name in args || added.has(arg.name));
  const optional = specs.filter((arg) => !arg.required && !(arg.name in args) && !added.has(arg.name));
  const unknown = Object.keys(args).filter((name) => !known.has(name));
  const own = issues.filter((issue) => issue.field === where);

  return (
    <div className="space-y-4">
      {!shown.length && !unknown.length ? (
        <EmptyNote>{specs.length ? "No arguments needed. Add optional ones below." : "This tool takes no arguments."}</EmptyNote>
      ) : null}
      {shown.map((arg) => {
        const at = `${where}.${arg.name}`;
        const id = fieldDomId(nodeId, at);
        const direct = issues.filter((issue) => issueIsOn(issue, at));
        const issuesId = `${id}-issues`;
        const current = args[arg.name];
        const aside =
          needsHelper(arg, current) || !arg.required ? (
            <div className="-my-1 flex flex-shrink-0 items-center gap-0.5">
              {needsHelper(arg, current) ? (
                <TemplateHelper paths={paths} onPick={(path) => write(arg.name, placeholder(path))} className="h-6 w-6" />
              ) : null}
              {!arg.required ? <RemoveButton label={arg.label} onClick={() => remove(arg.name)} /> : null}
            </div>
          ) : null;
        return (
          <Field
            key={arg.name}
            label={arg.label}
            htmlFor={id}
            required={arg.required}
            hint={arg.description ? arg.description.replace(/\.?$/, ".") : null}
            aside={aside}
            issues={direct}
            issuesId={issuesId}
            className="min-w-0"
          >
            <ArgControl
              id={id}
              arg={arg}
              value={current}
              onChange={(next) => write(arg.name, next)}
              paths={paths}
              invalid={direct.some((issue) => issue.severity === "error")}
              describedBy={direct.length ? issuesId : undefined}
            />
          </Field>
        );
      })}
      {unknown.map((name) => {
        const at = `${where}.${name}`;
        const id = fieldDomId(nodeId, at);
        return (
          <Field
            key={`unknown:${name}`}
            label={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="max-w-[14rem] truncate">{name}</span>
                <span className="flex-shrink-0 rounded-md bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">
                  unknown
                </span>
              </span>
            }
            htmlFor={id}
            hint="This tool doesn't take this argument."
            aside={<RemoveButton label={name} onClick={() => remove(name)} />}
            issues={issues.filter((issue) => issueIsOn(issue, at))}
            className="min-w-0"
          >
            <LooseValueField id={id} value={args[name]} onChange={(next) => write(name, next)} paths={paths} small={false} />
          </Field>
        );
      })}
      {optional.length ? (
        <AddOptionalArg options={optional} onAdd={(name) => setAdded((prev) => new Set([...prev, name]))} />
      ) : null}
      {own.length ? <Field label="" issues={own}>{null}</Field> : null}
    </div>
  );
}
