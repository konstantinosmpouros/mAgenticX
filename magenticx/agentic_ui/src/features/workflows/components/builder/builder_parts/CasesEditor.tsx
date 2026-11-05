import * as React from "react";
import { ArrowDown, ArrowUp, GitFork, Plus, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowRouterCase,
  WorkflowTemplatePath,
} from "@/shared/lib/types";
import { ICON_BUTTON, INPUT_SM, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldDomId, newCaseName } from "@/features/workflows/lib/builder/ids";
import { MATCH_MODES, emptyCase } from "@/features/workflows/lib/builder/schemaForm";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { ChoiceSelect } from "./Controls";
import { FieldIssues } from "./FieldShell";
import { RulesEditor } from "./RulesEditor";

/**
 * A case's name: committed as it is typed while it is not empty (so its edge
 * follows the rename), never committed empty — leaving the field empty puts
 * the last name back.
 */
function CaseName({
  id,
  name,
  onRename,
  invalid,
  index,
}: {
  id: string;
  name: string;
  onRename: (next: string) => void;
  invalid: boolean;
  index: number;
}) {
  const [text, setText] = React.useState(name);
  React.useEffect(() => {
    if (text.trim() && text.trim() !== name) setText(name);
    // An outside change (undo) only; an empty field is ours until blur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return (
    <div className="min-w-0 flex-1">
      <input
        id={id}
        value={text}
        onChange={(event) => {
          const next = event.target.value.toLowerCase().replace(/\s+/g, "_");
          setText(next);
          if (next.trim()) onRename(next.trim());
        }}
        onBlur={() => {
          if (!text.trim()) setText(name);
        }}
        maxLength={32}
        spellCheck={false}
        aria-label={`Case ${index + 1} name`}
        aria-invalid={invalid || !text.trim() || undefined}
        className={cn(INPUT_SM, "font-mono")}
        placeholder="case name"
      />
      {!text.trim() ? <p className="mt-1 text-xs text-destructive">A case needs a name.</p> : null}
    </div>
  );
}

/**
 * A router's cases, tried in order — the first whose rules hold picks the
 * branch; none does → `default`. Each case's name is a branch: a handle on
 * the card, renamed with its edge, dropped with it.
 */
export function CasesEditor({
  nodeId,
  field,
  cases,
  onChange,
  paths,
  issues,
  max = 16,
}: {
  nodeId: string;
  field: string;
  cases: WorkflowRouterCase[];
  onChange: (cases: WorkflowRouterCase[], change?: WorkflowCasesChange) => void;
  paths: readonly WorkflowTemplatePath[];
  issues: readonly WorkflowBuilderIssue[];
  max?: number;
}) {
  const update = (index: number, patch: Partial<WorkflowRouterCase>, change?: WorkflowCasesChange) =>
    onChange(
      cases.map((item, at) => (at === index ? { ...item, ...patch } : item)),
      change,
    );
  const move = (index: number, by: -1 | 1) => {
    const next = [...cases];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  const listIssues = issues.filter((issue) => issue.field === field);
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {cases.map((item, index) => {
          const at = `${field}[${index}]`;
          const nameIssues = issues.filter((issue) => issueIsOn(issue, `${at}.name`));
          const caseIssues = issues.filter(
            (issue) => issueIsOn(issue, at) && !issueIsOn(issue, `${at}.name`) && !issueIsOn(issue, `${at}.rules`),
          );
          return (
            <li
              key={`case-${index}`}
              className="rounded-2xl border border-border/60 bg-card/70 p-3 shadow-[0_1px_0_hsl(var(--foreground)/0.03)]"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/[0.1] text-[11px] font-semibold tabular-nums text-primary"
                  aria-hidden
                >
                  {index + 1}
                </span>
                <CaseName
                  id={fieldDomId(nodeId, `${at}.name`)}
                  name={item.name}
                  index={index}
                  invalid={nameIssues.some((issue) => issue.severity === "error")}
                  onRename={(next) =>
                    update(index, { name: next }, item.name && item.name !== next ? { rename: [item.name, next] } : undefined)
                  }
                />
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move case ${index + 1} up`}
                  title="Try earlier"
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => move(index, 1)}
                  disabled={index === cases.length - 1}
                  aria-label={`Move case ${index + 1} down`}
                  title="Try later"
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, "hover:text-destructive")}
                  onClick={() =>
                    onChange(
                      cases.filter((_, other) => other !== index),
                      item.name ? { drop: item.name } : undefined,
                    )
                  }
                  disabled={cases.length <= 1}
                  aria-label={`Remove case ${index + 1}`}
                  title="Remove case (and its connection)"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <FieldIssues issues={nameIssues} />
              <div className="mt-2.5">
                <ChoiceSelect
                  value={item.mode}
                  options={MATCH_MODES}
                  onChange={(mode) => update(index, { mode: mode === "any" ? "any" : "all" })}
                  small
                  ariaLabel={`Case ${index + 1}: how its rules combine`}
                />
              </div>
              <div className="mt-2.5">
                <RulesEditor
                  nodeId={nodeId}
                  field={`${at}.rules`}
                  rules={item.rules}
                  onChange={(rules) => update(index, { rules })}
                  paths={paths}
                  issues={issues}
                  min={1}
                />
              </div>
              <FieldIssues issues={caseIssues} />
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <GitFork className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span>
          No case matches → the <span className="font-mono text-foreground">default</span> branch.
        </span>
      </div>
      <FieldIssues issues={listIssues} />
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={cases.length >= max}
        onClick={() => onChange([...cases, emptyCase(newCaseName(new Set(cases.map((c) => c.name))))])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add case
      </button>
    </div>
  );
}
