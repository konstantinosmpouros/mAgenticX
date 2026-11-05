// ------------------------------------------------------
// Schedules — the shapes every schedule editor shares: an agent task's
// schedule (Automations → Schedules) and a workflow's `trigger.schedule` start
// node are the same model (`schedule_kind` + `schedule_spec` + `timezone`), so
// their wording, cron reading and preview are one set of helpers
// (`shared/lib/schedule.ts`).
// ------------------------------------------------------

import type { ScheduleKind } from "./tasks";

/** A schedule as the wording helpers read it: a task's, or a workflow start node's. */
export type ScheduleShape = {
  scheduleKind: ScheduleKind | string;
  scheduleSpec?: Record<string, unknown> | null;
  timezone?: string | null;
};

/** A five-field cron expression, read into the values each field allows. */
export type CronFields = {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** The day-of-month field was `*` (or `?`). */
  dayStar: boolean;
  /** The day-of-week field was `*` (or `?`). */
  weekdayStar: boolean;
};

/** The unit an interval is typed in. */
export type ScheduleIntervalUnit = "minutes" | "hours" | "days";

/** The schedule form's calendar cadences; "custom" leaves the expression as typed. */
export type CronPreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/** The schedule form's calendar builder: a cadence, a time, and its days. */
export type CronBuilder = {
  preset: CronPreset;
  time: string;
  weekdays: number[];
  monthDay: number;
};

/** What a schedule editor's live preview says: the cadence in words and its next runs. */
export type SchedulePreviewModel = { summary: string; runs: Date[]; note?: string };

/** What a schedule editor previews, whichever kind is picked. */
export type SchedulePreviewInput = {
  kind: ScheduleKind;
  intervalSeconds: number;
  cronExpr: string;
  /** IANA zone the cron expression is read in ("" reads as UTC). */
  timezone: string;
  runAt: Date | null;
};
