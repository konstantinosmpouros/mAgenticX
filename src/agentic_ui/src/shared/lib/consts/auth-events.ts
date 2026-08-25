/**
 * Global "session is gone" signal.
 *
 * MUST stay a single leaf module: `unauthorizedSuppressed` is module-level
 * mutable state, so a second copy of this module (e.g. reached through a
 * different import path) would give the suppressor and the emitter separate
 * flags and the suppression would silently stop working.
 */

// Dispatch a global unauthorized event so listeners can react (e.g. force logout).
// Suppressed during an intentional logout: tear-down races with any in-flight
// authenticated requests, which 401 once the session is gone — those must not
// surface as a spurious "Session expired". A genuine idle expiry (no logout in
// progress) still emits normally. Also dedupes a burst of simultaneous 401s.
let unauthorizedSuppressed = false;

export const setUnauthorizedSuppressed = (suppressed: boolean): void => {
  unauthorizedSuppressed = suppressed;
};

export const emitUnauthorized = (): void => {
  if (unauthorizedSuppressed) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("mx:unauthorized"));
};
