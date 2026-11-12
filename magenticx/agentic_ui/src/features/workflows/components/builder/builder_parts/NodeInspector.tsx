import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Info } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import type {
  WorkflowBuilderIssue,
  WorkflowCasesChange,
  WorkflowFormField,
  WorkflowNodeDef,
  WorkflowNodeKindInfo,
  WorkflowSpec,
} from "@/shared/lib/types";
import { kindMeta, humanizeKind } from "@/features/workflows/lib/kinds";
import { REVEAL, REVEAL_REDUCED } from "@/features/workflows/lib/builder/consts";
import { fieldDomId, slugFromLabel } from "@/features/workflows/lib/builder/ids";
import {
  enumLabel,
  isCustomised,
  splitInspectorFields,
} from "@/features/workflows/lib/builder/inspectorLayout";
import { SCHEDULE_TRIGGER_KIND } from "@/features/workflows/lib/builder/schedule";
import { templatePaths } from "@/features/workflows/lib/builder/templates";
import { issueIsOn, kindFields } from "@/features/workflows/lib/builder/validate";
import { Disclosure, FieldIssues } from "./FieldShell";
import { ScheduleTriggerEditor } from "./ScheduleTriggerEditor";
import { SchemaForm } from "./SchemaForm";

/**
 * A short enum shown as a quiet pill beside the kind's name — an HTTP step's
 * method, an LLM step's model: read at a glance, changed in place, without a
 * labelled dropdown of its own in the form.
 */
