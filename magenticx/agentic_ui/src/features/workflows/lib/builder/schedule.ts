import type {
  ScheduleKind,
  SchedulePreviewModel,
  WorkflowInputDef,
  WorkflowSchedule,
  WorkflowScheduleConfig,
  WorkflowScheduleSpec,
} from "@/shared/lib/types";
import {
  MAX_CRON_CHARS,
  MAX_SCHEDULE_INTERVAL_SECONDS,
  MAX_TIMEZONE_CHARS,
  MIN_SCHEDULE_INTERVAL_SECONDS,
} from "@/shared/lib/consts";
import {
  browserTimezone,
  describeSchedule,
  formatNextRunShort,
  isValidTimeZone,
  parseMaybeUtc,
  schedulePreview,
} from "@/shared/lib/schedule";
import { workflowScheduleSubtitle } from "@/shared/lib/workflowSchedule";
import type { ConfigProblem } from "./schemaForm";

/**
 * The schedule trigger (`trigger.schedule`) in the builder: its config read
 * and written with the engine's field names (`schedule_kind`,
 * `schedule_spec`, `timezone`, `enabled`), the checks the engine
 * runs on it (`agents/harness/workflows/nodes/trigger_schedule.py`, mirrored
 * so a bad value shows on the node as it is typed), the switch between a
 * manual and a scheduled start, and the card's compact subtitle. The
 * schedule's wording and preview are the Schedules area's
 * (`shared/lib/schedule`). Pure: no React.
 */

export const SCHEDULE_TRIGGER_KIND = "trigger.schedule";
export const MANUAL_TRIGGER_KIND = "trigger.manual";

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["one_off", "interval", "cron"];
/** The `schedule_spec` field each kind requires — and the only one it allows. */
export const SCHEDULE_SPEC_FIELD: Record<ScheduleKind, keyof WorkflowScheduleSpec> = {
  one_off: "run_at",
  interval: "interval_seconds",
  cron: "cron_expr",
};
const SPEC_FIELDS = Object.values(SCHEDULE_SPEC_FIELD) as string[];
const KIND_WORDS: Record<ScheduleKind, string> = {
  one_off: "one-off",
  interval: "repeating",
  cron: "cron",
};

/** A new schedule trigger's cadence: once a day. */
export const DEFAULT_INTERVAL_SECONDS = 86400;
/** The cron a "Custom" schedule starts from: every day at 08:00. */
export const DEFAULT_CRON_EXPR = "0 8 * * *";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isScheduleKind = (value: unknown): value is ScheduleKind =>
  SCHEDULE_KINDS.includes(value as ScheduleKind);

/** A schedule trigger's config, read leniently (anything malformed as the editor's starting value). */
export function readScheduleConfig(config: Record<string, unknown>): WorkflowScheduleConfig {
  const raw = isRecord(config.schedule_spec) ? config.schedule_spec : {};
  const spec: WorkflowScheduleSpec = {};
  if (typeof raw.run_at === "string") spec.run_at = raw.run_at;
  if (typeof raw.interval_seconds === "number") spec.interval_seconds = raw.interval_seconds;
  if (typeof raw.cron_expr === "string") spec.cron_expr = raw.cron_expr;
  return {
    schedule_kind: isScheduleKind(config.schedule_kind) ? config.schedule_kind : "interval",
    schedule_spec: spec,
    timezone: typeof config.timezone === "string" && config.timezone ? config.timezone : null,
    enabled: config.enabled !== false,
  };
}

/** A kind's starting spec: a one-off an hour from now (to the minute), a daily repeat, 08:00 daily. */
export function defaultScheduleSpec(
  kind: ScheduleKind,
  now: Date = new Date(),
): WorkflowScheduleSpec {
  if (kind === "one_off") {
    const at = new Date(now.getTime() + 60 * 60 * 1000);
    at.setSeconds(0, 0);
    return { run_at: at.toISOString() };
  }
  if (kind === "cron") return { cron_expr: DEFAULT_CRON_EXPR };
  return { interval_seconds: DEFAULT_INTERVAL_SECONDS };
}

