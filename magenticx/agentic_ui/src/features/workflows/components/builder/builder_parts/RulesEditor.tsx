import { Plus, Trash2 } from "lucide-react";

import type {
  WorkflowBuilderIssue,
  WorkflowRule,
  WorkflowRuleOp,
  WorkflowTemplatePath,
} from "@/shared/lib/types";
import { ICON_BUTTON, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import { RULE_OPS, emptyRule, isUnaryOp } from "@/features/workflows/lib/builder/schemaForm";
import { issueIsOn } from "@/features/workflows/lib/builder/validate";
import { ChoiceSelect, LooseValueField } from "./Controls";
import { EmptyNote, FieldIssues } from "./FieldShell";
import { TemplateField } from "./TemplateField";

const OP_OPTIONS = RULE_OPS.map((entry) => ({ value: entry.op, label: entry.label }));

/**
 * A list of structured rules `(path, op, value)` — a condition's, a router
 * case's, a loop's `while`. One card per rule: the path to test (picked from
 * what the run holds, or typed), the operator, and the value to compare with
 * (none for `exists` / `empty`).
 */
export function RulesEditor({
  nodeId,
  field,
  rules,
  onChange,
  paths,
  issues,
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
  max?: number;
  min?: number;
}) {
  const update = (index: number, patch: Partial<WorkflowRule>) =>
    onChange(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  const listIssues = issues.filter((issue) => issue.field === field);
  return (
    <div className="space-y-2">
      {rules.length ? (
        rules.map((rule, index) => {
          const at = `${field}[${index}]`;
          const pathIssues = issues.filter((issue) => issueIsOn(issue, `${at}.path`));
          const opIssues = issues.filter((issue) => issueIsOn(issue, `${at}.op`) || issueIsOn(issue, `${at}.value`));
          const unary = isUnaryOp(rule.op);
          return (
            <div
              key={`rule-${index}`}
              className="rounded-xl border border-border/60 bg-muted/20 p-2.5"
              role="group"
              aria-label={`Rule ${index + 1}`}
            >
              <div className="flex items-center gap-1.5">
                <TemplateField
                  id={fieldDomId(nodeId, `${at}.path`)}
                  value={rule.path}
                  onChange={(path) => update(index, { path })}
                  paths={paths}
                  bare
                  small
                  placeholder="nodes.fetch.output.status"
                  ariaLabel={`Rule ${index + 1} path`}
                  invalid={pathIssues.length > 0}
                />
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => onChange(rules.filter((_, at2) => at2 !== index))}
                  disabled={rules.length <= min}
                  aria-label={`Remove rule ${index + 1}`}
                  title="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <div className="mt-1.5 flex items-start gap-1.5">
                <div className="w-[8.5rem] flex-shrink-0">
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
                {unary ? (
                  <p className="self-center text-xs text-muted-foreground">No value needed.</p>
                ) : (
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
          );
        })
      ) : (
        <EmptyNote>No rules: {min ? "add one to decide the branch." : "it keeps going until its cap."}</EmptyNote>
      )}
      <FieldIssues issues={listIssues} />
      <button
        type="button"
        className={SMALL_BUTTON}
        onClick={() => onChange([...rules, emptyRule()])}
        disabled={rules.length >= max}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add rule
      </button>
    </div>
  );
}
