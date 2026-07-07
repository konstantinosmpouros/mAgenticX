import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import type { Agent, ConversationDetail, ConversationSummary, Skill, ToolMetadata, UserPreferences, UserProfile, UserSkill } from '@/shared/lib/types';
import { loadSession, clearSession, updateSession, saveSession } from '@/shared/lib/authStorage';
import { loadUISnapshot, saveUISnapshot, UISnapshotSerializable } from '@/shared/lib/uiStateStorage';
import {
  getAgents,
  getConversations,
  getSkills,
  getTools,
  refreshSession,
  getUserPreferences,
  restoreSession,
} from '@/shared/lib/api';
import { sortByUpdatedAtDesc } from '@/shared/lib/utils';

// ---------------------------------------------------------------------------
// Initial session state helper
// ---------------------------------------------------------------------------
export function useInitialSessionState() {
  const initialSession = typeof window !== 'undefined' ? loadSession() : null;
  const initialUserId = initialSession?.userId ?? null;
  const initialUserProfile = initialSession?.user ?? null;
  const initialLoggedIn = false;
  return { initialUserId, initialUserProfile, initialLoggedIn };
}


// ---------------------------------------------------------------------------
// Auth rehydrate effect
// ---------------------------------------------------------------------------
export function useAuthRehydrateEffect(params: {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAuthResolved?: (v: boolean) => void;
  setAgents: (v: any) => void;
  setAvailableTools?: (v: ToolMetadata[]) => void;
  setAvailableSkills?: (v: Skill[]) => void;
  setMyRegistrySkills?: (v: UserSkill[]) => void;
  setUserPreferences?: (v: UserPreferences | null) => void;
  setConversations: (v: any) => void;
  setConversationsLoading?: (v: boolean) => void;
  setCurrentConversation?: (v: ConversationDetail | null) => void;
  setLoadingConversation?: (v: boolean) => void;
  setSelectedAgent?: (v: string) => void;
  setIsPrivateMode?: (v: boolean) => void;
  setActiveProfileTab?: (v: string) => void;
  setSidebarOpen?: (v: boolean) => void;
  persistUIState?: () => void;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAuthResolved,
    setAgents,
    setAvailableTools,
    setAvailableSkills,
    setMyRegistrySkills,
    setUserPreferences,
    setConversations,
    setConversationsLoading,
    setCurrentConversation,
    setLoadingConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setActiveProfileTab,
    setSidebarOpen,
    persistUIState,
  } = params;
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      try {
        const existing = loadSession();
        const restored = await restoreSession();

        if (!restored?.authenticated || !restored.user || !restored.user.id) {
          clearSession();
          setIsLoggedIn(false);
          setUserId(null);
          setUserProfile(null);
          setAgents([]);
          setAvailableTools?.([]);
          setAvailableSkills?.([]);
          setUserPreferences?.(null);
          setConversations([]);
          setConversationsLoading?.(false);
          setLoadingConversation?.(false);
          setAuthResolved?.(true);
          return;
        }

        const ttlMs =
          typeof restored.tokenTtl === 'number' && restored.tokenTtl > 0
            ? restored.tokenTtl * 1000
            : 60 * 60 * 1000;
        saveSession(restored.user, ttlMs);
        if (existing) {
          updateSession({
            lastConversationId: existing.lastConversationId,
            selectedAgent: existing.selectedAgent,
            isPrivateMode: existing.isPrivateMode,
          });
        }

        setIsLoggedIn(true);
        setUserId(restored.user.id);
        setUserProfile(restored.user);
        setConversationsLoading?.(true);

        let hasSnapshotAgents = false;
        let needsTools = Boolean(setAvailableTools);
        // Skills always refetched from the bridge on rehydrate — they are not
        // persisted to IndexedDB; their cache lives in Redis with a TTL.
        const needsSkills = Boolean(setAvailableSkills);
        let needsPreferences = Boolean(setUserPreferences);
        let needsConversations = true;

        try {
          const snapshot = await loadUISnapshot(restored.user.id);
          if (snapshot) {
            if (typeof snapshot.selectedAgent === 'string' && setSelectedAgent) {
              setSelectedAgent(snapshot.selectedAgent);
            }
            if (typeof snapshot.isPrivateMode === 'boolean' && setIsPrivateMode) {
              setIsPrivateMode(snapshot.isPrivateMode);
            }
            if (typeof snapshot.sidebarOpen === 'boolean' && setSidebarOpen) {
              setSidebarOpen(snapshot.sidebarOpen);
            }
            if (snapshot.activeProfileTab && setActiveProfileTab) setActiveProfileTab(snapshot.activeProfileTab);

            setAgents(snapshot.agents ?? []);
            hasSnapshotAgents = Boolean(snapshot.agents && snapshot.agents.length > 0);
            if (setAvailableTools) setAvailableTools(snapshot.availableTools ?? []);
            // Skills get the agents-style flow: read snapshot for instant
            // paint, always refetch in parallel below to keep the list fresh.
            if (setAvailableSkills) setAvailableSkills(snapshot.availableSkills ?? []);
            if (setMyRegistrySkills) setMyRegistrySkills(snapshot.myRegistrySkills ?? []);
            if (setUserPreferences) setUserPreferences(snapshot.userPreferences ?? null);
            setConversations(snapshot.conversations ?? []);

            needsTools =
              Boolean(setAvailableTools) && !(snapshot.availableTools && snapshot.availableTools.length > 0);
            needsPreferences = Boolean(setUserPreferences) && !snapshot.userPreferences;
            needsConversations = true;
          }
        } catch (error) {
          console.error('Failed to hydrate from snapshot', error);
        }

        const requests: Promise<unknown>[] = [];

        requests.push(
          getAgents()
            .then((agents) => setAgents(agents))
            .catch((error) => {
              console.error('Failed to fetch agents on rehydrate', error);
              if (!hasSnapshotAgents) {
                setAgents([]);
              }
            }),
        );

        if (needsTools) {
          requests.push(
            getTools()
              .then((tools) => setAvailableTools?.(tools))
              .catch((error) => {
                console.error('Failed to fetch tools on rehydrate', error);
                setAvailableTools?.([]);
              }),
          );
        }

        if (needsSkills) {
          requests.push(
            getSkills()
              .then((skills) => setAvailableSkills?.(skills))
              .catch((error) => {
                console.error('Failed to fetch skills on rehydrate', error);
                setAvailableSkills?.([]);
              }),
          );
        }

        // The user's pool is fetched authoritatively inside useSkills when the
        // userId resolves; the snapshot paint above (setMyRegistrySkills) is
        // just the instant-paint seed. No rehydrate fetch needed here.

        if (needsPreferences) {
          requests.push(
            getUserPreferences(restored.user.id)
              .then((prefs) => setUserPreferences?.(prefs))
              .catch((error) => {
                console.error('Failed to fetch preferences on rehydrate', error);
                setUserPreferences?.(null);
              }),
          );
        }

        if (needsConversations) {
          requests.push(
            getConversations(restored.user.id)
              .then((conversationList) => setConversations(sortByUpdatedAtDesc(conversationList)))
              .catch((error) => {
                console.error('Failed to fetch conversations on rehydrate', error);
                setConversations([]);
              }),
          );
        }

        if (requests.length > 0) {
          await Promise.all(requests);
        }

        // Conversation loading is URL-driven now (the route's :conversationId is
        // the single source of truth); rehydrate no longer auto-loads a "last
        // conversation". The chat view loads from the URL once authResolved flips.
        setLoadingConversation?.(false);

        persistUIState?.();
        setConversationsLoading?.(false);
        setAuthResolved?.(true);
      } catch (error) {
        console.error('Failed to restore session', error);
        clearSession();
        setIsLoggedIn(false);
        setUserId(null);
        setUserProfile(null);
        setAgents([]);
        setAvailableTools?.([]);
        setAvailableSkills?.([]);
        setUserPreferences?.(null);
        setConversations([]);
        setConversationsLoading?.(false);
        setLoadingConversation?.(false);
        setAuthResolved?.(true);
      }
    };

    void run();
  }, []);
}


