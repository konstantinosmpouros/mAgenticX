/**
 * The user's own account: Edit profile, and Delete account (plan 32) —
 * status, request, cancel, and re-authentication.
 *
 * A request needs a recent Microsoft sign-in and the account's email typed
 * back; the server checks both, whatever the UI did. Requesting signs every
 * device out — this one included — so the caller leaves the app afterwards.
 */
import type { AccountDeletionStatus, UserProfile } from "../types";
import { requestJson } from "../http";
import { normalizeUserProfile } from "../utils";
import { AccountDeletionStatusSchema } from "../schemas";
import { ACCOUNT_BASE_PATH, AUTH_BASE_PATH } from "./paths";

const deletionUrl = (userId: string) => `${ACCOUNT_BASE_PATH}/${encodeURIComponent(userId)}/deletion`;

// Change the name the app shows; `null` goes back to the name Microsoft sends.
export async function updateProfileName(userId: string, displayName: string | null): Promise<UserProfile> {
  const data = await requestJson(`${ACCOUNT_BASE_PATH}/${encodeURIComponent(userId)}/profile`, {
    method: "PATCH",
    csrf: true,
    body: { displayName },
    errorMessages: {
      422: "That name can't be used. Use up to 64 visible characters.",
      429: "Too many changes. Please try again later.",
    },
    fallbackMessage: "Could not save your name",
  });
  return normalizeUserProfile(asRecord(data));
}

const avatarUrl = (userId: string) => `${ACCOUNT_BASE_PATH}/${encodeURIComponent(userId)}/avatar`;

// Set the user's photo. The bridge re-encodes it (a small square WebP, no
// metadata) — the file is never stored as sent.
export async function uploadAvatar(userId: string, photo: File): Promise<UserProfile> {
  const form = new FormData();
  form.append("photo", photo);
  const data = await requestJson(avatarUrl(userId), {
    method: "PUT",
    csrf: true,
    body: form,
    errorMessages: {
      413: "That photo is too large. Use one under 5 MB.",
      422: "Use a PNG, JPEG or WebP image.",
      429: "Too many changes. Please try again later.",
    },
    fallbackMessage: "Could not save your photo",
  });
  return normalizeUserProfile(asRecord(data));
}

// Remove the user's photo; the app goes back to initials.
export async function removeAvatar(userId: string): Promise<UserProfile> {
  const data = await requestJson(avatarUrl(userId), {
    method: "DELETE",
    csrf: true,
    errorMessages: { 429: "Too many changes. Please try again later." },
    fallbackMessage: "Could not remove your photo",
  });
  return normalizeUserProfile(asRecord(data));
}

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

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
