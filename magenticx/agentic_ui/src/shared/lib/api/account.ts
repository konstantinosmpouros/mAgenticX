/**
 * Delete account (plan 32): status, request, cancel, and re-authentication.
 *
 * A request needs a recent Microsoft sign-in and the account's email typed
 * back; the server checks both, whatever the UI did. Requesting signs every
 * device out — this one included — so the caller leaves the app afterwards.
 */
import type { AccountDeletionStatus } from "../types";
import { requestJson } from "../http";
import { AccountDeletionStatusSchema } from "../schemas";
import { ACCOUNT_BASE_PATH, AUTH_BASE_PATH } from "./paths";

const deletionUrl = (userId: string) => `${ACCOUNT_BASE_PATH}/${encodeURIComponent(userId)}/deletion`;

// Whether a deletion is pending, and whether this session may request one.
export async function getAccountDeletionStatus(userId: string): Promise<AccountDeletionStatus> {
  return requestJson(deletionUrl(userId), {
    schema: AccountDeletionStatusSchema,
    fallbackMessage: "Could not load the account status",
  });
}

// Schedule the account for deletion. The response clears this browser's session.
export async function requestAccountDeletion(userId: string, confirmEmail: string): Promise<AccountDeletionStatus> {
  return requestJson(deletionUrl(userId), {
    method: "POST",
    csrf: true,
    body: { confirmEmail },
    schema: AccountDeletionStatusSchema,
    errorMessages: {
      400: "That doesn't match your account.",
      403: "Please sign in again to confirm it's you.",
      409: "Your account is already scheduled for deletion.",
      429: "Too many attempts. Please try again later.",
      503: "Account deletion is turned off right now.",
    },
    fallbackMessage: "Could not delete the account",
  });
}

// Cancel a pending deletion. Refused (409) once the purge has started.
export async function cancelAccountDeletion(userId: string): Promise<AccountDeletionStatus> {
  return requestJson(deletionUrl(userId), {
    method: "DELETE",
    csrf: true,
    schema: AccountDeletionStatusSchema,
    errorMessages: {
      404: "There is no deletion to cancel.",
      409: "Your account is already being deleted; it can no longer be cancelled.",
      429: "Too many attempts. Please try again later.",
    },
    fallbackMessage: "Could not cancel the deletion",
  });
}

// Prove it is still you: a full-page trip through Microsoft that asks for the
// password again and returns to `/?reauth=done` (or `failed`). Not a fetch —
// the browser must follow the redirects.
export function beginReauthentication(): void {
  window.location.href = `${AUTH_BASE_PATH}/oidc/login?reauth=true`;
}
