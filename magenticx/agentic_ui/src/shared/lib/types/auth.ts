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
  displayName?: string;
  fullName?: string;
  avatarUrl?: string;
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