/** A new schedule trigger's config: every day, on. */
export function defaultScheduleConfig(): Record<string, unknown> {
  return {
    schedule_kind: "interval",
    schedule_spec: defaultScheduleSpec("interval"),
    timezone: null,
    enabled: true,
  };
}

/** What a kind was last set to while the editor was open, so switching back restores it. */
export type ScheduleKindMemory = { spec: WorkflowScheduleSpec; timezone: string | null };

/**
 * The config with another kind picked: that kind's one spec field (the one
 * remembered, else its default) and — a cron only — a timezone (the
 * remembered one, else the viewer's). Every other key is kept.
 */
export function withScheduleKind(
  config: Record<string, unknown>,
  kind: ScheduleKind,
  memory?: ScheduleKindMemory | null,
  now: Date = new Date(),
): Record<string, unknown> {
  const field = SCHEDULE_SPEC_FIELD[kind];
  const spec =
    memory && memory.spec[field] !== undefined
      ? { [field]: memory.spec[field] }
      : defaultScheduleSpec(kind, now);
  const timezone = kind === "cron" ? (memory?.timezone ?? browserTimezone()) : null;
  return { ...config, schedule_kind: kind, schedule_spec: spec, timezone };
}

// ---------- Checks (the engine's, field for field) ----------

/**
 * The config without the `inputs` older specs carried: a scheduled run has no
 * inputs of its own (it uses each declared input's default), and the engine
 * drops the key.
 */
export function withoutLegacyInputs(config: Record<string, unknown>): Record<string, unknown> {
  if (!("inputs" in config)) return config;
  const { inputs: _legacy, ...rest } = config;
  return rest;
}

/**
 * Every problem with a schedule trigger's config, addressed like the
 * engine's (`config.schedule_spec.interval_seconds`, `config.enabled`):
 * the kind, exactly the kind's one spec field and its range, the timezone,
 * and — while the schedule is on — every required input without a default,
 * which a scheduled run has no one to fill in.
 */
export function scheduleConfigProblems(
  config: Record<string, unknown>,
  declared: readonly WorkflowInputDef[],
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (field: string, message: string) =>
    problems.push({ field: `config.${field}`, message });
  const kind = config.schedule_kind;
  if (!isScheduleKind(kind))
    add("schedule_kind", "Pick when it runs: once, every…, or on a cron schedule.");

  const spec = config.schedule_spec;
  if (!isRecord(spec)) {
    add("schedule_spec", "Set when it runs.");
  } else {
    const unknown = Object.keys(spec).filter((key) => !SPEC_FIELDS.includes(key));
    if (unknown.length) add("schedule_spec", `Unknown schedule field: ${unknown.join(", ")}.`);
    if (isScheduleKind(kind)) {
      const wanted = SCHEDULE_SPEC_FIELD[kind];
      const others = SPEC_FIELDS.filter(
        (key) => key !== wanted && spec[key] !== undefined && spec[key] !== null,
      );
      if (others.length) {
        add(
          "schedule_spec",
          `A ${KIND_WORDS[kind]} schedule takes only ${wanted}; remove ${others.join(", ")}.`,
        );
      }
      const value = spec[wanted];
      const at = `schedule_spec.${wanted}`;
      if (kind === "one_off") {
        if (value === undefined || value === null || value === "") add(at, "Pick a date and time.");
        else if (typeof value !== "string" || Number.isNaN(parseMaybeUtc(value).getTime())) {
          add(at, "That isn't a valid date and time.");
        }
      } else if (kind === "interval") {
        if (value === undefined || value === null) add(at, "Set how often it runs.");
        else if (typeof value !== "number" || !Number.isInteger(value))
          add(at, "The interval is a whole number of seconds.");
        else if (value < MIN_SCHEDULE_INTERVAL_SECONDS)
          add(at, "The shortest interval is 5 minutes.");
        else if (value > MAX_SCHEDULE_INTERVAL_SECONDS)
          add(at, "The longest interval is 366 days.");
      } else if (typeof value !== "string" || !value.trim()) {
        add(at, "Enter a cron expression.");
      } else if (value.length > MAX_CRON_CHARS) {
        add(at, `A cron expression is at most ${MAX_CRON_CHARS} characters.`);
      }
    }
  }

  const timezone = config.timezone;
  if (timezone !== undefined && timezone !== null) {
    if (typeof timezone !== "string" || !timezone.trim() || timezone.length > MAX_TIMEZONE_CHARS) {
      add("timezone", "Pick a timezone.");
    } else if (!isValidTimeZone(timezone.trim())) {
      add("timezone", "Unknown timezone — use an IANA name like Europe/Athens.");
    }
  }

  const enabled = config.enabled ?? true;
  if (typeof enabled !== "boolean") add("enabled", "Enabled must be on or off.");

  if (enabled !== false) {
    for (const input of declared) {
      if (input.required && (input.default === undefined || input.default === null)) {
        add(
          "enabled",
          `A scheduled run can't fill the required input '${input.name}': give it a default in Settings › Inputs, or turn the schedule off.`,
        );
      }
    }
  }
  return problems;
}

