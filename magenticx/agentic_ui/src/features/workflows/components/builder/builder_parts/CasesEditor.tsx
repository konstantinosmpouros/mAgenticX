import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown, ArrowUp, CornerDownRight, Plus, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Segmented } from "@/shared/ui/segmented";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowMatchMode,
  WorkflowRouterCase,
  WorkflowTemplatePath,
} from "@/shared/lib/types";
import { ADD_BUTTON, ICON_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldDomId, newCaseName } from "@/features/workflows/lib/builder/ids";
import { emptyCase } from "@/features/workflows/lib/builder/schemaForm";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { FieldIssues } from "./FieldShell";
import { RulesEditor } from "./RulesEditor";

const MODE_OPTIONS: { id: WorkflowMatchMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "any", label: "Any" },
];

const CASE_ENTER = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: "easeIn" } },
} as const;
const CASE_ENTER_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.01 } },
  exit: { opacity: 0, transition: { duration: 0.01 } },
} as const;

/**
 * A case's name, edited in place as the section's title: committed as it is
 * typed while it is not empty (so its edge follows the rename), never
 * committed empty — leaving the field empty puts the last name back.
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
        className="w-full min-w-0 rounded-lg border border-transparent bg-transparent px-1.5 py-1 font-mono text-[13.5px] font-semibold text-foreground transition-[border-color,background-color,box-shadow] placeholder:font-normal placeholder:text-muted-foreground/70 hover:border-border/60 focus-visible:border-primary/50 focus-visible:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 aria-[invalid=true]:border-destructive/60"
        placeholder="case name"
      />
      {!text.trim() ? <p className="mt-1 px-1.5 text-xs text-destructive">A case needs a name.</p> : null}
    </div>
  );
}

/** A branch's number, the same badge for a case and (muted) for the default. */
function BranchBadge({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold tabular-nums",
        muted ? "bg-muted text-muted-foreground" : "bg-primary/[0.12] text-primary",
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

/**
 * A router's cases, tried in order — the first whose rules hold picks the
 * branch; none does → `default`. Each case's name is a branch: a handle on
 * the card, renamed with its edge, dropped with it. Cases are sections split
 * by a hairline, each a title row (number, name, order, remove), how its
 * rules combine, and its rules — and the default branch closes the list the
 * same way, so the whole routing reads top to bottom as one decision.
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
  const reduceMotion = useReducedMotion();
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
    <div className="space-y-2">
      <ol className="divide-y divide-border/50 border-y border-border/50">
        <AnimatePresence initial={false}>
          {cases.map((item, index) => {
            const at = `${field}[${index}]`;
            const nameIssues = issues.filter((issue) => issueIsOn(issue, `${at}.name`));
            const caseIssues = issues.filter(
              (issue) => issueIsOn(issue, at) && !issueIsOn(issue, `${at}.name`) && !issueIsOn(issue, `${at}.rules`),
            );
            return (
              <motion.li
                key={`case-${index}`}
                {...(reduceMotion ? CASE_ENTER_REDUCED : CASE_ENTER)}
                className="space-y-3 py-4"
              >
                <div className="flex items-center gap-1">
                  <BranchBadge>{index + 1}</BranchBadge>
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
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <FieldIssues issues={nameIssues} />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Matches when</span>
                  <div className="w-[6.5rem] flex-shrink-0">
                    <Segmented
                      size="sm"
                      ariaLabel={`Case ${index + 1}: how its rules combine`}
                      value={item.mode === "any" ? "any" : "all"}
                      options={MODE_OPTIONS}
                      onChange={(mode) => update(index, { mode })}
                    />
                  </div>
                  <span>rules hold</span>
                </div>
                <RulesEditor
                  nodeId={nodeId}
                  field={`${at}.rules`}
                  rules={item.rules}
                  joiner={item.mode === "any" ? "or" : "and"}
                  onChange={(rules) => update(index, { rules })}
                  paths={paths}
                  issues={issues}
                  min={1}
                />
                <FieldIssues issues={caseIssues} />
              </motion.li>
            );
          })}
        </AnimatePresence>
        <li className="flex items-center gap-2.5 py-3 text-xs text-muted-foreground">
          <BranchBadge muted>
            <CornerDownRight className="h-3 w-3" />
          </BranchBadge>
          <span>
            Otherwise, the <span className="font-mono font-medium text-foreground">default</span> branch.
          </span>
        </li>
      </ol>
      <FieldIssues issues={listIssues} />
      <button
        type="button"
        className={ADD_BUTTON}
        disabled={cases.length >= max}
        onClick={() => onChange([...cases, emptyCase(newCaseName(new Set(cases.map((c) => c.name))))])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add case
      </button>
    </div>
  );
}
