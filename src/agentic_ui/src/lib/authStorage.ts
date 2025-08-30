export type StoredSession = {
  userId: string;
  expiresAt: number; // epoch ms
  // UI snapshot
  lastConversationId?: string | null;
  selectedAgent?: string | null;
  isPrivateMode?: boolean;
};

const KEY = 'mx_auth_session';

export function saveSession(userId: string, ttlMs: number = 60 * 60 * 1000) {
  const payload: StoredSession = { userId, expiresAt: Date.now() + ttlMs };
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
    const data = JSON.parse(raw) as StoredSession;
    if (!data?.userId || !data?.expiresAt) return null;
    if (Date.now() > data.expiresAt) {
      clearSession();
      return null;
    }
    return data;
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

// Merge updates into current session, preserving original TTL
export function updateSession(partial: Partial<Omit<StoredSession, 'expiresAt'>>) {
  try {
    const existing = loadSession();
    if (!existing) return;
    const merged: StoredSession = {
      ...existing,
      ...partial,
      expiresAt: existing.expiresAt, // keep original expiry
      userId: partial.userId ?? existing.userId,
    };
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // ignore
  }
}
