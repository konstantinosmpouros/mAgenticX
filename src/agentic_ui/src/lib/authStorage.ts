import type { UserProfile } from './types';

export type StoredSession = {
  userId: string;
  expiresAt: number; // epoch ms
  user?: UserProfile;
  lastConversationId?: string | null;
  selectedAgent?: string | null;
  isPrivateMode?: boolean;
};

type PersistedUserProfile = Omit<UserProfile, 'createdAt' | 'updatedAt' | 'lastLoginAt'> & {
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

type PersistedSession = {
  userId: string;
  expiresAt: number;
  user?: PersistedUserProfile;
  lastConversationId?: string | null;
  selectedAgent?: string | null;
  isPrivateMode?: boolean;
};

const KEY = 'mx_auth_session';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function serializeUser(user?: UserProfile): PersistedUserProfile | undefined {
  if (!user) return undefined;
  return {
    ...user,
    prefersAgenticChat: Boolean(user.prefersAgenticChat),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : undefined,
  };
}

function deserializeUser(data?: PersistedUserProfile): UserProfile | undefined {
  if (!data) return undefined;
  const { createdAt, updatedAt, lastLoginAt, ...rest } = data;
  return {
    ...rest,
    prefersAgenticChat: Boolean(rest.prefersAgenticChat),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    lastLoginAt: lastLoginAt ? new Date(lastLoginAt) : undefined,
  };
}

export function saveSession(user: UserProfile, ttlMs: number = DEFAULT_TTL_MS) {
  const payload: PersistedSession = {
    userId: user.id,
    expiresAt: Date.now() + ttlMs,
    user: serializeUser(user),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors (private mode, quota)
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;
    if (!data?.userId || !data?.expiresAt) return null;
    if (Date.now() > data.expiresAt) {
      clearSession();
      return null;
    }
    return {
      userId: data.userId,
      expiresAt: data.expiresAt,
      user: deserializeUser(data.user),
      lastConversationId: data.lastConversationId,
      selectedAgent: data.selectedAgent,
      isPrivateMode: data.isPrivateMode,
    };
  } catch {
    return null;
  }
}

export function isSessionValid(data: StoredSession | null): boolean {
  if (!data) return false;
  return Date.now() <= data.expiresAt;
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// Merge updates into current session, preserving original TTL unless overridden
export function updateSession(partial: Partial<Omit<StoredSession, 'expiresAt'>>) {
  try {
    const existing = loadSession();
    if (!existing) return;
    const merged: StoredSession = {
      ...existing,
      ...partial,
      expiresAt: existing.expiresAt,
      userId: partial.userId ?? existing.userId,
      user: partial.user ?? existing.user,
    };
    const payload: PersistedSession = {
      userId: merged.userId,
      expiresAt: merged.expiresAt,
      user: serializeUser(merged.user),
      lastConversationId: merged.lastConversationId,
      selectedAgent: merged.selectedAgent,
      isPrivateMode: merged.isPrivateMode,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}
