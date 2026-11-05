/**
 * Schedule wording and timing, shared by every schedule editor and card: an
 * agent task's schedule (Automations → Schedules) and a workflow's
 * `trigger.schedule` start node are one model (`schedule_kind` +
 * `schedule_spec` + `timezone`), so they read the same — a schedule in plain
 * words ("Every weekday at 09:00"), relative times ("in 2 h 15 min"), the
 * calendar builder's cron round-trip, and the live preview of the next runs.
 *
 * The server stays authoritative for when a schedule fires (`nextRunAt`); the
 * cron evaluator here only previews a draft, so it handles the standard five
 * fields (lists, ranges, steps, names) and gives up quietly on anything else.
 * Pure: no React.
 */
import type {
  CronBuilder,
  CronFields,
  ScheduleIntervalUnit,
  SchedulePreviewInput,
  SchedulePreviewModel,
  ScheduleShape,
} from "@/shared/lib/types";
import { INTERVAL_UNITS, MIN_SCHEDULE_INTERVAL_SECONDS } from "@/shared/lib/consts";

/** schedule_spec stores run_at as naive-UTC ISO (no offset); parse it as UTC. */
export const parseMaybeUtc = (value: string): Date =>
  new Date(/[Z+]/.test(value) || /-\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);

const pad = (n: number) => String(n).padStart(2, "0");

