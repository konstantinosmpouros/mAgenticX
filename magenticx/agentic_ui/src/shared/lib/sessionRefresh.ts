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

export type EnsureFreshResult =
  | { status: "refreshed"; user: UserProfile | null }
  | { status: "already-fresh" }
  | { status: "failed" };

// Run under the cross-tab lock when available so only one tab across the origin
// runs POST /session/refresh at a time; degrade to a plain call otherwise.
async function withCrossTabLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined;
  if (!locks?.request) return run();
  return locks.request("mx-session-refresh", run);
}

async function postRefresh(): Promise<AuthResponse> {
  // credentials + CSRF header are attached by withSessionRequest; the refresh
  // endpoint is CSRF-protected and reads the refresh cookie the browser holds.
  const res = await fetch(REFRESH_PATH, withSessionRequest({ method: "POST" }, { csrf: true }));
  if (!res.ok) {
    throw new Error(`Session refresh failed: ${res.status}`);
  }
  return normalizeAuthResponse(await res.json());
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
 * (another tab/timer beat us to it — the shared cookie is current), or `failed`
 * (the refresh token is gone/expired → the caller should treat the session as
 * ended). Never throws.
 *
 * @param opts.force refresh even if the local marker still looks fresh — used by
 *   the 401 path, where a request already proved the access token is stale.
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
          return { status: "refreshed", user: persist(await postRefresh()) } as const;
        } catch {
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