// ---------------------------------------------------------------------------
// UI snapshot persistence helper
// ---------------------------------------------------------------------------
export function useUISnapshotPersistence(params: {
  userId: string | null;
  selectedAgent: string;
  isPrivateMode: boolean;
  sidebarOpen: boolean;
  activeProfileTab: string;
  currentConversationId: string | null;
  availableTools: ToolMetadata[];
  availableSkills: Skill[];
  myRegistrySkills?: UserSkill[];
  agents: Agent[];
  conversations: ConversationSummary[];
  userPreferences: UserPreferences | null;
}) {
  const {
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId,
    availableTools,
    availableSkills,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  } = params;

  // Skills follow the same snapshot-then-overwrite pattern as agents — the
  // IndexedDB copy is just a paint accelerator on refresh; the always-fetch
  // path overwrites it with whatever the bridge returns.
  const uiSnapshot = useMemo<UISnapshotSerializable | null>(() => {
    if (!userId) return null;
    return {
      version: 4,
      selectedAgent,
      isPrivateMode,
      sidebarOpen,
      activeProfileTab,
      lastConversationId: currentConversationId,
      availableTools,
      availableSkills,
      myRegistrySkills: myRegistrySkills ?? [],
      agents,
      conversations,
      userPreferences,
    };
  }, [
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId,
    availableTools,
    availableSkills,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  ]);

  const snapshotRef = useRef<UISnapshotSerializable | null>(null);
  useEffect(() => {
    if (uiSnapshot) {
      snapshotRef.current = uiSnapshot;
    }
  }, [uiSnapshot]);

  const [persistSignal, setPersistSignal] = useState(0);
  useEffect(() => {
    if (persistSignal === 0) return;
    if (!userId || !snapshotRef.current) return;
    saveUISnapshot(userId, snapshotRef.current).catch(() => {});
  }, [userId, persistSignal]);

  const requestPersist = useCallback(() => {
    setPersistSignal((tick) => tick + 1);
  }, []);

  return { uiSnapshot, requestPersist };
}


