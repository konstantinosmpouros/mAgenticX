import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Building2,
  CalendarClock,
  CalendarDays,
  CircleAlert,
  EyeOff,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Repeat,
  Sparkles,
  Timer,
} from "lucide-react";

import type {
  Agent,
  ScheduledTaskCreatePayload,
  ScheduleKind,
  TaskTargetMode,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import {
  clock,
  formatRelative,
  formatRunTime,
  humanizeCron,
  humanizeSeconds,
  isValidTimeZone,
  nextCronRuns,
  parseCron,
} from "@/features/tasks/lib/schedule";

// Pre-fill values shared by editing a task and importing a template.
export type ScheduledTaskFormInitial = {
  agentId?: string | null;
  title?: string | null;
  prompt?: string;
  targetMode?: TaskTargetMode | string;
  scheduleKind?: ScheduleKind | string;
  scheduleSpec?: Record<string, unknown>;
  timezone?: string | null;
  isPrivate?: boolean;
};

type ScheduledTaskFormProps = {
  agents: Agent[];
  // Pre-fill the form (editing a task or importing a template). Tools are
  // agent-declared, not carried per task.
  initial?: ScheduledTaskFormInitial;
  submitLabel?: string;
  submitting: boolean;
  /** The server's answer to the last submit, shown above the actions. */
  submitError?: string | null;
  onSubmit: (payload: ScheduledTaskCreatePayload) => void;
  onCancel: () => void;
};

const INTERVAL_UNITS = [
  { id: "minutes", label: "Minutes", seconds: 60 },
  { id: "hours", label: "Hours", seconds: 3600 },
  { id: "days", label: "Days", seconds: 86400 },
] as const;
type IntervalUnit = (typeof INTERVAL_UNITS)[number]["id"];

const INTERVAL_PRESETS: { label: string; value: number; unit: IntervalUnit }[] = [
  { label: "15 min", value: 15, unit: "minutes" },
  { label: "1 hour", value: 1, unit: "hours" },
  { label: "6 hours", value: 6, unit: "hours" },
  { label: "1 day", value: 1, unit: "days" },
  { label: "1 week", value: 7, unit: "days" },
];

const TARGET_MODES: { id: TaskTargetMode; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: "fresh",
    label: "New chat each run",
    hint: "Every run starts a fresh, isolated conversation.",
    icon: <MessagesSquare className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    id: "bound",
    label: "One ongoing chat",
    hint: "Runs continue one conversation, so the agent remembers prior runs.",
    icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
  },
];

const SCHEDULE_KINDS: { id: ScheduleKind; label: string; icon: React.ReactNode }[] = [
  { id: "interval", label: "Repeat every", icon: <Repeat className="h-3.5 w-3.5" aria-hidden /> },
  {
    id: "cron",
    label: "On a schedule",
    icon: <CalendarDays className="h-3.5 w-3.5" aria-hidden />,
  },
  { id: "one_off", label: "Once", icon: <Timer className="h-3.5 w-3.5" aria-hidden /> },
];

// The cron builder's cadences; "custom" leaves the expression as typed.
type CronPreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom";
const CRON_PRESETS: { id: CronPreset; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "custom", label: "Custom" },
];
// Monday-first, as people read a week; values are cron's (0 = Sunday).
const WEEK = [
  { value: 1, short: "M", label: "Monday" },
  { value: 2, short: "T", label: "Tuesday" },
  { value: 3, short: "W", label: "Wednesday" },
  { value: 4, short: "T", label: "Thursday" },
  { value: 5, short: "F", label: "Friday" },
  { value: 6, short: "S", label: "Saturday" },
  { value: 0, short: "S", label: "Sunday" },
];

type CronBuilder = { preset: CronPreset; time: string; weekdays: number[]; monthDay: number };

/** Read a stored expression back into the builder, or "custom" when it doesn't fit one. */
function builderFromCron(expr: string): CronBuilder {
  const fallback: CronBuilder = { preset: "custom", time: "08:00", weekdays: [1], monthDay: 1 };
  const parts = expr.trim().split(/\s+/);
  const f = parseCron(expr);
  if (
    !f ||
    parts.length !== 5 ||
    f.minutes.length !== 1 ||
    f.hours.length !== 1 ||
    f.months.length !== 12
  ) {
    return fallback;
  }
  const time = clock(f.hours[0]!, f.minutes[0]!);
  const base = { ...fallback, time };
  if (f.dayStar && f.weekdayStar) return { ...base, preset: "daily" };
  if (f.dayStar && f.weekdays.join(",") === "1,2,3,4,5" && parts[4] === "1-5")
    return { ...base, preset: "weekdays" };
  if (f.dayStar) return { ...base, preset: "weekly", weekdays: f.weekdays };
  if (f.weekdayStar && f.days.length === 1)
    return { ...base, preset: "monthly", monthDay: f.days[0]! };
  return { ...fallback, time };
}