export const clock = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`;

/** "Oct 24, 09:00" (with the year only when it is not this year). */
export const formatRunTime = (date: Date | null | undefined, now: Date = new Date()): string => {
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** A next run as briefly as it reads: "08:00" today, else "Oct 24, 08:00". */
export const formatNextRunShort = (date: Date, now: Date = new Date()): string =>
  date.toDateString() === now.toDateString()
    ? clock(date.getHours(), date.getMinutes())
    : formatRunTime(date, now);

/** "in 2 h 15 min", "in 3 days", "5 min ago", "just now". */
export const formatRelative = (date: Date, now: Date = new Date()): string => {
  const diff = date.getTime() - now.getTime();
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60000);
  if (minutes < 1) return future ? "in under a minute" : "just now";
  let text: string;
  if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    text = m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  } else {
    const d = Math.round(minutes / (60 * 24));
    text = d === 1 ? "1 day" : `${d} days`;
  }
  return future ? `in ${text}` : `${text} ago`;
};

/** 3600 → "hour", 7200 → "2 hours". */
export const humanizeSeconds = (seconds: number): string => {
  if (seconds > 0 && seconds % 86400 === 0) {
    const d = seconds / 86400;
    return d === 1 ? "day" : `${d} days`;
  }
  if (seconds > 0 && seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "hour" : `${h} hours`;
  }
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? "minute" : `${m} minutes`;
};

// ---------------------------------------------------------------- intervals

/** A stored seconds count as the editor's amount + unit (the largest unit that divides it). */
export const intervalFromSeconds = (
  seconds: number,
): { value: number; unit: ScheduleIntervalUnit } => {
  if (seconds > 0 && seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
  if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
};

/** An amount + unit back to whole seconds. */
export const intervalSecondsOf = (value: number, unit: ScheduleIntervalUnit): number =>
  Math.round(value * (INTERVAL_UNITS.find((u) => u.id === unit) ?? INTERVAL_UNITS[1]).seconds);

// ---------------------------------------------------------------- cron parsing

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 0,
): number[] | null {
  const values = new Set<number>();
  const toNumber = (token: string): number | null => {
    const lower = token.toLowerCase();
    if (names) {
      const idx = names.indexOf(lower);
      if (idx !== -1) return idx + nameOffset;
    }
    if (!/^\d+$/.test(token)) return null;
    return Number(token);
  };
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || part.split("/").length > 2) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      const na = toNumber(a ?? "");
      const nb = toNumber(b ?? "");
      if (na === null || nb === null) return null;
      lo = na;
      hi = nb;
    } else {
      const n = toNumber(rangePart);
      if (n === null) return null;
      lo = n;
      hi = stepPart === undefined ? n : max;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parse a five-field cron expression (or an @macro); null when it isn't one. */
export function parseCron(expr: string): CronFields | null {
  const trimmed = expr.trim().toLowerCase();
  const source = MACROS[trimmed] ?? trimmed;
  const parts = source.split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(mi, 0, 59);
  const hours = parseField(h, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12, MONTH_NAMES, 1);
  const rawWeekdays = parseField(dow, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !days || !months || !rawWeekdays) return null;
  const weekdays = [...new Set(rawWeekdays.map((d) => d % 7))].sort((a, b) => a - b);
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayStar: dom === "*" || dom === "?",
    weekdayStar: dow === "*" || dow === "?",
  };
}

const isStepFrom = (values: number[], start: number, max: number): number | null => {
  if (values.length < 2 || values[0] !== start) return null;
  const step = values[1]! - values[0]!;
  for (let i = 1; i < values.length; i += 1) if (values[i]! - values[i - 1]! !== step) return null;
  return values[values.length - 1]! + step > max ? step : null;
};

const joinWords = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

function describeDays(f: CronFields): string | null {
  if (!f.dayStar && !f.weekdayStar) return null;
  if (f.months.length !== 12) return null;
  if (!f.dayStar) {
    if (f.days.length > 3) return null;
    return `Monthly on the ${joinWords(f.days.map(ordinal))}`;
  }
  if (f.weekdayStar || f.weekdays.length === 7) return "Every day";
  const key = f.weekdays.join(",");
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Every weekend";
  if (f.weekdays.length === 1) return `Every ${DAY_LABELS[f.weekdays[0]!]}`;
  return `Every ${joinWords(f.weekdays.map((d) => DAY_SHORT[d]!))}`;
}

/**
 * A cron expression in plain words, or null when it has no short wording
 * (the caller then shows the expression itself).
 */
export function humanizeCron(expr: string): string | null {
  const f = parseCron(expr);
  if (!f) return null;
  const allHours = f.hours.length === 24;
  const allMinutes = f.minutes.length === 60;

  // Sub-daily cadences: "Every 15 minutes", "Every hour at :30", "Every 2 hours".
  if (f.dayStar && f.weekdayStar && f.months.length === 12) {
    if (allMinutes && allHours) return "Every minute";
    const minuteStep = isStepFrom(f.minutes, 0, 59);
    if (allHours && minuteStep) return `Every ${minuteStep} minutes`;
    if (allHours && f.minutes.length === 1)
      return f.minutes[0] === 0 ? "Every hour" : `Every hour at :${pad(f.minutes[0]!)}`;
    const hourStep = isStepFrom(f.hours, 0, 23);
    if (hourStep && f.minutes.length === 1)
      return `Every ${hourStep} hours${f.minutes[0] ? ` at :${pad(f.minutes[0])}` : ""}`;
  }

  if (f.minutes.length !== 1 || f.hours.length > 4) return null;
  const days = describeDays(f);
  if (!days) return null;
  const times = f.hours.map((h) => clock(h, f.minutes[0]!));
  return `${days} at ${joinWords(times)}`;
}

// ------------------------------------------------------------- cron builder

/** Read a stored expression back into the calendar builder, or "custom" when it doesn't fit one. */
export function builderFromCron(expr: string): CronBuilder {
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

/** The calendar builder as a cron expression; null for "custom" (the typed expression stands). */
export function cronFromBuilder(b: CronBuilder): string | null {
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

// ------------------------------------------------------------- timezones

/** The viewer's IANA zone, UTC when the browser won't say. */
export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The zones a timezone select offers: UTC first, then every zone the browser
 * knows; `current` (a stored zone the list lacks) is kept so it stays
 * selectable. Falls back to UTC + the viewer's own zone on an old browser.
 */
export function timeZoneOptions(current?: string | null): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    zones = [];
  }
  const list = ["UTC", ...zones.filter((zone) => zone !== "UTC")];
  for (const extra of [browserTimezone(), current]) {
    if (extra && !list.includes(extra)) list.push(extra);
  }
  return list;
}

// ------------------------------------------------------------- cron next runs

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function tzParts(date: Date, timeZone: string) {
  let fmt = tzFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    tzFormatters.set(timeZone, fmt);
  }
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** The UTC instant of a wall-clock time in `timeZone`. */
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = tzParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** The next `count` fire times of a cron expression after `from`, in `timeZone`. */
export function nextCronRuns(
  expr: string,
  timeZone: string,
  count = 3,
  from: Date = new Date(),
): Date[] {
  const f = parseCron(expr);
  if (!f || !isValidTimeZone(timeZone)) return [];
  const runs: Date[] = [];
  const start = tzParts(from, timeZone);
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let i = 0; i < 366 * 5 && runs.length < count; i += 1) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const wd = cursor.getUTCDay();
    cursor.setUTCDate(d + 1);
    if (!f.months.includes(mo)) continue;
    const domOk = f.days.includes(d);
    const dowOk = f.weekdays.includes(wd);
    // Vixie cron: with both day fields restricted, either one matching is enough.
    const dayOk =
      f.dayStar && f.weekdayStar
        ? true
        : f.dayStar
          ? dowOk
          : f.weekdayStar
            ? domOk
            : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of f.hours) {
      for (const mi of f.minutes) {
        const at = zonedToUtc(y, mo, d, h, mi, timeZone);
        if (at.getTime() > from.getTime() && !runs.some((r) => r.getTime() === at.getTime())) {
          runs.push(at);
          if (runs.length >= count) return runs;
        }
      }
    }
  }
  return runs;
}

// ------------------------------------------------------------- datetime inputs

/** A date as a `datetime-local` value: LOCAL "YYYY-MM-DDTHH:mm". */
export const toLocalInput = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** An hour from now, as a `datetime-local` value: a one-off's starting pick. */
export const defaultLocalDateTime = (): string =>
  toLocalInput(new Date(Date.now() + 60 * 60 * 1000));

/** A stored (naive-UTC or offset) ISO moment as a `datetime-local` value. */
export const localFromUtcIso = (iso: string): string => toLocalInput(parseMaybeUtc(iso));

// ------------------------------------------------------------- wording

/** A schedule in plain words ("Every weekday at 09:00", "Every 6 hours", "Once on Oct 24, 09:00"). */
export function describeSchedule(schedule: ScheduleShape): string {
  const spec = schedule.scheduleSpec ?? {};
  if (schedule.scheduleKind === "interval") {
    return `Every ${humanizeSeconds(Number(spec.interval_seconds) || 0)}`;
  }
  if (schedule.scheduleKind === "cron") {
    const expr = String(spec.cron_expr ?? "");
    return humanizeCron(expr) ?? `Cron ${expr}`;
  }
  if (schedule.scheduleKind === "one_off") {
    return spec.run_at ? `Once on ${formatRunTime(parseMaybeUtc(String(spec.run_at)))}` : "Once";
  }
  return "";
}

/**
 * A schedule editor's live preview: the cadence in words and its next runs
 * (three for a repeat, the one moment for a one-off), with a note when the
 * runs can't be known here. An interval counts from when it is saved, so its
 * runs are read from `now`.
 */
export function schedulePreview(input: SchedulePreviewInput, now: Date): SchedulePreviewModel {
  if (input.kind === "interval") {
    if (!(input.intervalSeconds >= MIN_SCHEDULE_INTERVAL_SECONDS))
      return { summary: "Every …", runs: [] };
    return {
      summary: `Every ${humanizeSeconds(input.intervalSeconds)}`,
      runs: [1, 2, 3].map((i) => new Date(now.getTime() + i * input.intervalSeconds * 1000)),
      note: "Counted from when you save.",
    };
  }
  if (input.kind === "cron") {
    const tz = input.timezone.trim() || "UTC";
    const readable = parseCron(input.cronExpr) !== null;
    const words = humanizeCron(input.cronExpr);
    const runs = isValidTimeZone(tz) ? nextCronRuns(input.cronExpr, tz, 3, now) : [];
    return {
      summary: words
        ? `${words}${tz !== browserTimezone() ? ` (${tz})` : ""}`
        : readable
          ? `Cron ${input.cronExpr.trim()}`
          : "Custom cron",
      runs,
      note: readable
        ? undefined
        : "Can't preview this expression here — it's checked when you save.",
    };
  }
  const at = input.runAt;
  if (at && !Number.isNaN(at.getTime())) {
    return { summary: `Once on ${formatRunTime(at, now)}`, runs: at > now ? [at] : [] };
  }
  return { summary: "Once", runs: [] };
}