// ---------- Wording ----------

const toShape = (config: WorkflowScheduleConfig) => ({
  scheduleKind: config.schedule_kind,
  scheduleSpec: config.schedule_spec as Record<string, unknown>,
  timezone: config.timezone,
});

/** The editor's live preview: the cadence in words and its next runs. */
export function scheduleConfigPreview(
  config: WorkflowScheduleConfig,
  now: Date,
): SchedulePreviewModel {
  const spec = config.schedule_spec;
  const runAt = spec.run_at ? parseMaybeUtc(spec.run_at) : null;
  return schedulePreview(
    {
      kind: config.schedule_kind,
      intervalSeconds: spec.interval_seconds ?? 0,
      cronExpr: spec.cron_expr ?? "",
      timezone: config.timezone ?? "UTC",
      runAt: runAt && !Number.isNaN(runAt.getTime()) ? runAt : null,
    },
    now,
  );
}

/** Whether the saved schedule is the one this config describes (same kind, spec and zone). */
export function savedScheduleMatches(
  saved: WorkflowSchedule,
  config: WorkflowScheduleConfig,
): boolean {
  if (saved.kind !== config.schedule_kind) return false;
  const field = SCHEDULE_SPEC_FIELD[config.schedule_kind];
  const mine = config.schedule_spec[field];
  const theirs = saved.spec[field];
  if (field === "run_at") {
    if (typeof mine !== "string" || typeof theirs !== "string") return false;
    if (parseMaybeUtc(mine).getTime() !== parseMaybeUtc(theirs).getTime()) return false;
  } else if (
    typeof mine === "string" ? mine.trim() !== String(theirs ?? "").trim() : mine !== theirs
  ) {
    return false;
  }
  return (
    config.schedule_kind !== "cron" || (saved.timezone ?? "UTC") === (config.timezone ?? "UTC")
  );
}

/**
 * The trigger card's compact line in the builder, from the node's own
 * config: "Paused" when it is off; else the cadence, with the next run when
 * it can be told — the saved schedule's (while the config still matches what
 * was saved), else a cron's computed here. An interval counts from the save,
 * so before one it has no next run to show.
 */
export function scheduleNodeSubtitle(
  config: Record<string, unknown>,
  now: Date,
  saved?: WorkflowSchedule | null,
): { text: string; paused: boolean } {
  const read = readScheduleConfig(config);
  if (!read.enabled) return { text: "Paused", paused: true };
  if (saved && savedScheduleMatches(saved, read)) return workflowScheduleSubtitle(saved, now);
  const words = describeSchedule(toShape(read));
  if (read.schedule_kind !== "cron") return { text: words, paused: false };
  const next = scheduleConfigPreview(read, now).runs[0];
  return { text: next ? `${words} · next ${formatNextRunShort(next, now)}` : words, paused: false };
}