function cronFromBuilder(b: CronBuilder): string | null {
  if (b.preset === "custom") return null;
  const [hh, mm] = b.time.split(":").map((n) => Number(n));
  const h = Number.isFinite(hh) ? hh : 8;
  const m = Number.isFinite(mm) ? mm : 0;
  if (b.preset === "daily") return `${m} ${h} * * *`;
  if (b.preset === "weekdays") return `${m} ${h} * * 1-5`;
  if (b.preset === "weekly") {
    const days = [...b.weekdays].sort((a, z) => a - z);
    return `${m} ${h} * * ${days.length ? days.join(",") : "1"}`;
  }
  return `${m} ${h} ${Math.min(Math.max(b.monthDay, 1), 31)} * *`;
}

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// datetime-local wants a LOCAL "YYYY-MM-DDTHH:mm" string; default to +1h.
const defaultLocalDateTime = (): string => toLocalInput(new Date(Date.now() + 60 * 60 * 1000));

// Derive the form's interval value+unit from a stored seconds count.
const intervalFromSeconds = (seconds: number): { value: number; unit: IntervalUnit } => {
  if (seconds > 0 && seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
  if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
};

// Convert a stored naive-UTC ISO (schedule_spec.run_at) to a local datetime-local value.
const localFromUtcIso = (iso: string): string =>
  toLocalInput(new Date(/[Z+]/.test(iso) ? iso : `${iso}Z`));

const fieldClass =
  "w-full rounded-xl border border-border/80 bg-background px-3 py-2 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 focus-visible:border-primary/60 focus-visible:ring-4 focus-visible:ring-primary/15 aria-[invalid=true]:border-destructive/70 aria-[invalid=true]:focus-visible:ring-destructive/15";

/** A segmented control whose selection pill glides between options. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
}: {
  value: T;
  options: { id: T; label: string; icon?: React.ReactNode }[];
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  const id = React.useId();
  const reduceMotion = useReducedMotion();
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex w-full gap-1 rounded-xl bg-muted/70 p-1 ring-1 ring-inset ring-border/50"
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={cn(
              "relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              size === "sm" ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-[13px]",
              active
                ? "text-foreground"
                : "text-muted-foreground supports-[hover:hover]:hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }
                }
                className="absolute inset-0 rounded-lg bg-card shadow-[0_1px_3px_hsl(var(--foreground)/0.12)] ring-1 ring-border/60"
              />
            ) : null}
            {opt.icon ? (
              <span className={cn("relative max-[420px]:hidden", active && "text-primary")}>
                {opt.icon}
              </span>
            ) : null}
            <span className="relative truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {step}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <div className="space-y-4 sm:pl-[2.125rem]">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  optional,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  optional?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-foreground/90">
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
          <CircleAlert className="h-3 w-3 flex-shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type Errors = Partial<
  Record<"agent" | "prompt" | "interval" | "cron" | "timezone" | "runAt", string>
>;

export default function ScheduledTaskForm({
  agents,
  initial,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
  onCancel,
}: ScheduledTaskFormProps) {
  const init = initial;
  const initInterval =
    init?.scheduleKind === "interval"
      ? intervalFromSeconds(Number(init.scheduleSpec?.interval_seconds) || 3600)
      : null;
  const activeAgents = React.useMemo(() => agents.filter((a) => a.isActive), [agents]);
  const agentOptions = activeAgents.length ? activeAgents : agents;
  const [agentId, setAgentId] = React.useState<string>(
    init?.agentId ?? activeAgents[0]?.id ?? agents[0]?.id ?? "",
  );
  const [title, setTitle] = React.useState(init?.title ?? "");
  const [prompt, setPrompt] = React.useState(init?.prompt ?? "");
  const [targetMode, setTargetMode] = React.useState<TaskTargetMode>(
    (init?.targetMode as TaskTargetMode) ?? "fresh",
  );
  const [isPrivate, setIsPrivate] = React.useState(Boolean(init?.isPrivate));
  const [scheduleKind, setScheduleKind] = React.useState<ScheduleKind>(
    (init?.scheduleKind as ScheduleKind) ?? "interval",
  );
  const [intervalValue, setIntervalValue] = React.useState(initInterval?.value ?? 6);
  const [intervalUnit, setIntervalUnit] = React.useState<IntervalUnit>(
    initInterval?.unit ?? "hours",
  );
  const initialCron =
    init?.scheduleKind === "cron"
      ? String(init.scheduleSpec?.cron_expr ?? "0 8 * * *")
      : "0 8 * * *";
  const [cronExpr, setCronExpr] = React.useState(initialCron);
  const [builder, setBuilder] = React.useState<CronBuilder>(() => builderFromCron(initialCron));
  const [timezone, setTimezone] = React.useState(init?.timezone ?? browserTimezone());
  const [runAtLocal, setRunAtLocal] = React.useState(
    init?.scheduleKind === "one_off" && init.scheduleSpec?.run_at
      ? localFromUtcIso(String(init.scheduleSpec.run_at))
      : defaultLocalDateTime(),
  );
  const [attempted, setAttempted] = React.useState(false);
  // The preview's "now", refreshed each minute so relative times stay true.
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const updateBuilder = (patch: Partial<CronBuilder>) => {
    setBuilder((prev) => {
      const next = { ...prev, ...patch };
      const expr = cronFromBuilder(next);
      if (expr) setCronExpr(expr);
      return next;
    });
  };

  const intervalSeconds = Math.round(
    intervalValue *
      (INTERVAL_UNITS.find((u) => u.id === intervalUnit) ?? INTERVAL_UNITS[1]).seconds,
  );
  const runAtDate = runAtLocal ? new Date(runAtLocal) : null;
  const cronReadable = parseCron(cronExpr) !== null;
  const tzValid = isValidTimeZone(timezone.trim() || "UTC");

  const errors: Errors = {};
  if (!agentId) errors.agent = "Pick an agent.";
  if (!prompt.trim()) errors.prompt = "Enter the instruction to run.";
  if (scheduleKind === "interval" && intervalSeconds < 300)
    errors.interval = "The minimum interval is 5 minutes.";
  if (scheduleKind === "cron") {
    if (!cronExpr.trim()) errors.cron = "Enter a cron expression.";
    if (!tzValid) errors.timezone = "Unknown timezone — use an IANA name like Europe/Athens.";
  }
  if (scheduleKind === "one_off") {
    if (!runAtLocal) errors.runAt = "Pick a date and time.";
    else if (!runAtDate || Number.isNaN(runAtDate.getTime()) || runAtDate.getTime() <= Date.now())
      errors.runAt = "Pick a future date and time.";
  }
  const shown = attempted ? errors : {};

  // The live preview: the schedule in words and its next runs.
  const preview = React.useMemo((): { summary: string; runs: Date[]; note?: string } => {
    if (scheduleKind === "interval") {
      if (intervalSeconds < 300) return { summary: "Every …", runs: [] };
      return {
        summary: `Every ${humanizeSeconds(intervalSeconds)}`,
        runs: [1, 2, 3].map((i) => new Date(now.getTime() + i * intervalSeconds * 1000)),
        note: "Counted from when you save.",
      };
    }
    if (scheduleKind === "cron") {
      const tz = timezone.trim() || "UTC";
      const words = humanizeCron(cronExpr);
      const runs = tzValid ? nextCronRuns(cronExpr, tz, 3, now) : [];
      const local = browserTimezone();
      return {
        summary: words
          ? `${words}${tz !== local ? ` (${tz})` : ""}`
          : cronReadable
            ? `Cron ${cronExpr.trim()}`
            : "Custom cron",
        runs,
        note: cronReadable
          ? undefined
          : "Can't preview this expression here — it's checked when you save.",
      };
    }
    if (runAtDate && !Number.isNaN(runAtDate.getTime())) {
      return {
        summary: `Once on ${formatRunTime(runAtDate, now)}`,
        runs: runAtDate > now ? [runAtDate] : [],
      };
    }
    return { summary: "Once", runs: [] };
  }, [
    scheduleKind,
    intervalSeconds,
    cronExpr,
    timezone,
    tzValid,
    cronReadable,
    runAtDate?.getTime(),
    now,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length) {
      // Bring the first problem into view.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("[data-task-form] [aria-invalid='true']")?.focus();
      });
      return;
    }
    const payload: ScheduledTaskCreatePayload = {
      agentId,
      prompt: prompt.trim(),
      title: title.trim() || undefined,
      targetMode,
      scheduleKind,
      isPrivate: targetMode === "fresh" ? isPrivate : false,
    };
    if (scheduleKind === "interval") {
      payload.intervalSeconds = intervalSeconds;
    } else if (scheduleKind === "cron") {
      payload.cronExpr = cronExpr.trim();
      payload.timezone = timezone.trim() || "UTC";
    } else if (runAtDate) {
      payload.runAt = runAtDate.toISOString();
    }
    onSubmit(payload);
  };

  const targetHint = TARGET_MODES.find((m) => m.id === targetMode)?.hint;
  const minRunAt = toLocalInput(new Date(now.getTime() + 60000));

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      data-task-form
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
        <Section step={1} title="What" description="The agent and what it should do each run.">
          <Field label="Agent" htmlFor="task-agent" error={shown.agent}>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger
                id="task-agent"
                aria-invalid={Boolean(shown.agent)}
                className="h-10 rounded-xl border-border/80 bg-background px-3 focus:ring-0 focus-visible:ring-4 focus-visible:ring-primary/15 focus-visible:ring-offset-0"
              >
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent className="z-[93] rounded-xl border border-border/60 bg-popover shadow-lg">
                {agentOptions.map((agent) => {
                  const Icon = agent.icon ?? Building2;
                  return (
                    <SelectItem key={agent.id} value={agent.id} className="rounded-lg">
                      <span className="flex items-center gap-2">
                        <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
                          <Icon className="h-3 w-3" aria-hidden />
                        </span>
                        {agent.name}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Name" htmlFor="task-title" optional>
            <input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Daily news digest"
              className={fieldClass}
            />
          </Field>

          <Field label="Instruction" htmlFor="task-prompt" error={shown.prompt}>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do each run?"
              rows={4}
              aria-invalid={Boolean(shown.prompt)}
              className={cn(fieldClass, "min-h-[6.5rem] resize-y leading-relaxed")}
            />
          </Field>
        </Section>

        <Section step={2} title="When" description="Once, on a repeat, or on a calendar schedule.">
          <Segmented
            ariaLabel="Schedule type"
            value={scheduleKind}
            options={SCHEDULE_KINDS}
            onChange={setScheduleKind}
          />

          {scheduleKind === "interval" ? (
            <div className="space-y-3">
              <Field label="Repeat every" htmlFor="task-interval" error={shown.interval}>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="task-interval"
                    type="number"
                    min={1}
                    aria-label="Interval amount"
                    aria-invalid={Boolean(shown.interval)}
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                    className={cn(fieldClass, "w-24 tabular-nums")}
                  />
                  <div className="min-w-[14rem] flex-1">
                    <Segmented
                      size="sm"
                      ariaLabel="Interval unit"
                      value={intervalUnit}
                      options={INTERVAL_UNITS.map((u) => ({ id: u.id, label: u.label }))}
                      onChange={setIntervalUnit}
                    />
                  </div>
                </div>
              </Field>
              <div className="flex flex-wrap gap-1.5" aria-label="Quick picks">
                {INTERVAL_PRESETS.map((p) => {
                  const active = p.value === intervalValue && p.unit === intervalUnit;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        setIntervalValue(p.value);
                        setIntervalUnit(p.unit);
                      }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/70 text-muted-foreground supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground",
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : scheduleKind === "cron" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Repeats">
                {CRON_PRESETS.map((p) => {
                  const active = builder.preset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => updateBuilder({ preset: p.id })}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/70 text-muted-foreground supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground",
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>

              {builder.preset !== "custom" ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="At" htmlFor="task-cron-time">
                    <input
                      id="task-cron-time"
                      type="time"
                      value={builder.time}
                      onChange={(e) => e.target.value && updateBuilder({ time: e.target.value })}
                      className={cn(fieldClass, "w-32 tabular-nums")}
                    />
                  </Field>
                  {builder.preset === "monthly" ? (
                    <Field label="On day" htmlFor="task-cron-mday">
                      <input
                        id="task-cron-mday"
                        type="number"
                        min={1}
                        max={31}
                        value={builder.monthDay}
                        onChange={(e) =>
                          updateBuilder({
                            monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                          })
                        }
                        className={cn(fieldClass, "w-24 tabular-nums")}
                      />
                    </Field>
                  ) : null}
                  {builder.preset === "weekly" ? (
                    <div className="space-y-1.5">
                      <span className="block text-xs font-medium text-foreground/90">On</span>
                      <div className="flex gap-1" role="group" aria-label="Days of the week">
                        {WEEK.map((d) => {
                          const on = builder.weekdays.includes(d.value);
                          return (
                            <button
                              key={d.value}
                              type="button"
                              aria-pressed={on}
                              aria-label={d.label}
                              title={d.label}
                              onClick={() => {
                                const next = on
                                  ? builder.weekdays.filter((v) => v !== d.value)
                                  : [...builder.weekdays, d.value];
                                updateBuilder({ weekdays: next.length ? next : builder.weekdays });
                              }}
                              className={cn(
                                "grid h-9 w-9 place-items-center rounded-full text-xs font-semibold transition-[background-color,color,transform] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                on
                                  ? "bg-primary text-primary-foreground shadow-[0_4px_12px_-6px_hsl(var(--primary)/0.8)]"
                                  : "bg-muted text-muted-foreground supports-[hover:hover]:hover:text-foreground",
                              )}
                            >
                              {d.short}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                <Field
                  label="Cron expression"
                  htmlFor="task-cron"
                  error={shown.cron}
                  hint="Five fields: minute hour day month weekday."
                >
                  <input
                    id="task-cron"
                    aria-label="Cron expression"
                    aria-invalid={Boolean(shown.cron)}
                    value={cronExpr}
                    onChange={(e) => {
                      setCronExpr(e.target.value);
                      setBuilder((prev) => ({ ...prev, preset: "custom" }));
                    }}
                    placeholder="0 8 * * 1-5"
                    spellCheck={false}
                    className={cn(fieldClass, "font-mono text-[13px]")}
                  />
                </Field>
                <Field
                  label="Timezone"
                  htmlFor="task-tz"
                  error={shown.timezone ?? (!tzValid ? "Unknown timezone." : null)}
                >
                  <input
                    id="task-tz"
                    aria-label="Timezone"
                    aria-invalid={!tzValid}
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="Europe/Athens"
                    spellCheck={false}
                    className={fieldClass}
                  />
                </Field>
              </div>
            </div>
          ) : (
            <Field label="Run at" htmlFor="task-run-at" error={shown.runAt}>
              <input
                id="task-run-at"
                type="datetime-local"
                aria-label="Run at"
                aria-invalid={Boolean(shown.runAt)}
                min={minRunAt}
                value={runAtLocal}
                onChange={(e) => setRunAtLocal(e.target.value)}
                className={cn(fieldClass, "sm:w-64")}
              />
            </Field>
          )}

          {/* Live preview. */}
          <div
            className="relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/[0.05] p-3.5"
            aria-live="polite"
            data-testid="schedule-preview"
          >
            <div className="flex items-start gap-2.5">
              <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <CalendarClock className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{preview.summary}</p>
                {preview.runs.length ? (
                  <ol className="mt-2 space-y-1">
                    {preview.runs.map((run, i) => (
                      <li key={run.getTime()} className="flex items-center gap-2 text-xs">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                            i === 0 ? "bg-primary" : "bg-primary/35",
                          )}
                          aria-hidden
                        />
                        <span className="tabular-nums text-foreground/90">
                          {formatRunTime(run, now)}
                        </span>
                        <span className="text-muted-foreground">{formatRelative(run, now)}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {preview.note ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{preview.note}</p>
                ) : null}
              </div>
            </div>
          </div>
        </Section>

        <Section step={3} title="Where it runs" description="Where each run's answer lands.">
          <div className="space-y-1.5">
            <Segmented
              ariaLabel="Where results go"
              value={targetMode}
              options={TARGET_MODES.map((m) => ({ id: m.id, label: m.label, icon: m.icon }))}
              onChange={setTargetMode}
            />
            {targetHint ? <p className="text-xs text-muted-foreground">{targetHint}</p> : null}
          </div>
          {targetMode === "fresh" ? (
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/70 bg-background/60 px-3 py-2.5 transition-colors supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]">
              <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <EyeOff className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">Private runs</span>
                <span className="block text-xs text-muted-foreground">
                  Each run opens as a private chat.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Private runs"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative h-5 w-9 flex-shrink-0 rounded-full bg-muted-foreground/30 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-background after:shadow after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/60"
              />
            </label>
          ) : null}
        </Section>
      </div>

      {/* Sticky footer. */}
      <div className="flex-shrink-0 border-t border-border/60 bg-card/95 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:px-6">
        {submitError ? (
          <p
            className="mb-3 flex items-start gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <CircleAlert className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {submitError}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full px-4 py-2 text-sm font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden />
            )}
            {submitLabel ?? "Create task"}
          </button>
        </div>
      </div>
    </form>
  );
}
