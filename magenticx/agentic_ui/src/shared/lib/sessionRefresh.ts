/**
 * Silent session-refresh primitive.
 *
 * The backend issues a short-lived access token (hours) alongside a long-lived,
 * rotating refresh token (idle 12 days / absolute 20 days). Keeping a user
 * "logged in" across that window means transparently trading the access token in
 * for a fresh pair before — or the instant after — it expires, without ever
 * surfacing the login screen while the refresh token is still alive.
 *
 * This module is that trade, written once. Two callers use it:
 *   1. the proactive timer in `useSessionEffects` (refresh ~10 min pre-expiry), and
 *   2. the 401 interceptor in `http.ts` (refresh + retry when a request is the
 *      first to notice the access token went stale — e.g. after device sleep).
 *
 * Why its own bare `fetch` instead of `api.ts`/`http.ts`: this primitive sits
 * BELOW the 401 interceptor. Routing the refresh call back through `requestRaw`
 * would let a failed refresh (itself a 401) trigger another refresh, recursing.
 * So the refresh POST is issued directly here, and never participates in the
 * retry envelope.
 *
 * Concurrency: a burst of simultaneous 401s (or a 401 racing the proactive timer)
 * must trigger exactly ONE network refresh — issuing two in parallel would rotate
 * the refresh token twice and trip the server's refresh-reuse detection, forcing
 * a false "stolen token" logout. Two guards enforce single-flight: an in-process
 * promise singleton (one tab) and the cross-tab Web Locks API (many tabs).
 *
 * A refresh that does not succeed is one of two very different things, and they
 * must never be confused:
 *   - `failed`      — the bridge ANSWERED and refused the refresh token (401/403):
 *                     idle > 12 d, absolute > 20 d, revoked, or no CSRF cookie.
 *                     The session is over and the caller logs out.
 *   - `unavailable` — no usable answer: offline, a laptop still re-joining Wi-Fi
 *                     after sleep, Docker Desktop's port forward not back yet, a
 *                     bridge restart (502/503), a rate limit (429). That proves
 *                     nothing about the session, so the caller keeps the user
 *                     signed in and retries. Folding this into `failed` is what
 *                     used to log people out on wake while their refresh cookie
 *                     was still valid — which is why a page reload let them
 *                     straight back in.
 */
import type { AuthResponse, UserProfile } from "./types";
import { loadSession, saveSession, updateSession } from "./authStorage";
import { normalizeAuthResponse, withSessionRequest } from "./utils";

const REFRESH_PATH = "/api/v1/auth/session/refresh";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

// If more than this remains on the local access-token marker when we acquire the
// refresh lock, another tab (or the timer) just refreshed — skip the network call
// and reuse the already-rotated cookie the browser now shares with us.
export const SESSION_FRESH_THRESHOLD_MS = 10 * 60 * 1000;

// Refresh-endpoint statuses that are an answer about the session itself: 401 —
// the refresh token is missing, expired or revoked; 403 — the CSRF double-submit
// failed, which no retry from this browser can fix. Every other outcome (network
// error, 429, 5xx, a proxy 502 while the bridge restarts) means "could not tell".
const SESSION_ENDED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Whether a refresh-endpoint status proves the session is over, rather than unreachable. */
export function isSessionEndedStatus(status: number): boolean {
  return SESSION_ENDED_STATUSES.has(status);
}

// Wait between attempts while the session endpoints are unreachable. Capped,
// never exhausted: giving up would mean logging out a session that is still
// valid. `waitForSessionRetry` cuts the wait short when the network comes back.
const SESSION_RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/** Backoff for the `attempt`-th consecutive unreachable try (0-based), capped at the last step. */
export function sessionRetryDelay(attempt: number): number {
  return SESSION_RETRY_BACKOFF_MS[Math.min(attempt, SESSION_RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Wait before retrying an unreachable session endpoint: `delayMs`, or less if the
 * browser reports it is back online or the tab becomes visible — the two moments
 * a connection most likely just came back (waking from sleep fires both). Rejects
 * with an `AbortError` when `signal` aborts, so a caller can stop on unmount.
 */
export function waitForSessionRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    // `timer` is declared last but only read inside cleanup, which can only run
    // once the timer or a listener has fired — i.e. after it is assigned.
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", onReconnect);
      document.removeEventListener("visibilitychange", onVisible);
      signal?.removeEventListener("abort", onAbort);
    };
    const onReconnect = () => {
      cleanup();
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onReconnect();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    window.addEventListener("online", onReconnect);
    document.addEventListener("visibilitychange", onVisible);
    signal?.addEventListener("abort", onAbort);
    const timer = window.setTimeout(onReconnect, delayMs);
  });
}

