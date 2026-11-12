import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Plus, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderIssue,
  WorkflowRule,
  WorkflowRuleOp,
  WorkflowTemplatePath,
} from "@/shared/lib/types";
import { ADD_BUTTON, ICON_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { RULE_OPS, emptyRule, isUnaryOp } from "@/features/workflows/lib/builder/schemaForm";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { EmptyNote, FieldIssues } from "./FieldShell";
import { TemplateField } from "./TemplateField";

const OP_OPTIONS = RULE_OPS.map((entry) => ({ value: entry.op, label: entry.label }));

const RULE_ENTER = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: "easeIn" } },
} as const;
const RULE_ENTER_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.01 } },
  exit: { opacity: 0, transition: { duration: 0.01 } },
} as const;

/**
 * A list of structured rules `(path, op, value)` — a condition's, a router
 * case's, a loop's `while`. Each rule is two lines of fields — the path to
 * test (picked from what the run holds, or typed), then the operator and the
 * value to compare with (none for `exists` / `empty`) — and the rules are
 * joined by an AND / OR divider that says how they combine. No box around a
 * rule: the fields are the structure, so a router's cases never stack
 * containers inside containers.
 */
export function RulesEditor({
  nodeId,
  field,
  rules,
  onChange,
  paths,
  issues,
  joiner = "and",
  max = 20,
  min = 0,
}: {
  nodeId: string;
  /** The issue field of the list (`config.rules`, `config.cases[0].rules`). */
  field: string;
  rules: WorkflowRule[];
  onChange: (rules: WorkflowRule[]) => void;
  /** Bare paths for the path picker. */
  paths: readonly WorkflowTemplatePath[];
  issues: readonly WorkflowBuilderIssue[];
  /** How the rules combine, shown between them. */
  joiner?: "and" | "or";
  max?: number;
  min?: number;
}) {
  const reduceMotion = useReducedMotion();
  const update = (index: number, patch: Partial<WorkflowRule>) =>
    onChange(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  const listIssues = issues.filter((issue) => issue.field === field);
  return (
    <div className="space-y-1">
      {rules.length ? (
        <div>
          <AnimatePresence initial={false}>
            {rules.map((rule, index) => {
              const at = `${field}[${index}]`;
              const pathIssues = issues.filter((issue) => issueIsOn(issue, `${at}.path`));
              const opIssues = issues.filter((issue) => issueIsOn(issue, `${at}.op`) || issueIsOn(issue, `${at}.value`));
              const unary = isUnaryOp(rule.op);
              const removable = rules.length > min;
              return (
                <motion.div
                  key={`rule-${index}`}
                  {...(reduceMotion ? RULE_ENTER_REDUCED : RULE_ENTER)}
                  role="group"
                  aria-label={`Rule ${index + 1}`}
                >
                  {index > 0 ? (
                    <div className="flex items-center gap-2 py-2" aria-hidden>
                      <span className="rounded-md bg-muted/80 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {joiner}
                      </span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <TemplateField
                        id={fieldDomId(nodeId, `${at}.path`)}
                        value={rule.path}
                        onChange={(path) => update(index, { path })}
                        paths={paths}
                        bare
                        small
                        placeholder="Value to test"
                        ariaLabel={`Rule ${index + 1} path`}
                        invalid={pathIssues.length > 0}
                      />
                      {removable ? (
                        <button
                          type="button"
                          className={cn(ICON_BUTTON, "hover:text-destructive")}
                          onClick={() => onChange(rules.filter((_, other) => other !== index))}
                          aria-label={`Remove rule ${index + 1}`}
                          title="Remove rule"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    <div className={cn("flex items-start gap-1.5", removable && "pr-8")}>
                      <div className={cn("flex-shrink-0", unary ? "w-full" : "w-[8.5rem]")}>
                        <ChoiceSelect
                          id={fieldDomId(nodeId, `${at}.op`)}
                          value={rule.op}
                          options={OP_OPTIONS}
                          onChange={(op) =>
                            update(index, isUnaryOp(op) ? { op: op as WorkflowRuleOp, value: null } : { op: op as WorkflowRuleOp })
                          }
                          small
                          ariaLabel={`Rule ${index + 1} operator`}
                        />
                      </div>
                      {unary ? null : (
                        <LooseValueField
                          id={fieldDomId(nodeId, `${at}.value`)}
                          value={rule.value}
                          onChange={(value) => update(index, { value })}
                          paths={paths}
                          placeholder="200, true, text or {{…}}"
                          ariaLabel={`Rule ${index + 1} value`}
                        />
                      )}
                    </div>
                    <FieldIssues issues={[...pathIssues, ...opIssues]} />
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      ) : (
        <EmptyNote>No rules: {min ? "add one to decide the branch." : "it keeps going until its cap."}</EmptyNote>
      )}
      <FieldIssues issues={listIssues} />
      <button
        type="button"
        className={ADD_BUTTON}
        onClick={() => onChange([...rules, emptyRule()])}
        disabled={rules.length >= max}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add rule
      </button>
    </div>
  );
}
