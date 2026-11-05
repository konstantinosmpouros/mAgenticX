/**
 * A scheduled task's status on the Automations page: whether its latest run
 * is live, which chip its card shows, its cron timezone when it is not the
 * viewer's, and where its runs land. The schedule wording itself (plain
 * words, relative times, cron previews) is shared with the workflow builder's
 * schedule trigger and lives in `shared/lib/schedule.ts`.
 */
import type { ScheduledTask } from "@/shared/lib/types";

// A scheduled run is "live" while its latest fire message is still streaming.
// The one copy: the poll hook, the filters and the cards all go through here.
const RUNNING_STATUSES = new Set(["queued", "running", "cancelling"]);

/** The cron timezone when it differs from the viewer's, for a small suffix. */
export function foreignTimezone(
  task: Pick<ScheduledTask, "scheduleKind" | "timezone">,
): string | null {
  if (task.scheduleKind !== "cron" || !task.timezone) return null;
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return task.timezone === local ? null : task.timezone;
  } catch {
    return task.timezone;
  }
}

export type TaskStatusKind =
  "running" | "scheduled" | "paused" | "failed" | "lastFailed" | "completed";

export const isRunningTask = (task: Pick<ScheduledTask, "liveStatus">): boolean =>
  RUNNING_STATUSES.has(String(task.liveStatus ?? ""));

/** Which status chip a task shows. A live run wins over the stored status. */
export function taskStatusKind(task: Pick<ScheduledTask, "liveStatus" | "status">): TaskStatusKind {
  const live = String(task.liveStatus ?? "");
  if (RUNNING_STATUSES.has(live)) return "running";
  if (task.status === "paused") return "paused";
  if (task.status === "failed") return "failed";
  if (task.status === "completed") return "completed";
  if (live === "failed") return "lastFailed";
  return "scheduled";
}

export const targetModeLabel = (mode: string): string =>
  mode === "bound" ? "One ongoing chat" : "New chat each run";
