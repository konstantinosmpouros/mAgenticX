/**
 * Schedule limits and the interval units, shared by every schedule editor
 * (Automations → Schedules and a workflow's `trigger.schedule` start node).
 * The limits are the backend's: the engine's `trigger_schedule.py` and the
 * bridge's `SCHEDULER_MIN_INTERVAL_SECONDS` default — the client checks the
 * same numbers so a bad value is caught as it is typed, the server still has
 * the last word.
 */
import type { ScheduleIntervalUnit } from "../types/schedule";

/** The shortest recurring cadence (5 minutes). */
export const MIN_SCHEDULE_INTERVAL_SECONDS = 300;
/** The longest recurring cadence (366 days): anything longer is a one-off in disguise. */
export const MAX_SCHEDULE_INTERVAL_SECONDS = 366 * 24 * 3600;
/** A cron expression's longest form. */
export const MAX_CRON_CHARS = 120;
/** An IANA timezone name's longest form. */
export const MAX_TIMEZONE_CHARS = 64;

/** The units an interval is typed in, with their length in seconds. */
export const INTERVAL_UNITS: ReadonlyArray<{
  id: ScheduleIntervalUnit;
  label: string;
  seconds: number;
}> = [
  { id: "minutes", label: "Minutes", seconds: 60 },
  { id: "hours", label: "Hours", seconds: 3600 },
  { id: "days", label: "Days", seconds: 86400 },
];
