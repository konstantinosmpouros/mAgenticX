/**
 * When a builder's autosaved draft was stored, as a restore banner says it
 * (the agent builder's and the workflow builder's).
 */

/** "10:42" today, "Mon 10:42" this week, else "12 Oct, 10:42" — as the banner says it. */
export function formatSavedAt(savedAt: number, now = Date.now()): string {
  const date = new Date(savedAt);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  if (now - savedAt < 6 * 24 * 60 * 60 * 1000) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}
