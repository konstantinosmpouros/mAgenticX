import * as React from "react";
import { Loader2 } from "lucide-react";

import type {
  Agent,
  ScheduledTaskCreatePayload,
  ScheduleKind,
  TaskTargetMode,
  ToolPreference,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

// Pre-fill values shared by editing a task and importing a template.
export type ScheduledTaskFormInitial = {
  agentId?: string | null;
  title?: string | null;
  prompt?: string;
  targetMode?: TaskTargetMode | string;
  scheduleKind?: ScheduleKind | string;
  scheduleSpec?: Record<string, unknown>;
  timezone?: string | null;
  enabledTools?: ToolPreference[];
};

type ScheduledTaskFormProps = {
  agents: Agent[];
  defaultEnabledTools?: ToolPreference[];
  // Pre-fill the form. When `initial.enabledTools` is present (editing a task)
  // those tools are preserved; otherwise the user's current set is seeded.
  initial?: ScheduledTaskFormInitial;
  submitLabel?: string;
  submitting: boolean;
  onSubmit: (payload: ScheduledTaskCreatePayload) => void;
  onCancel: () => void;
};

const INTERVAL_UNITS = [
  { id: "minutes", label: "minutes", seconds: 60 },
  { id: "hours", label: "hours", seconds: 3600 },
  { id: "days", label: "days", seconds: 86400 },
] as const;

const TARGET_MODES: { id: TaskTargetMode; label: string; hint: string }[] = [
  { id: "fresh", label: "New chat each run", hint: "Every run starts a fresh, isolated conversation." },
  { id: "bound", label: "One ongoing chat", hint: "Runs continue one conversation, so the agent remembers prior runs." },
];

const SCHEDULE_KINDS: { id: ScheduleKind; label: string }[] = [
  { id: "interval", label: "Repeat every" },
  { id: "cron", label: "Cron" },
  { id: "one_off", label: "Once" },
];

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

// datetime-local wants a LOCAL "YYYY-MM-DDTHH:mm" string; default to +1h.
const defaultLocalDateTime = (): string => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Derive the form's interval value+unit from a stored seconds count.
const intervalFromSeconds = (seconds: number): { value: number; unit: "minutes" | "hours" | "days" } => {
  if (seconds > 0 && seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
  if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
};

// Convert a stored naive-UTC ISO (schedule_spec.run_at) to a local datetime-local value.
const localFromUtcIso = (iso: string): string => {
  const d = new Date(/[Z+]/.test(iso) ? iso : `${iso}Z`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground";

const Segmented = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  ariaLabel: string;
}) => (
  <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1 rounded-lg bg-muted/40 p-1">
    {options.map((opt) => (
      <button
        key={opt.id}
        type="button"
        onClick={() => onChange(opt.id)}
        className={cn(
          "rounded-md px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === opt.id
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === opt.id}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export default function ScheduledTaskForm({
  agents,
  defaultEnabledTools,
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: ScheduledTaskFormProps) {
  const init = initial;
  const initInterval =
    init?.scheduleKind === "interval"
      ? intervalFromSeconds(Number(init.scheduleSpec?.interval_seconds) || 3600)
      : null;
  const activeAgents = React.useMemo(() => agents.filter((a) => a.isActive), [agents]);
  const [agentId, setAgentId] = React.useState<string>(init?.agentId ?? activeAgents[0]?.id ?? agents[0]?.id ?? "");
  const [title, setTitle] = React.useState(init?.title ?? "");
  const [prompt, setPrompt] = React.useState(init?.prompt ?? "");
  const [targetMode, setTargetMode] = React.useState<TaskTargetMode>((init?.targetMode as TaskTargetMode) ?? "fresh");
  const [scheduleKind, setScheduleKind] = React.useState<ScheduleKind>((init?.scheduleKind as ScheduleKind) ?? "interval");
  const [intervalValue, setIntervalValue] = React.useState(initInterval?.value ?? 6);
  const [intervalUnit, setIntervalUnit] = React.useState<(typeof INTERVAL_UNITS)[number]["id"]>(initInterval?.unit ?? "hours");
  const [cronExpr, setCronExpr] = React.useState(
    init?.scheduleKind === "cron" ? String(init.scheduleSpec?.cron_expr ?? "0 8 * * *") : "0 8 * * *",
  );
  const [timezone, setTimezone] = React.useState(init?.timezone ?? browserTimezone());
  const [runAtLocal, setRunAtLocal] = React.useState(
    init?.scheduleKind === "one_off" && init.scheduleSpec?.run_at
      ? localFromUtcIso(String(init.scheduleSpec.run_at))
      : defaultLocalDateTime(),
  );
  const [formError, setFormError] = React.useState<string | null>(null);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!agentId) {
      setFormError("Pick an agent.");
      return;
    }
    if (!prompt.trim()) {
      setFormError("Enter the instruction to run.");
      return;
    }

    const payload: ScheduledTaskCreatePayload = {
      agentId,
      prompt: prompt.trim(),
      title: title.trim() || undefined,
      targetMode,
      scheduleKind,
      // Editing preserves the task's existing tools; create/import seeds the user's current set.
      enabledTools: initial?.enabledTools ?? defaultEnabledTools,
    };

    if (scheduleKind === "interval") {
      const unit = INTERVAL_UNITS.find((u) => u.id === intervalUnit) ?? INTERVAL_UNITS[1];
      const seconds = Math.round(intervalValue * unit.seconds);
      if (seconds < 300) {
        setFormError("The minimum interval is 5 minutes.");
        return;
      }
      payload.intervalSeconds = seconds;
    } else if (scheduleKind === "cron") {
      if (!cronExpr.trim()) {
        setFormError("Enter a cron expression.");
        return;
      }
      payload.cronExpr = cronExpr.trim();
      payload.timezone = timezone.trim() || "UTC";
    } else {
      if (!runAtLocal) {
        setFormError("Pick a date and time.");
        return;
      }
      const when = new Date(runAtLocal);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        setFormError("Pick a future date and time.");
        return;
      }
      payload.runAt = when.toISOString();
    }

    onSubmit(payload);
  };

  const targetHint = TARGET_MODES.find((m) => m.id === targetMode)?.hint;

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4">
      <div className="space-y-1.5">
        <label htmlFor="task-agent" className="text-xs font-semibold text-foreground">
          Agent
        </label>
        <select
          id="task-agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className={fieldClass}
        >
          {(activeAgents.length ? activeAgents : agents).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="task-title" className="text-xs font-semibold text-foreground">
          Label <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Daily news digest"
          className={fieldClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="task-prompt" className="text-xs font-semibold text-foreground">
          Instruction
        </label>
        <textarea
          id="task-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do each run?"
          rows={4}
          className={cn(fieldClass, "resize-y")}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-foreground">Where results go</span>
        <Segmented
          ariaLabel="Where results go"
          value={targetMode}
          options={TARGET_MODES.map((m) => ({ id: m.id, label: m.label }))}
          onChange={(id) => setTargetMode(id as TaskTargetMode)}
        />
        {targetHint ? <p className="text-xs text-muted-foreground">{targetHint}</p> : null}
      </div>

      <div className="space-y-2">
        <span className="text-xs font-semibold text-foreground">Schedule</span>
        <Segmented
          ariaLabel="Schedule type"
          value={scheduleKind}
          options={SCHEDULE_KINDS}
          onChange={(id) => setScheduleKind(id as ScheduleKind)}
        />

        {scheduleKind === "interval" ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              aria-label="Interval amount"
              value={intervalValue}
              onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
              className={cn(fieldClass, "w-24")}
            />
            <select
              aria-label="Interval unit"
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as typeof intervalUnit)}
              className={cn(fieldClass, "w-32")}
            >
              {INTERVAL_UNITS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        ) : scheduleKind === "cron" ? (
          <div className="space-y-2">
            <input
              aria-label="Cron expression"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 8 * * 1-5"
              spellCheck={false}
              className={cn(fieldClass, "font-mono")}
            />
            <input
              aria-label="Timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Athens"
              spellCheck={false}
              className={fieldClass}
            />
            <p className="text-xs text-muted-foreground">
              Standard 5-field cron, evaluated in the timezone above.
            </p>
          </div>
        ) : (
          <input
            type="datetime-local"
            aria-label="Run at"
            value={runAtLocal}
            onChange={(e) => setRunAtLocal(e.target.value)}
            className={fieldClass}
          />
        )}
      </div>

      {formError ? (
        <p className="text-xs text-destructive" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitLabel ?? "Create task"}
        </button>
      </div>
    </form>
  );
}
