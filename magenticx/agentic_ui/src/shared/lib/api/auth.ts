/**
 * Authentication and multi-account session API.
 *
 * Covers login (password + Entra), session read/refresh/logout, and the
 * per-browser account switcher.
 */
import type { AccountList, AuthRequest, AuthResponse } from "../types";
import { requestJson, requestVoid } from "../http";
import { AccountListSchema } from "../schemas";
import { normalizeAuthResponse } from "../utils";
import { AUTH_BASE_PATH } from "./paths";

// Authenticate user credentials. A failed login is a credential error, not a
// session expiry, so it must NOT emit the global unauthorized event; the
// Retry-After header is captured so the form can show a rate-limit countdown.
export async function authenticate(
  credentials: AuthRequest,
  // "Add another account": park the session that is already active instead of
  // replacing it, so the browser ends up signed in to both.
  options: { park?: boolean } = {},
): Promise<AuthResponse> {
  const query = options.park ? "?park=true" : "";
  const data = await requestJson(`${AUTH_BASE_PATH}/login${query}`, {
    method: "POST",
    body: credentials,
    emitOn401: false,
    // A 401 here is bad credentials, not an expired session — never refresh-retry.
    skipAuthRetry: true,
    captureRetryAfter: true,
    errorMessages: {
      429: "You are signed in to the maximum number of accounts. Sign out of one first.",
    },
    fallbackMessage: "Failed to authenticate",
  });
  return normalizeAuthResponse(data);
}

// Get current session info (used for session restoration and auth checks). A 401
// here is an expected "not signed in" answer, not an event-worthy expiry.
export async function getSessionMe(): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/session`, {
    emitOn401: false,
    // restoreSession() owns the 401→refresh fallback here; don't double-refresh.
    skipAuthRetry: true,
    fallbackMessage: "Failed to fetch current session",
  });
  return normalizeAuthResponse(data);
}

// Attempt to restore user session, first by checking current session, then by trying to refresh if unauthorized
export async function restoreSession(): Promise<AuthResponse | null> {
  try {
    return await getSessionMe();
  } catch (error) {
    if ((error as { status?: number })?.status !== 401) {
      throw error;
    }
  }

  try {
    return await refreshSession(false);
  } catch {
    return null;
  }
}

// Refresh user session
export async function refreshSession(emitOnUnauthorized: boolean = true): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/session/refresh`, {
    method: "POST",
    csrf: true,
    emitOn401: emitOnUnauthorized,
    // This IS the refresh — a 401 means the refresh token is dead; never recurse.
    skipAuthRetry: true,
    fallbackMessage: "Failed to refresh session",
  });
  return normalizeAuthResponse(data);
}

// Logout user session. A 401 means the session was already gone — treat it as a
// successful logout rather than an error, and do not emit an unauthorized event.
export async function logoutSession(): Promise<void> {
  await requestVoid(`${AUTH_BASE_PATH}/logout`, {
    method: "POST",
    csrf: true,
    ignoreStatuses: [401],
    fallbackMessage: "Failed to logout",
  });
}

// --- multi-account ---------------------------------------------------------
// The accounts this browser can switch between. A 404 means the feature is
// disabled server-side, and a 401 means "not signed in" — both are answers, not
// errors, so neither should surface a toast or trigger a refresh.
export async function getAccounts(): Promise<AccountList> {
  const data = await requestJson(`${AUTH_BASE_PATH}/accounts`, {
    schema: AccountListSchema,
    emitOn401: false,
    skipAuthRetry: true,
    fallbackMessage: "Failed to load accounts",
  });
  return data;
}

// Promote a parked account to active. On success every session cookie has been
// replaced, so the caller MUST re-bootstrap: the previous account's data is no
// longer what the server will return.
export async function switchAccount(userId: string): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/accounts/switch`, {
    method: "POST",
    body: { user_id: userId },
    csrf: true,
    // A 401/409 here is a dead or missing parked session — a real answer that the
    // caller renders, never a reason to retry as the account we just left.
    emitOn401: false,
    skipAuthRetry: true,
    errorMessages: {
      409: "That account is no longer signed in. Please add it again.",
      429: "Too many switches. Wait a moment and try again.",
    },
    fallbackMessage: "Failed to switch accounts",
  });
  return normalizeAuthResponse(data);
}

// Sign out of one specific account on this browser. Works for the active account
// and for a parked one; either way that account leaves the switcher and its
// session is denylisted. A 404 means it was already gone — treat that as done.
export async function logoutAccount(userId: string): Promise<void> {
  await requestVoid(`${AUTH_BASE_PATH}/accounts/${encodeURIComponent(userId)}/logout`, {
    method: "POST",
    csrf: true,
    ignoreStatuses: [401, 404],
    fallbackMessage: "Failed to sign out of that account",
  });
}

// Sign out of every account on this browser, not just the active one.
export async function logoutAllAccounts(): Promise<void> {
  await requestVoid(`${AUTH_BASE_PATH}/accounts/logout-all`, {
    method: "POST",
    csrf: true,
    ignoreStatuses: [401, 404],
    fallbackMessage: "Failed to sign out of all accounts",
  });
}

// Public config: whether Microsoft (Entra) SSO is available, so the login page
// only shows the button when the backend is actually configured for it. A 401
// is not meaningful here and never triggers a refresh.
export async function getAuthConfig(): Promise<{ oidcEnabled: boolean }> {
  const data = await requestJson(`${AUTH_BASE_PATH}/config`, {
    emitOn401: false,
    skipAuthRetry: true,
    fallbackMessage: "Failed to fetch auth config",
  });
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return { oidcEnabled: record.oidcEnabled === true };
}

// Enter the Entra auth-code flow. This is a full-page navigation, NOT a fetch:
// the browser must follow the 302 to Microsoft and back through the callback,
// which sets the session cookies before redirecting into the app.
export function beginEntraLogin(options: { park?: boolean } = {}): void {
  // `park` is the "add another account" path — the bridge stores the intent
  // against the flow's state, because the callback is a fresh GET from Microsoft
  // and cannot carry our query through the redirect.
  const query = options.park ? "?park=true" : "";
  window.location.href = `${AUTH_BASE_PATH}/oidc/login${query}`;
}