function HeaderChoice({
  nodeId,
  field,
  value,
  onChange,
  invalid,
}: {
  nodeId: string;
  field: WorkflowFormField;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger
        id={fieldDomId(nodeId, `config.${field.key}`)}
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-6 w-auto min-w-0 max-w-[11rem] gap-1 rounded-md border-transparent bg-muted/60 px-1.5 py-0 font-mono text-[11px] font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-0 aria-[invalid=true]:text-destructive [&>svg]:h-3 [&>svg]:w-3",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg">
        {(field.options ?? []).map((option) => (
          <SelectItem key={option} value={option} className="rounded-lg font-mono text-[12px]">
            {enumLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The inspector for one step. Its header is the step itself: the kind's
 * glyph and name, a header choice where the kind has one (GET / POST, the
 * model), and the label as an editable title — so the form below holds only
 * the settings that shape what the step does. What the kind does, and how
 * later steps refer to it, sit behind the (i). Settings most steps never
 * touch fold under "More options" (`lib/builder/inspectorLayout`), with a
 * count of the ones changed. The id is never typed: it follows the label when
 * the label is committed (blur, Enter), through the same rename that moves
 * edges and references. A schedule trigger gets its own editor in place of
 * the generic form.
 */
export function NodeInspector({
  node,
  info,
  spec,
  issues,
  onRename,
  onLabel,
  onConfig,
}: {
  node: WorkflowNodeDef;
  info: WorkflowNodeKindInfo | null;
  spec: WorkflowSpec;
  /** This node's issues. */
  issues: readonly WorkflowBuilderIssue[];
  onRename: (to: string) => void;
  onLabel: (label: string) => void;
  onConfig: (config: Record<string, unknown>, cases?: WorkflowCasesChange) => void;
}) {
  const reduceMotion = useReducedMotion();
  const meta = kindMeta(node.kind);
  const Glyph = meta.icon;
  const fields = React.useMemo(() => (info ? kindFields(info) : []), [info]);
  const paths = React.useMemo(() => templatePaths(spec, node.id), [spec, node.id]);
  const taken = React.useMemo(
    () => new Set(spec.nodes.map((other) => other.id).filter((id) => id !== node.id)),
    [spec.nodes, node.id],
  );
  const [aboutOpen, setAboutOpen] = React.useState(false);
  const general = issues
    .filter((issue) => !issueIsOn(issue, "config") || issue.field === "config")
    .filter((issue) => issue.field !== "id" && issue.field !== "label");
  const labelId = fieldDomId(node.id, "label");
  const isSchedule = node.kind === SCHEDULE_TRIGGER_KIND;
  // The schedule trigger's own editor covers its whole config.
  const layout = React.useMemo(
    () => splitInspectorFields(node.kind, isSchedule ? [] : fields, node.config),
    [node.kind, isSchedule, fields, node.config],
  );
  const headerField = layout.header;
  const headerWhere = headerField ? `config.${headerField.key}` : "";
  const headerIssues = headerField ? issues.filter((issue) => issueIsOn(issue, headerWhere)) : [];
  const headerValue = headerField
    ? typeof node.config[headerField.key] === "string"
      ? (node.config[headerField.key] as string)
      : typeof headerField.default === "string"
        ? headerField.default
        : (headerField.options?.[0] ?? "")
    : "";
  const moreIssues = issues.filter(
    (issue) =>
      issue.severity === "error" &&
      layout.more.some((field) => issueIsOn(issue, `config.${field.key}`)),
  );
  const moreSet = layout.more.filter((field) => isCustomised(field, node.config)).length;
  const titleIssues = issues.filter((i) => i.field === "label" || i.field === "id");
  const kindLabel = info?.label ?? humanizeKind(node.kind);
  // A label that only repeats the kind ("Wait for all" on a Wait for all step)
  // is the title on its own: the glyph and its colour already say the kind.
  const sameAsKind = (node.label ?? "").trim().toLowerCase() === kindLabel.trim().toLowerCase();
  // The label as it was when the field took focus: the id follows only a label that changed.
  const labelAtFocus = React.useRef<string | null>(null);
  const commitLabel = () => {
    const before = labelAtFocus.current;
    labelAtFocus.current = null;
    const label = node.label ?? "";
    if (before === null || before === label) return;
    const derived = slugFromLabel(label, node.kind, taken);
    if (derived !== node.id) onRename(derived);
  };
  const setHeader = (next: string) => {
    if (!headerField) return;
    onConfig({ ...node.config, [headerField.key]: next });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="sr-only">{node.label?.trim() || node.id}</h2>
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ring-1 ring-inset"
            style={{
              background: `hsl(${meta.accent} / 0.12)`,
              color: `hsl(${meta.accent})`,
              ["--tw-ring-color" as string]: `hsl(${meta.accent} / 0.22)`,
            }}
          >
            <Glyph className="h-[18px] w-[18px]" aria-hidden />
          </span>
          {/* One wrapping row in a fixed DOM order: the kind line, then the title on
              a line of its own — or, when the title only repeats the kind, the
              title alone beside the pill and (i). Only classes change between the
              two, so the title field never remounts (and keeps focus) as it is typed. */}
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5",
              sameAsKind ? "min-h-10" : "gap-y-0.5",
            )}
          >
            <p
              className={cn(
                "truncate text-[10.5px] font-semibold uppercase tracking-[0.14em]",
                sameAsKind && "sr-only",
              )}
              style={{ color: `hsl(${meta.accent})` }}
            >
              {kindLabel}
            </p>
            {headerField ? (
              <HeaderChoice
                nodeId={node.id}
                field={headerField}
                value={headerValue}
                onChange={setHeader}
                invalid={headerIssues.some((issue) => issue.severity === "error")}
              />
            ) : null}
            <button
              type="button"
              onClick={() => setAboutOpen((value) => !value)}
              aria-expanded={aboutOpen}
              aria-controls={`${labelId}-about`}
              aria-label={`About ${kindLabel}`}
              className={cn(
                "relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                aboutOpen && "text-primary",
              )}
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </button>
            <input
              id={labelId}
              aria-label="Label"
              value={node.label ?? ""}
              onChange={(event) => onLabel(event.target.value)}
              onFocus={() => {
                labelAtFocus.current = node.label ?? "";
              }}
              onBlur={commitLabel}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLabel();
                  event.currentTarget.blur();
                }
              }}
              maxLength={120}
              placeholder="Name this step"
              aria-invalid={titleIssues.some((issue) => issue.severity === "error") || undefined}
              className={
                cn(
                  "-ml-1.5 min-w-0 rounded-lg",
                  sameAsKind
                    ? "order-first w-auto flex-1"
                    : "order-last w-[calc(100%+0.375rem)] basis-full",
                ) +
                " border border-transparent border border-transparent bg-transparent px-1.5 py-0.5 text-[17px] font-semibold tracking-tight text-foreground transition-[border-color,background-color,box-shadow] placeholder:text-muted-foreground/60 hover:border-border/60 focus-visible:border-primary/50 focus-visible:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 aria-[invalid=true]:border-destructive/60"
              }
            />
          </div>
        </div>
        <AnimatePresence initial={false}>
          {aboutOpen ? (
            <motion.div
              key="about"
              id={`${labelId}-about`}
              {...(reduceMotion ? REVEAL_REDUCED : REVEAL)}
              className="space-y-1 pl-[3.25rem] text-xs leading-relaxed text-muted-foreground"
            >
              {info?.description ? <p>{info.description}</p> : null}
              <p>
                Later steps read its result as{" "}
                <code className="break-all rounded bg-muted/70 px-1 py-px font-mono text-[11px] text-foreground/85">
                  nodes.{node.id}
                </code>
                ; that name follows the label.
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div id={fieldDomId(node.id, "id")} tabIndex={-1} className="pl-[3.25rem] empty:hidden">
          <FieldIssues issues={[...titleIssues, ...headerIssues]} />
        </div>
      </header>

      {general.length ? (
        <div
          className="rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5"
          id={fieldDomId(node.id, "edges")}
          tabIndex={-1}
        >
          <FieldIssues issues={general} />
        </div>
      ) : null}

      {isSchedule ? (
        <ScheduleTriggerEditor
          nodeId={node.id}
          config={node.config}
          issues={issues}
          onChange={(config) => onConfig(config)}
        />
      ) : null}

      {info ? (
        layout.main.length ? (
          <SchemaForm
            nodeId={node.id}
            fields={layout.main}
            config={node.config}
            onChange={onConfig}
            issues={issues}
            paths={paths}
            barePaths={paths}
            spec={spec}
          />
        ) : null
      ) : isSchedule ? null : (
        <p className="text-xs text-muted-foreground">
          This kind isn&apos;t in the catalogue; its settings can&apos;t be edited here.
        </p>
      )}

      {info && layout.more.length ? (
        <Disclosure
          id={fieldDomId(node.id, "advanced")}
          title="More options"
          defaultOpen={moreIssues.length > 0}
          issueCount={moreIssues.length}
          setCount={moreSet}
        >
          <SchemaForm
            nodeId={node.id}
            fields={layout.more}
            config={node.config}
            onChange={onConfig}
            issues={issues}
            paths={paths}
            barePaths={paths}
            spec={spec}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
