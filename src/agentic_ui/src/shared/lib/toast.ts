/**
 * The single way a caught error becomes a user-visible toast.
 *
 * Before this helper existed the same `catch (error) { console.error(...);
 * toast({ ..., variant: 'destructive' }) }` block was written out at ~88 call
 * sites across 19 files, and exactly one of them knew to stay quiet on a 401.
 * That is why an expired session produced a shower of red toasts: every
 * in-flight request failed at once and each one announced itself, on top of the
 * "Session expired" notice the auth layer was already showing.
 *
 * Centralising it fixes both problems at once — the duplication and the 401
 * behaviour — and gives us one place to change error presentation later.
 */
import type { ReactNode } from "react";

/**
 * Structural shape of the `toast` function. Deliberately minimal (rather than
 * importing `ToastOptions`) so every differently-typed `toast` slot threaded
 * through the feature handler contexts stays assignable without casts.
 */
type ToastLike = (options: {
  title?: ReactNode;
  description?: ReactNode;
  variant?: string;
  duration?: number;
}) => unknown;

/** Errors raised by the HTTP layer carry the response status. */
export const isUnauthorizedError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { status?: number }).status === 401;

/** Prefer the server's message; fall back to something actionable. */
const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return "Please try again in a moment.";
};

export interface ToastErrorOptions {
  /** Overrides the message derived from the error itself. */
  description?: ReactNode;
  /** Auto-dismiss window in ms; omit for the destructive-variant default. */
  duration?: number;
}

/**
 * Report a failed operation to the user.
 *
 * A 401 is swallowed on purpose: the HTTP layer already refreshed-and-retried,
 * and if it still failed the session is genuinely gone — `emitUnauthorized`
 * drives the logout and shows the one notice that matters. Per-call-site error
 * toasts on top of that are noise about a problem the user cannot act on.
 */
export function toastError(
  toast: ToastLike,
  title: string,
  error?: unknown,
  options: ToastErrorOptions = {},
): void {
  if (import.meta.env.DEV) {
    console.error(`${title}:`, error);
  }
  if (isUnauthorizedError(error)) return;

  toast({
    title,
    description: options.description ?? describeError(error),
    variant: "destructive",
    ...(options.duration === undefined ? {} : { duration: options.duration }),
  });
}
