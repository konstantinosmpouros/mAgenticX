/**
 * Wording for the data-export cooldown (plan 27).
 *
 * The window is a week by default, so the Export row has to speak in weeks and
 * dates: "One export every 10080 minutes" is unreadable, and a bare time of day
 * ("Available at 04:01") is wrong whenever that 04:01 is days away.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

const unitPhrase = (count: number, unit: string) => (count === 1 ? unit : `${count} ${unit}s`);

/** The window in its largest whole unit — "week", "3 days", "hour", "45 minutes" — to follow "One export per". */
export function describeCooldownWindow(minutes: number): string {
  if (minutes >= MINUTES_PER_WEEK && minutes % MINUTES_PER_WEEK === 0) {
    return unitPhrase(minutes / MINUTES_PER_WEEK, "week");
  }
  if (minutes >= MINUTES_PER_DAY && minutes % MINUTES_PER_DAY === 0) {
    return unitPhrase(minutes / MINUTES_PER_DAY, "day");
  }
  if (minutes >= MINUTES_PER_HOUR && minutes % MINUTES_PER_HOUR === 0) {
    return unitPhrase(minutes / MINUTES_PER_HOUR, "hour");
  }
  return unitPhrase(minutes, "minute");
}

/** When the next export opens, to follow "Available": "today at 16:01", or the day too when it is not today. */
export function formatAvailableAt(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `today at ${time}`;
  const day = at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} at ${time}`;
}
