// ------------------------------------------------------
// Authentication Schemas
// ------------------------------------------------------

// `AccountList` and `AccountSummary` are inferred from their Zod schemas in
// `../schemas` — re-exported here so the auth surface stays in one place.
export type { AccountList, AccountSummary } from "../schemas";

export type AuthRequest = {
  username: string;
  password: string;
};

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
};

export type AuthApiError = Error & {
  status?: number;
  retryAfterSeconds?: number;
  detail?: string;
};
