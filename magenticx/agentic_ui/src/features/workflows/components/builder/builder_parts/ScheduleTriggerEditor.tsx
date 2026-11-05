import * as React from "react";
import { Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  ScheduleIntervalUnit,
  ScheduleKind,
  WorkflowBuilderIssue,
  WorkflowInputDef,
  WorkflowScheduleSpec,
} from "@/shared/lib/types";
import { INTERVAL_UNITS, MIN_SCHEDULE_INTERVAL_SECONDS } from "@/shared/lib/consts";
import {
  intervalFromSeconds,
  intervalSecondsOf,
  localFromUtcIso,
  timeZoneOptions,
  toLocalInput,
} from "@/shared/lib/schedule";
import { SchedulePreview } from "@/shared/ui/schedule-preview";
import { Segmented } from "@/shared/ui/segmented";
import {
  ICON_BUTTON,
  INPUT,
  SCHEDULE_CRON_PRESETS,
  SCHEDULE_KIND_TABS,
} from "@/features/workflows/lib/builder/consts";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import {
  DEFAULT_INTERVAL_SECONDS,
  readScheduleConfig,
  scheduleConfigPreview,
  withScheduleKind,
  type ScheduleKindMemory,
} from "@/features/workflows/lib/builder/schedule";
import { ChoiceSelect } from "./Controls";
import { EmptyNote, Field, FieldIssues, SectionHeading, Toggle } from "./FieldShell";
import { JsonField } from "./JsonField";

type Issues = readonly WorkflowBuilderIssue[];

const on = (issues: Issues, field: string) => issues.filter((issue) => issue.field === field);

const TYPE_HINT: Record<WorkflowInputDef["type"], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  object: "JSON object",
  array: "JSON array",
};

const BOOLEAN_CHOICES: { id: "unset" | "true" | "false"; label: string }[] = [
  { id: "unset", label: "Not set" },
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];

/** A chip button (the Schedules form's quick picks). */
const chipClass = (active: boolean) =>
  cn(
    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
    active
      ? "border-primary/40 bg-primary/10 text-primary"
      : "border-border/70 text-muted-foreground supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground",
  );