export type EnsureFreshResult =
  | { status: "refreshed"; user: UserProfile | null }
  | { status: "already-fresh" }
  | { status: "unavailable" }
  | { status: "failed" };

// What one POST to the refresh endpoint produced, before it is mapped onto the
// caller-facing EnsureFreshResult.
type RefreshAttempt =
  | { kind: "ok"; result: AuthResponse }
  | { kind: "ended" }
  | { kind: "unreachable" };

// Run under the cross-tab lock when available so only one tab across the origin
// runs POST /session/refresh at a time; degrade to a plain call otherwise.
async function withCrossTabLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined;
  if (!locks?.request) return run();
  return locks.request("mx-session-refresh", run);
}

async function postRefresh(): Promise<RefreshAttempt> {
  let res: Response;
  try {
    // credentials + CSRF header are attached by withSessionRequest; the refresh
    // endpoint is CSRF-protected and reads the refresh cookie the browser holds.
    res = await fetch(REFRESH_PATH, withSessionRequest({ method: "POST" }, { csrf: true }));
  } catch {
    // fetch rejects only when no HTTP answer arrived at all — the request never
    // reached the bridge, so it says nothing about the session.
    return { kind: "unreachable" };
  }
  if (!res.ok) {
    return isSessionEndedStatus(res.status) ? { kind: "ended" } : { kind: "unreachable" };
  }
  try {
    return { kind: "ok", result: normalizeAuthResponse(await res.json()) };
  } catch {
    // The 200's headers (and with them the rotated cookies) arrived but the body
    // was cut off. The session is fine; the retry refreshes on the new cookie.
    return { kind: "unreachable" };
  }
}

// Persist the rotated session locally, preserving the non-auth UI markers already
// stored, and return the resolved user (for React state sync in the timer).
function persist(result: AuthResponse): UserProfile | null {
  const existing = loadSession();
  const ttlMs =
    typeof result.tokenTtl === "number" && result.tokenTtl > 0
      ? result.tokenTtl * 1000
      : DEFAULT_TTL_MS;
  const user = result.user ?? existing?.user ?? null;
  if (user) {
    saveSession(user, ttlMs);
    if (existing) {
      updateSession({
        lastConversationId: existing.lastConversationId,
        selectedAgent: existing.selectedAgent,
        isPrivateMode: existing.isPrivateMode,
      });
    }
  }
  return user;
}

let inFlight: Promise<EnsureFreshResult> | null = null;

/**
 * Ensure the session is fresh, refreshing at most once across all concurrent
 * callers. Returns `refreshed` (a network rotation happened), `already-fresh`
 * (another tab/timer beat us to it — the shared cookie is current),
 * `unavailable` (no usable answer — keep the user signed in and retry later), or
 * `failed` (the bridge refused the refresh token → the session has ended). Never
 * throws.
 *
 * @param opts.force refresh even if the local marker still looks fresh — used by
 *   the WebSocket 4401 path, where a connection already proved the access token
 *   is stale.
 */
export function ensureFreshSession(opts: { force?: boolean } = {}): Promise<EnsureFreshResult> {
  if (inFlight) return inFlight;
  const run = async (): Promise<EnsureFreshResult> => {
    try {
      return await withCrossTabLock(async () => {
        const current = loadSession();
        if (!opts.force && current && current.expiresAt - Date.now() > SESSION_FRESH_THRESHOLD_MS) {
          return { status: "already-fresh" } as const;
        }
        try {
          const attempt = await postRefresh();
          if (attempt.kind === "ended") return { status: "failed" } as const;
          if (attempt.kind === "unreachable") return { status: "unavailable" } as const;
          return { status: "refreshed", user: persist(attempt.result) } as const;
        } catch {
          // Only a client-side fault reaches here (a profile the store cannot
          // serialise). Retrying would hit the same input forever, so end it.
          return { status: "failed" } as const;
        }
      });
    } finally {
      inFlight = null;
    }
  };
  inFlight = run();
  return inFlight;
}
