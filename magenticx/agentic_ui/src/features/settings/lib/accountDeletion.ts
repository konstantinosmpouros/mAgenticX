/**
 * Small pure helpers for "Delete account" (plan 32): the confirmation check,
 * the date wording, and the hand-off to the login page after a request.
 *
 * The server repeats every check; these exist so the UI says the same thing
 * the server will decide, before the user presses the button.
 */

/** Whether what the user typed matches the account — trimmed, case-insensitive, as the server compares. */
export function confirmationMatches(typed: string, expected: string): boolean {
  const target = expected.trim().toLowerCase();
  return target.length > 0 && typed.trim().toLowerCase() === target;
}

/** "Sunday, October 19, 2026" — a deletion date is a day, not a moment. */
export function formatDeletionDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Where the app goes after a request: the session has ended, the login page explains. */
export function loginUrlAfterDeletion(scheduledFor: string | null): string {
  const query = new URLSearchParams({ deletion: "scheduled" });
  if (scheduledFor) query.set("on", scheduledFor);
  return `/login?${query.toString()}`;
}

/** The login page's notice after a request, or `null` when it did not come from one. */
export function readDeletionNotice(search: string): { scheduledFor: string | null } | null {
  const params = new URLSearchParams(search);
  if (params.get("deletion") !== "scheduled") return null;
  const on = params.get("on");
  return { scheduledFor: on && !Number.isNaN(Date.parse(on)) ? on : null };
}
