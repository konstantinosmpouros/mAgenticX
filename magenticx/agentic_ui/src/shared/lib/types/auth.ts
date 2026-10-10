// ------------------------------------------------------
// Authentication Schemas
// ------------------------------------------------------

// `AccountList` and `AccountSummary` are inferred from their Zod schemas in
// `../schemas` — re-exported here so the auth surface stays in one place.
export type { AccountList, AccountSummary } from "../schemas";
import type { PendingDeletion } from "../schemas";

export type UserProfile = {
  id: string;
  username: string;
  email?: string;
  /** The name the app shows: the user's chosen name, else Microsoft's. */
  displayName?: string;
  /** The user's own choice alone (Edit profile); absent = Microsoft's name. */
  preferredName?: string;
  fullName?: string;
  /** The photo to show: the user's own upload when set, else the provider's. */
  avatarUrl?: string;
  /** Whether the user uploaded a photo of their own (Edit profile can remove it). */
  hasOwnAvatar?: boolean;
  department?: string;
  roleTitle?: string;
  lastLoginAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthResponse = {
  authenticated: boolean;
  user?: UserProfile;
  tokenTtl?: number;
  /** Set while the account awaits deletion (plan 32): the app shows only the pending screen. */
  pendingDeletion?: PendingDeletion | null;
};
