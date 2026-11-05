/**
 * A workflow's live schedule (`Workflow.schedule`, the bridge's
 * `workflow_schedules` row for its `trigger.schedule` start node) in words —
 * shared by the Automations page's workflow cards and the workflow view's
 * header and graph: the cadence, the line under it (next run, paused,
 * finished), the last scheduled run with its status, the trigger card's
 * compact subtitle, and the optimistic pause / resume. Pure: no React.
 */
import type { Workflow, WorkflowSchedule } from "@/shared/lib/types";
import {
  describeSchedule,
  formatNextRunShort,
  formatRelative,
  formatRunTime,
  parseMaybeUtc,
} from "@/shared/lib/schedule";

/** The schedule in plain words ("Every weekday at 09:00"), like a schedule card's. */
export const describeWorkflowSchedule = (schedule: WorkflowSchedule): string =>
  describeSchedule({
    scheduleKind: schedule.kind,
    scheduleSpec: schedule.spec,
    timezone: schedule.timezone,
  }) || "On a schedule";

/** The schedule's next run, or why there is none (paused, finished). */
export function scheduleNextLine(schedule: WorkflowSchedule, now: Date): string {
  if (schedule.status === "paused") return "Paused — no upcoming runs";
  if (schedule.status === "finished") return "Finished — no more runs";
  if (!schedule.nextRunAt) return "No upcoming runs";
  const next = parseMaybeUtc(schedule.nextRunAt);
  return `Next ${formatRelative(next, now)} · ${formatRunTime(next, now)}`;
}

/** The line under it: the next run, paused, finished — or, run by hand, the last edit. */
export function workflowScheduleLine(workflow: Workflow, now: Date): string {
  const schedule = workflow.schedule ?? null;
  if (schedule) return scheduleNextLine(schedule, now);
  return workflow.updatedAt
    ? `Updated ${formatRelative(parseMaybeUtc(workflow.updatedAt), now)}`
    : "Start it here or from its page";
}

/** A scheduled fire's status in words (a run's status while the run exists, else what the fire recorded). */
const LAST_RUN_WORDS: Record<string, string> = {
  queued: "starting",
  started: "starting",
  running: "running",
  waiting: "waiting for approval",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped — a run was already live",
};

/** The last scheduled run, when the schedule has run at least once: when, and how it went. */
export const workflowLastRun = (
  workflow: Workflow,
  now: Date,
): { label: string; failed: boolean } | null =>
  workflow.schedule ? scheduleLastRun(workflow.schedule, now) : null;

/** A schedule's last fire: when, and how it went. Null before its first. */
export function scheduleLastRun(
  schedule: WorkflowSchedule,
  now: Date,
): { label: string; failed: boolean } | null {
  if (!schedule.lastRunAt) return null;
  const when = `Last scheduled run ${formatRelative(parseMaybeUtc(schedule.lastRunAt), now)}`;
  const words = schedule.lastRunStatus ? LAST_RUN_WORDS[schedule.lastRunStatus] : undefined;
  return {
    label: words ? `${when} · ${words}` : when,
    failed: schedule.lastRunStatus === "failed",
  };
}

/** The trigger card's compact line: "Every day · next 08:00", or "Paused" / "Finished". */
export function workflowScheduleSubtitle(
  schedule: WorkflowSchedule,
  now: Date,
): { text: string; paused: boolean } {
  if (schedule.status === "paused") return { text: "Paused", paused: true };
  if (schedule.status === "finished") return { text: "Finished", paused: true };
  const words = describeWorkflowSchedule(schedule);
  // A one-off already names its moment.
  if (!schedule.nextRunAt || schedule.kind === "one_off") return { text: words, paused: false };
  return {
    text: `${words} · next ${formatNextRunShort(parseMaybeUtc(schedule.nextRunAt), now)}`,
    paused: false,
  };
}

/**
 * The schedule as it will read once a pause (or resume) lands, shown before
 * the server answers. Pause leaves a finished schedule alone, as the bridge
 * does; resume's next slot is the server's to say, so `nextRunAt` stays until
 * its answer replaces the whole object.
 */
export function optimisticSchedule(schedule: WorkflowSchedule, paused: boolean): WorkflowSchedule {
  if (schedule.status === "finished") return schedule;
  return { ...schedule, status: paused ? "paused" : "active" };
}

/**
 * Pause or resume optimistically: `apply` the expected schedule at once, then
 * the server's answer — or, when `send` fails, the schedule as it was (the
 * error is rethrown for the caller's toast).
 */
export async function setSchedulePausedOptimistic({
  current,
  paused,
  apply,
  send,
}: {
  current: WorkflowSchedule;
  paused: boolean;
  apply: (schedule: WorkflowSchedule) => void;
  send: () => Promise<WorkflowSchedule>;
}): Promise<WorkflowSchedule> {
  apply(optimisticSchedule(current, paused));
  try {
    const next = await send();
    apply(next);
    return next;
  } catch (error) {
    apply(current);
    throw error;
  }
}
