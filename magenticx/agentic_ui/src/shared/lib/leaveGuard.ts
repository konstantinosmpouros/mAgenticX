/**
 * One page at a time may hold the user back from leaving it — the agent
 * builder with unsaved changes. The app has no data router, so react-router's
 * `useBlocker` is not available; instead our own navigation (the sidebar's
 * entries, a page's Back and Cancel) asks here first.
 *
 * A guard either lets the move through (returns false) or takes it over
 * (returns true) and later calls `proceed` itself — after its own "Leave
 * without saving?" dialog. The browser's reload and tab close are the page's
 * own `beforeunload`; its Back button is covered by the builder's autosave.
 */
export type LeaveGuard = (proceed: () => void) => boolean;

let active: LeaveGuard | null = null;

/** Install a guard; returns the function that removes it (only if still the active one). */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  active = guard;
  return () => {
    if (active === guard) active = null;
  };
}

/** Run `proceed` now, or hand it to the active guard to run once the user agrees. */
export function guardedLeave(proceed: () => void): void {
  if (active?.(proceed)) return;
  proceed();
}

/** Wrap a handler so it goes through the guard first. */
export function guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => guardedLeave(() => fn(...args));
}
