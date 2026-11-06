import * as React from "react";

import { cn } from "@/shared/lib/utils";
import type {
  ScheduleIntervalUnit,
  ScheduleKind,
  WorkflowBuilderIssue,
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
  withoutLegacyInputs,
  type ScheduleKindMemory,
} from "@/features/workflows/lib/builder/schedule";
import { ChoiceSelect } from "./Controls";
import { Field, FieldIssues, SectionHeading, Toggle } from "./FieldShell";

type Issues = readonly WorkflowBuilderIssue[];

const on = (issues: Issues, field: string) => issues.filter((issue) => issue.field === field);

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

/**
 * The schedule trigger's editor (`trigger.schedule`), in place of the
 * generic form and in the Schedules form's visual language: an on / off
 * switch; the kind as tabs — Once (a date and time), Every… (an amount and a
 * unit, 5 minutes at least), Cron (an expression with one-click presets and
 * its timezone); and a live summary with the next runs. It has no inputs of
 * its own: a scheduled run uses each declared input's default (Settings), and
 * the `inputs` older specs carried are dropped on the first change. Every change is written straight into the
 * node's config with the engine's field names; the checks live in
 * `lib/builder/schedule` and show here, on the card and in the Issues menu.
 */
export function ScheduleTriggerEditor({
  nodeId,
  config,
  issues,
  onChange,
}: {
  nodeId: string;
  config: Record<string, unknown>;
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

  const set = (patch: Record<string, unknown>) => onChange({ ...withoutLegacyInputs(config), ...patch });
  const setSpec = (next: WorkflowScheduleSpec) => set({ schedule_spec: next });
  const pickKind = (next: ScheduleKind) => {
    if (next === kind) return;
    memory.current[kind] = { spec, timezone: read.timezone };
    onChange(withScheduleKind(withoutLegacyInputs(config), next, memory.current[next]));
  };

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

    </div>
  );
}
