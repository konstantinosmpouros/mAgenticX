import { useEffect, useRef, useCallback } from 'react';
import type { Agent, ToolMetadata, UserPreferences, UserProfile } from '@/lib/types';
import { loadSession, isSessionValid, clearSession, updateSession, saveSession } from '@/lib/authStorage';
import { saveUISnapshot, loadUISnapshot, UISnapshotSerializable } from '@/lib/uiStateStorage';
import { getAgents, getConversations, getTools, refreshSession, getUserPreferences } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';


// ---------------------------------------------------------------------------
// Auth rehydrate effect
// ---------------------------------------------------------------------------
export function useAuthRehydrateEffect(params: {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setAvailableTools?: (v: ToolMetadata[]) => void;
  setUserPreferences?: (v: UserPreferences) => void;
  setConversations: (v: any) => void;
  setConversationsLoading?: (v: boolean) => void;
  setSelectedAgent?: (v: string) => void;
  setCurrentConversation?: (v: any) => void;
  setMessages?: (v: any) => void;
  setIsPrivateMode?: (v: boolean) => void;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAgents,
    setAvailableTools,
    setUserPreferences,
    setConversations,
    setConversationsLoading,
    setSelectedAgent,
    setCurrentConversation,
    setMessages,
    setIsPrivateMode,
  } = params;
  const started = useRef(false);
  const cachedToolsRef = useRef<ToolMetadata[] | null>(null);
  const cachedAgentsRef = useRef<Agent[] | null>(null);
  const cachedPrefsRef = useRef<UserPreferences | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const session = loadSession();
    if (!isSessionValid(session)) return;

    setIsLoggedIn(true);
    setUserId(session!.userId);
    const sessionUser = session?.user ?? null;
    setUserProfile(sessionUser);

    const hydrate = async () => {
      if (setSelectedAgent && setCurrentConversation && setMessages) {
        try {
          const res = await loadUISnapshot(session!.userId);
          if (res) {
            const { snapshot, attachments } = res;
            try {
              if (snapshot.selectedAgent) setSelectedAgent(snapshot.selectedAgent);
              if (snapshot.currentConversation && setCurrentConversation) {
                const conv = snapshot.currentConversation
                  ? {
                      ...snapshot.currentConversation,
                      created_at: snapshot.currentConversation.created_at ? new Date(snapshot.currentConversation.created_at) : null,
                      updated_at: snapshot.currentConversation.updated_at ? new Date(snapshot.currentConversation.updated_at) : null,
                    }
                  : null;
                setCurrentConversation(conv);
              }
              const msgs = (snapshot.messages || []).map((m) => ({
                ...m,
                created_at: new Date(m.created_at),
                updated_at: new Date(m.updated_at),
              }));
              setMessages(msgs);
              if (params.setIsPrivateMode && typeof snapshot.isPrivateMode === 'boolean') params.setIsPrivateMode(snapshot.isPrivateMode);
              if (Array.isArray(snapshot.agents) && snapshot.agents.length > 0) {
                cachedAgentsRef.current = snapshot.agents;
                setAgents(snapshot.agents);
              }
              if (Array.isArray(snapshot.availableTools) && snapshot.availableTools.length > 0) {
                cachedToolsRef.current = snapshot.availableTools;
                if (setAvailableTools) setAvailableTools(snapshot.availableTools);
              }
              if ((params as any).setAttachments && attachments) (params as any).setAttachments(attachments);
            } catch {
              // ignore snapshot parse issues
            }
          }
        } catch {
          // ignore snapshot load errors
        }
      }

      setConversationsLoading?.(true);
      try {
        const agentsPromise = getAgents()
          .then((agents) => {
            cachedAgentsRef.current = agents;
            return agents;
          })
          .catch((error) => {
            if (cachedAgentsRef.current) return cachedAgentsRef.current;
            throw error;
          });

        const toolsPromise = getTools()
          .then((tools) => {
            cachedToolsRef.current = tools;
            return tools;
          })
          .catch((error) => {
            if (cachedToolsRef.current) return cachedToolsRef.current;
            throw error;
          });

        const prefsPromise = getUserPreferences(session!.userId)
          .then((prefs) => {
            cachedPrefsRef.current = prefs;
            return prefs;
          })
          .catch((error) => {
            if (cachedPrefsRef.current) return cachedPrefsRef.current;
            throw error;
          });

        const conversationsPromise = getConversations(session!.userId);

        const [agents, tools, prefs, conversations] = await Promise.all([
          agentsPromise,
          toolsPromise,
          prefsPromise,
          conversationsPromise,
        ]);

        setAgents(agents);
        if (setAvailableTools) {
          setAvailableTools(tools);
        }
        if (setUserPreferences) {
          setUserPreferences(prefs);
        }
        setConversations(sortByUpdatedAtDesc(conversations));
      } catch {
        clearSession();
      } finally {
        setConversationsLoading?.(false);
      }
    };

    void hydrate();
  }, []);
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


// ---------------------------------------------------------------------------
// UI persist effect
// ---------------------------------------------------------------------------
export function useUIPersistEffect(params: {
  userId: string | null;
  snapshot: UISnapshotSerializable;
  attachments: File[];
}) {
  const { userId, snapshot, attachments } = params;
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveUISnapshot(userId, snapshot, attachments).catch(() => {});
    }, 200);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [userId, JSON.stringify(snapshot), attachments.map(a => (a as any).name + ':' + (a as any).size + ':' + (a as any).type).join('|')]);
}
