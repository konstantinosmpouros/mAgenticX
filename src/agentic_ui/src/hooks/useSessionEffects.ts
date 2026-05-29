import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import type { Agent, ConversationDetail, ConversationSummary, ToolMetadata, UserPreferences, UserProfile } from '@/lib/types';
import { loadSession, clearSession, updateSession, saveSession } from '@/lib/authStorage';
import { loadUISnapshot, saveUISnapshot, UISnapshotSerializable } from '@/lib/uiStateStorage';
import {
  getAgents,
  getConversationDetail,
  getConversations,
  getTools,
  refreshSession,
  getUserPreferences,
  restoreSession,
} from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';

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
        let needsPreferences = Boolean(setUserPreferences);
        let needsConversations = true;
        let conversationId: string | null =
          typeof existing?.lastConversationId === 'string' ? existing.lastConversationId : null;

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
            if (setUserPreferences) setUserPreferences(snapshot.userPreferences ?? null);
            setConversations(snapshot.conversations ?? []);

            needsTools =
              Boolean(setAvailableTools) && !(snapshot.availableTools && snapshot.availableTools.length > 0);
            needsPreferences = Boolean(setUserPreferences) && !snapshot.userPreferences;
            needsConversations = true;

            if (typeof snapshot.lastConversationId === 'string') {
              conversationId = snapshot.lastConversationId;
              updateSession({ lastConversationId: snapshot.lastConversationId });
            }
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

        if (conversationId && setCurrentConversation) {
          setLoadingConversation?.(true);
          try {
            const detail = await getConversationDetail(restored.user.id, conversationId);
            setSelectedAgent?.(detail.agent?.id || '');
            setIsPrivateMode?.(Boolean(detail.isPrivate));
            setCurrentConversation(detail);
          } catch (error) {
            console.error('Failed to hydrate conversation detail', error);
          } finally {
            setLoadingConversation?.(false);
          }
        } else {
          setLoadingConversation?.(false);
        }

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
    agents,
    conversations,
    userPreferences,
  } = params;

  const uiSnapshot = useMemo<UISnapshotSerializable | null>(() => {
    if (!userId) return null;
    return {
      version: 2,
      selectedAgent,
      isPrivateMode,
      sidebarOpen,
      activeProfileTab,
      lastConversationId: currentConversationId,
      availableTools,
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
        if (result.user) {
          setUserProfile(result.user);
        } else if (existing?.user) {
          setUserProfile(existing.user);
        }
        if (userToPersist.id) {
          setUserId(userToPersist.id);
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

    const bufferMs = 2 * 60 * 1000;
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
    return () => {
      clearTimer();
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