/** "Every …": an amount + a unit, kept as typed while the stored seconds still agree with it. */
function IntervalField({
  nodeId,
  seconds,
  onChange,
  issues,
}: {
  nodeId: string;
  seconds: number | undefined;
  onChange: (seconds: number) => void;
  issues: Issues;
}) {
  const start = intervalFromSeconds(seconds ?? DEFAULT_INTERVAL_SECONDS);
  const [text, setText] = React.useState(String(start.value));
  const [unit, setUnit] = React.useState<ScheduleIntervalUnit>(start.unit);
  const typed = (value: string, at: ScheduleIntervalUnit) => {
    const amount = Number(value);
    return value.trim() && Number.isFinite(amount) ? intervalSecondsOf(amount, at) : 0;
  };
  React.useEffect(() => {
    // Only an outside change (undo, a kind switch) re-reads the stored value.
    if (typeof seconds === "number" && typed(text, unit) !== seconds) {
      const next = intervalFromSeconds(seconds);
      setText(String(next.value));
      setUnit(next.unit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
  const id = fieldDomId(nodeId, "config.schedule_spec.interval_seconds");
  const fieldIssues = on(issues, "config.schedule_spec.interval_seconds");
  return (
    <Field
      label="Repeat every"
      htmlFor={id}
      issues={fieldIssues}
      hint={`At least ${MIN_SCHEDULE_INTERVAL_SECONDS / 60} minutes. Counted from when the workflow is saved.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="number"
          min={1}
          step="any"
          inputMode="decimal"
          aria-label="Interval amount"
          aria-invalid={fieldIssues.length > 0 || undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onChange(typed(event.target.value, unit));
          }}
          className={cn(INPUT, "w-24 tabular-nums")}
        />
        <div className="min-w-[12rem] flex-1">
          <Segmented
            size="sm"
            ariaLabel="Interval unit"
            value={unit}
            options={INTERVAL_UNITS.map((u) => ({ id: u.id, label: u.label }))}
            onChange={(next) => {
              setUnit(next);
              onChange(typed(text, next));
            }}
          />
        </div>
      </div>
    </Field>
  );
}

/** A number typed as text: written when it parses, removed when emptied. */
function NumberText({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid: boolean;
}) {
  const [text, setText] = React.useState(typeof value === "number" ? String(value) : "");
  React.useEffect(() => {
    if (Number(text) !== value || (value === undefined && text !== "")) {
      setText(typeof value === "number" ? String(value) : "");
    }
    // An outside change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      step="any"
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (!next.trim()) onChange(undefined);
        else if (Number.isFinite(Number(next))) onChange(Number(next));
      }}
      aria-invalid={invalid || undefined}
      className={cn(INPUT, "tabular-nums")}
    />
  );
}

/** One declared input's literal value for a scheduled run, edited by its type. */
function ScheduleInputField({
  nodeId,
  def,
  value,
  onChange,
  issues,
}: {
  nodeId: string;
  def: WorkflowInputDef;
  value: unknown;
  onChange: (value: unknown) => void;
  issues: Issues;
}) {
  const id = fieldDomId(nodeId, `config.inputs.${def.name}`);
  const fieldIssues = on(issues, `config.inputs.${def.name}`);
  const invalid = fieldIssues.length > 0;
  const hasDefault = def.default !== undefined && def.default !== null;
  const hint = [
    TYPE_HINT[def.type],
    def.description,
    hasDefault ? `Default: ${JSON.stringify(def.default)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  let control: React.ReactNode;
  if (def.type === "boolean") {
    control = (
      <Segmented
        idPrefix={id}
        size="sm"
        ariaLabel={def.name}
        value={value === true ? "true" : value === false ? "false" : "unset"}
        options={BOOLEAN_CHOICES}
        onChange={(choice) => onChange(choice === "unset" ? undefined : choice === "true")}
      />
    );
  } else if (def.type === "number") {
    control = <NumberText id={id} value={value} onChange={onChange} invalid={invalid} />;
  } else if (def.type === "object" || def.type === "array") {
    control = (
      <JsonField id={id} value={value} onChange={onChange} jsonType={def.type} invalid={invalid} />
    );
  } else {
    control = (
      <input
        id={id}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
        placeholder={hasDefault ? String(def.default) : undefined}
        aria-invalid={invalid || undefined}
        className={INPUT}
      />
    );
  }
  return (
    <Field
      label={<span className="font-mono">{def.name}</span>}
      htmlFor={def.type === "boolean" ? undefined : id}
      required={Boolean(def.required) && !hasDefault}
      issues={fieldIssues}
      hint={hint}
    >
      {control}
    </Field>
  );
}

/**
 * The schedule trigger's editor (`trigger.schedule`), in place of the
 * generic form and in the Schedules form's visual language: an on / off
 * switch; the kind as tabs — Once (a date and time), Every… (an amount and a
 * unit, 5 minutes at least), Custom (a cron expression with one-click
 * presets and its timezone); a live summary with the next runs; and the
 * literal inputs a scheduled run starts with, one typed field per declared
 * input (required ones marked). Every change is written straight into the
 * node's config with the engine's field names; the checks live in
 * `lib/builder/schedule` and show here, on the card and in the Issues menu.
 */
export function ScheduleTriggerEditor({
  nodeId,
  config,
  inputs,
  issues,
  onChange,
}: {
  nodeId: string;
  config: Record<string, unknown>;
  /** The workflow's declared inputs. */
  inputs: readonly WorkflowInputDef[];
  /** This node's issues. */
  issues: Issues;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const read = React.useMemo(() => readScheduleConfig(config), [config]);
  const kind = read.schedule_kind;
  const spec = read.schedule_spec;
  // What each kind was set to while this editor is open: switching back restores it.
  const memory = React.useRef<Partial<Record<ScheduleKind, ScheduleKindMemory>>>({});
  // The preview's "now", refreshed so relative times stay true.
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const preview = React.useMemo(() => scheduleConfigPreview(read, now), [read, now]);
  const zones = React.useMemo(() => timeZoneOptions(read.timezone), [read.timezone]);

  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const setSpec = (next: WorkflowScheduleSpec) => set({ schedule_spec: next });
  const pickKind = (next: ScheduleKind) => {
    if (next === kind) return;
    memory.current[kind] = { spec, timezone: read.timezone };
    onChange(withScheduleKind(config, next, memory.current[next]));
  };
  const setInput = (name: string, value: unknown) => {
    const nextInputs = { ...read.inputs };
    if (value === undefined) delete nextInputs[name];
    else nextInputs[name] = value;
    set({ inputs: nextInputs });
  };

  const declaredNames = new Set(inputs.map((input) => input.name));
  const strays = Object.keys(read.inputs).filter((name) => !declaredNames.has(name));
  const kindIssues = [...on(issues, "config.schedule_kind"), ...on(issues, "config.schedule_spec")];
  const runAtId = fieldDomId(nodeId, "config.schedule_spec.run_at");
  const cronId = fieldDomId(nodeId, "config.schedule_spec.cron_expr");
  const tzId = fieldDomId(nodeId, "config.timezone");
  const enabledId = fieldDomId(nodeId, "config.enabled");
  const runAtIssues = on(issues, "config.schedule_spec.run_at");
  const cronIssues = on(issues, "config.schedule_spec.cron_expr");
  const cron = spec.cron_expr ?? "";

  return (
    <div className="space-y-6" data-testid="schedule-trigger-editor">
      <section className="space-y-3.5">
        <SectionHeading
          title="When it runs"
          aside={
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground/85" aria-hidden>
                Enabled
              </span>
              <Toggle
                id={enabledId}
                checked={read.enabled}
                onChange={(enabled) => set({ enabled })}
                label="Enabled"
              />
            </span>
          }
          description={
            read.enabled
              ? "On: it fires on this schedule once the workflow is saved."
              : "Off: the schedule is kept but never fires — the workflow runs only when started."
          }
        />
        <FieldIssues issues={on(issues, "config.enabled")} />

        <div className="space-y-1.5">
          <Segmented
            idPrefix={fieldDomId(nodeId, "config.schedule_kind")}
            ariaLabel="Schedule type"
            value={kind}
            options={SCHEDULE_KIND_TABS.map((tab) => {
              const Icon = tab.icon;
              return {
                id: tab.id,
                label: tab.label,
                icon: <Icon className="h-3.5 w-3.5" aria-hidden />,
              };
            })}
            onChange={pickKind}
          />
          <FieldIssues issues={kindIssues} />
        </div>

        {kind === "one_off" ? (
          <Field
            label="Run at"
            htmlFor={runAtId}
            issues={runAtIssues}
            hint="Your local time. A moment that has passed schedules nothing; the workflow can still be run by hand."
          >
            <input
              id={runAtId}
              type="datetime-local"
              aria-invalid={runAtIssues.length > 0 || undefined}
              min={toLocalInput(new Date(now.getTime() + 60000))}
              value={spec.run_at ? localFromUtcIso(spec.run_at) : ""}
              onChange={(event) => {
                const at = event.target.value ? new Date(event.target.value) : null;
                setSpec({ run_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : "" });
              }}
              className={cn(INPUT, "sm:w-64")}
            />
          </Field>
        ) : kind === "interval" ? (
          <IntervalField
            nodeId={nodeId}
            seconds={spec.interval_seconds}
            onChange={(seconds) => setSpec({ interval_seconds: seconds })}
            issues={issues}
          />
        ) : (
          <div className="space-y-3.5">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common schedules">
              {SCHEDULE_CRON_PRESETS.map((preset) => (
                <button
                  key={preset.expr}
                  type="button"
                  aria-pressed={cron.trim() === preset.expr}
                  onClick={() => setSpec({ cron_expr: preset.expr })}
                  className={chipClass(cron.trim() === preset.expr)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Field
              label="Cron expression"
              htmlFor={cronId}
              required
              issues={cronIssues}
              hint="Five fields: minute hour day month weekday."
            >
              <input
                id={cronId}
                value={cron}
                onChange={(event) => setSpec({ cron_expr: event.target.value })}
                placeholder="0 8 * * 1-5"
                maxLength={200}
                spellCheck={false}
                aria-invalid={cronIssues.length > 0 || undefined}
                className={cn(INPUT, "font-mono text-[13px]")}
              />
            </Field>
            <Field
              label="Timezone"
              htmlFor={tzId}
              issues={on(issues, "config.timezone")}
              hint="The expression is read in this zone."
            >
              <ChoiceSelect
                id={tzId}
                ariaLabel="Timezone"
                value={read.timezone ?? "UTC"}
                options={zones.map((zone) => ({ value: zone, label: zone }))}
                onChange={(timezone) => set({ timezone })}
                invalid={on(issues, "config.timezone").length > 0}
              />
            </Field>
          </div>
        )}

        <SchedulePreview preview={preview} now={now}>
          {read.enabled ? null : (
            <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">
              Off — it won&apos;t fire until you turn it on.
            </p>
          )}
        </SchedulePreview>
      </section>

      <section className="space-y-3.5">
        <SectionHeading
          title="Inputs for scheduled runs"
          description="What each scheduled run starts with. Fixed values, not templates. Run now can still override them."
        />
        <FieldIssues issues={on(issues, "config.inputs")} />
        {inputs.length ? (
          <div className="space-y-4">
            {inputs.map((def) => (
              <ScheduleInputField
                key={def.name}
                nodeId={nodeId}
                def={def}
                value={read.inputs[def.name]}
                onChange={(value) => setInput(def.name, value)}
                issues={issues}
              />
            ))}
          </div>
        ) : (
          <EmptyNote>
            This workflow declares no inputs, so its scheduled runs start with none. Add inputs in
            its Settings.
          </EmptyNote>
        )}
        {strays.map((name) => (
          <div
            key={name}
            className="flex items-start justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-xs text-foreground">{name}</p>
              <FieldIssues issues={on(issues, `config.inputs.${name}`)} />
            </div>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={`Remove the value for ${name}`}
              title="Remove"
              onClick={() => setInput(name, undefined)}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