// ---------------------------------------------------------------------------
// Session auto-refresh effect
// ---------------------------------------------------------------------------
// Refresh ~10 min before the access token expires; also the "already fresh"
// threshold — if more time than this remains when a tab acquires the cross-tab
// lock, another tab just refreshed, so this tab skips its own network call.
const SESSION_REFRESH_BUFFER_MS = 10 * 60 * 1000;

// Cross-tab single-flight for the network refresh. Only one tab across the origin
// runs POST /session/refresh at a time (Web Locks API); a tab that acquires the
// lock after another already refreshed sees the fresh session marker and skips.
// This prevents two tabs from rotating the refresh token concurrently — which
// would diverge the server-tracked jti and trip refresh-reuse detection (a false
// "stolen token" logout). Stateless — pure client-side coordination, no server
// state; degrades to a plain refresh where Web Locks is unavailable.
async function withSessionRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined;
  if (!locks?.request) {
    return run();
  }
  return locks.request("mx-session-refresh", run);
}


export function useSessionAutoRefreshEffect(params: {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) {
  const { isLoggedIn, setIsLoggedIn, setUserId, setUserProfile, toast } = params;
  const timerRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const scheduleRef = useRef<() => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const performRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      // Cross-tab single-flight. The network refresh + session-marker write both
      // happen INSIDE the lock, so the next tab to acquire it observes the fresh
      // expiry and skips — two tabs never rotate the refresh token concurrently.
      const outcome = await withSessionRefreshLock(async () => {
        const current = loadSession();
        if (current && current.expiresAt - Date.now() > SESSION_REFRESH_BUFFER_MS) {
          // Another tab already refreshed while we waited for the lock; its
          // rotated token + fresh marker are shared with us. Skip the call.
          return "already-fresh" as const;
        }
        const result = await refreshSession();
        const existing = loadSession();
        const ttlMs =
          typeof result.tokenTtl === 'number' && result.tokenTtl > 0
            ? result.tokenTtl * 1000
            : 60 * 60 * 1000;
        const userToPersist = result.user ?? existing?.user ?? null;
        if (userToPersist) {
          saveSession(userToPersist, ttlMs);
          if (existing) {
            updateSession({
              lastConversationId: existing.lastConversationId,
              selectedAgent: existing.selectedAgent,
              isPrivateMode: existing.isPrivateMode,
            });
          }
        }
        return result;
      });

      if (outcome !== "already-fresh") {
        const existing = loadSession();
        if (outcome.user) {
          setUserProfile(outcome.user);
        } else if (existing?.user) {
          setUserProfile(existing.user);
        }
        if (outcome.user?.id) {
          setUserId(outcome.user.id);
        } else if (existing?.userId) {
          setUserId(existing.userId);
        }
      }

      setIsLoggedIn(true);
      scheduleRef.current();
    } catch (error) {
      console.error('Session refresh failed:', error);
      clearTimer();
      clearSession();
      setIsLoggedIn(false);
      setUserId(null);
      setUserProfile(null);
      toast?.({
        title: 'Session expired',
        description: 'Please sign in again.',
        variant: 'warning',
        duration: 4000,
      });
    } finally {
      refreshingRef.current = false;
    }
  }, [clearTimer, setIsLoggedIn, setUserId, setUserProfile, toast]);

  const scheduleRefresh = useCallback(() => {
    clearTimer();
    if (!isLoggedIn) {
      return;
    }
    const session = loadSession();
    if (!session) return;

    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      void performRefresh();
      return;
    }

    // Refresh ~10 min before the 8-hour access token expires — a 2-min margin
    // on an 8h token is too thin if the network is slow.
    const bufferMs = 10 * 60 * 1000;
    const delay = remaining > bufferMs ? remaining - bufferMs : Math.max(remaining - 5000, 0);

    if (delay <= 0) {
      void performRefresh();
      return;
    }

    timerRef.current = window.setTimeout(() => {
      void performRefresh();
    }, delay);
  }, [clearTimer, isLoggedIn, performRefresh]);

  useEffect(() => {
    scheduleRef.current = scheduleRefresh;
  }, [scheduleRefresh]);

  useEffect(() => {
    if (!isLoggedIn) {
      clearTimer();
      return;
    }
    scheduleRefresh();

    // Silent refresh on return. Browsers throttle (and a slept device pauses)
    // timers in a backgrounded tab, so the scheduled refresh can drift or miss.
    // When the tab becomes visible / regains focus we re-evaluate via the same
    // scheduler: it refreshes immediately if the access token already expired or
    // is about to, otherwise it just re-arms the (drifted) timer. This is what
    // keeps an active-but-returning user signed in without a surprise logout,
    // and with zero per-request coupling. Uses scheduleRef so it always runs the
    // latest scheduler closure.
    const onWake = () => {
      if (document.visibilityState === "visible") {
        scheduleRef.current();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [isLoggedIn, scheduleRefresh, clearTimer]);
}


// ---------------------------------------------------------------------------
// Session state sync effect
// ---------------------------------------------------------------------------
export function useSessionStateSyncEffect(params: {
  userId: string | null;
  selectedAgent: string;
  currentConversationId: string | null;
  isPrivateMode: boolean;
}) {
  const { userId, selectedAgent, currentConversationId, isPrivateMode } = params;
  useEffect(() => {
    if (!userId) return;
    updateSession({ userId, selectedAgent, lastConversationId: currentConversationId, isPrivateMode });
  }, [userId, selectedAgent, currentConversationId, isPrivateMode]);
}


