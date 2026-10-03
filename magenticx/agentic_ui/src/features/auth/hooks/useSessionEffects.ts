import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import type {
  Agent,
  ConversationDetail,
  ConversationSummary,
  ToolMetadata,
  UserPreferences,
  UserProfile,
  UserSkill,
} from "@/shared/lib/types";
import { loadSession, clearSession, updateSession, saveSession } from "@/shared/lib/authStorage";
import {
  loadUISnapshot,
  saveUISnapshot,
  UISnapshotSerializable,
} from "@/shared/lib/uiStateStorage";
import {
  getAgents,
  getConversations,
  getTools,
  getUserPreferences,
  restoreSessionWhenReachable,
} from "@/shared/lib/api";
import { ensureFreshSession, sessionRetryDelay } from "@/shared/lib/sessionRefresh";
import { sortByUpdatedAtDesc } from "@/shared/lib/utils";
import { CONV_INITIAL_PAGE_SIZE } from "@/shared/lib/consts";

// ---------------------------------------------------------------------------
// Initial session state helper
// ---------------------------------------------------------------------------
export function useInitialSessionState() {
  const initialSession = typeof window !== "undefined" ? loadSession() : null;
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
  toast?: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
}) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAuthResolved,
    setAgents,
    setAvailableTools,
    setMyRegistrySkills,
    setUserPreferences,
    setConversations,
    setConversationsLoading,
    setLoadingConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setActiveProfileTab,
    setSidebarOpen,
    persistUIState,
    toast,
  } = params;
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      try {
        const existing = loadSession();
        // Retried until the bridge answers, with the loader still up. A tab
        // restored at browser start (or reloaded right after waking) often runs
        // this before the network is back; giving up then would send a user with
        // a valid session to the login screen.
        const restored = await restoreSessionWhenReachable({
          onUnreachable: () =>
            toast?.({
              title: "Can't reach the server",
              description: "You'll be signed back in as soon as the connection returns.",
              variant: "warning",
              duration: 5000,
            }),
        });

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
          typeof restored.tokenTtl === "number" && restored.tokenTtl > 0
            ? restored.tokenTtl * 1000
            : 60 * 60 * 1000;
        saveSession(restored.user, ttlMs);
        // Only carry the previous session's UI position forward when it belongs
        // to the SAME user. After a server-side session swap (adding an account
        // through the OIDC callback) localStorage still describes the previous
        // account, and inheriting its last conversation id would have the new
        // account try to open someone else's chat.
        if (existing && existing.userId === restored.user.id) {
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

        try {
          const snapshot = await loadUISnapshot(restored.user.id);
          if (snapshot) {
            if (typeof snapshot.selectedAgent === "string" && setSelectedAgent) {
              setSelectedAgent(snapshot.selectedAgent);
            }
            if (typeof snapshot.isPrivateMode === "boolean" && setIsPrivateMode) {
              setIsPrivateMode(snapshot.isPrivateMode);
            }
            if (typeof snapshot.sidebarOpen === "boolean" && setSidebarOpen) {
              setSidebarOpen(snapshot.sidebarOpen);
            }
            if (snapshot.activeProfileTab && setActiveProfileTab)
              setActiveProfileTab(snapshot.activeProfileTab);

            setAgents(snapshot.agents ?? []);
            hasSnapshotAgents = Boolean(snapshot.agents && snapshot.agents.length > 0);
            if (setAvailableTools) setAvailableTools(snapshot.availableTools ?? []);
            if (setMyRegistrySkills) setMyRegistrySkills(snapshot.myRegistrySkills ?? []);
            if (setUserPreferences) setUserPreferences(snapshot.userPreferences ?? null);
            setConversations(snapshot.conversations ?? []);

            needsTools =
              Boolean(setAvailableTools) &&
              !(snapshot.availableTools && snapshot.availableTools.length > 0);
            needsPreferences = Boolean(setUserPreferences) && !snapshot.userPreferences;
            needsConversations = true;
          }
        } catch (error) {
          console.error("Failed to hydrate from snapshot", error);
        }

        const requests: Promise<unknown>[] = [];

        requests.push(
          getAgents()
            .then((agents) => setAgents(agents))
            .catch((error) => {
              console.error("Failed to fetch agents on rehydrate", error);
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
                console.error("Failed to fetch tools on rehydrate", error);
                setAvailableTools?.([]);
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
                console.error("Failed to fetch preferences on rehydrate", error);
                setUserPreferences?.(null);
              }),
          );
        }

        if (needsConversations) {
          requests.push(
            getConversations(restored.user.id, 1, CONV_INITIAL_PAGE_SIZE)
              .then((conversationList) => setConversations(sortByUpdatedAtDesc(conversationList)))
              .catch((error) => {
                console.error("Failed to fetch conversations on rehydrate", error);
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
        console.error("Failed to restore session", error);
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
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  } = params;

  // The skill pool follows the same snapshot-then-overwrite pattern as agents
  // — the IndexedDB copy is just a paint accelerator on refresh; the
  // always-fetch path overwrites it with whatever the bridge returns.
  const uiSnapshot = useMemo<UISnapshotSerializable | null>(() => {
    if (!userId) return null;
    return {
      version: 5,
      selectedAgent,
      isPrivateMode,
      sidebarOpen,
      activeProfileTab,
      lastConversationId: currentConversationId,
      availableTools,
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
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  ]);

  const snapshotRef = useRef<UISnapshotSerializable | null>(null);
  // Stamp the snapshot with the user it was built for. Without this, a `userId`
  // change re-runs the effect below with a NON-zero persistSignal and the
  // PREVIOUS user's snapshot still in the ref — writing one account's
  // conversations under another account's key, which then survives a reload.
  // Reachable on every account switch, where the store is still populated with
  // the outgoing account when the id flips.
  const snapshotOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (uiSnapshot) {
      snapshotRef.current = uiSnapshot;
      snapshotOwnerRef.current = userId;
    }
  }, [uiSnapshot, userId]);

  const [persistSignal, setPersistSignal] = useState(0);
  useEffect(() => {
    if (persistSignal === 0) return;
    if (!userId || !snapshotRef.current) return;
    if (snapshotOwnerRef.current !== userId) return;
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
// Refresh ~10 min before the access token expires. The single-flight + cross-tab
// coordination (and the "already fresh, another tab beat us to it" skip) all live
// in ensureFreshSession now, so this effect only decides WHEN to refresh and how
// to reflect success/failure in React state.
export function useSessionAutoRefreshEffect(params: {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  toast?: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
}) {
  const { isLoggedIn, setIsLoggedIn, setUserId, setUserProfile, toast } = params;
  const timerRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const scheduleRef = useRef<() => void>(() => {});
  // Consecutive refreshes that got no answer from the bridge. Non-zero means a
  // refresh is still owed: the scheduler retries it rather than waiting for the
  // normal pre-expiry slot, and the count picks the backoff step.
  const retryAttemptRef = useRef(0);

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
      // ensureFreshSession does the single-flight refresh (cross-tab lock + fresh
      // marker skip + local persistence). We only sync React state and re-arm.
      const outcome = await ensureFreshSession();
      if (outcome.status === "unavailable") {
        // No answer from the bridge — offline, or the tab woke from sleep a few
        // seconds before Wi-Fi (or Docker Desktop's port forward) came back. The
        // session may be perfectly valid, so stay signed in and try again: on
        // `online`/tab focus straight away (see the effect below), otherwise
        // after the backoff. Logging out here used to sign people out on wake
        // while their refresh cookie was still valid.
        const delay = sessionRetryDelay(retryAttemptRef.current);
        retryAttemptRef.current += 1;
        clearTimer();
        // Offline means no attempt can succeed; the `online` listener retries.
        if (navigator.onLine !== false) {
          timerRef.current = window.setTimeout(() => scheduleRef.current(), delay);
        }
        return;
      }
      if (outcome.status === "failed") {
        // The bridge refused the refresh token (idle >12d, absolute >20d, or
        // revoked) — the session is genuinely over.
        throw new Error("session refresh failed");
      }
      retryAttemptRef.current = 0;

      // 'refreshed' carries the rotated user; 'already-fresh' means another tab
      // just refreshed, so read the shared persisted session for the profile.
      const existing = loadSession();
      const user = outcome.status === "refreshed" ? outcome.user : (existing?.user ?? null);
      if (user) {
        setUserProfile(user);
        if (user.id) setUserId(user.id);
      } else if (existing?.userId) {
        setUserId(existing.userId);
      }

      setIsLoggedIn(true);
      scheduleRef.current();
    } catch (error) {
      console.error("Session refresh failed:", error);
      retryAttemptRef.current = 0;
      clearTimer();
      clearSession();
      setIsLoggedIn(false);
      setUserId(null);
      setUserProfile(null);
      toast?.({
        title: "Session expired",
        description: "Please sign in again.",
        variant: "warning",
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
    // A refresh still owed after an unanswered attempt is retried now, whatever
    // ran the scheduler (backoff timer, `online`, tab focus) — the normal
    // pre-expiry slot below has already passed for it.
    if (remaining <= 0 || retryAttemptRef.current > 0) {
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
      retryAttemptRef.current = 0;
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
    // The network coming back is the moment an owed refresh can finally
    // succeed. Visibility is irrelevant here: a backgrounded tab with an expired
    // session should be repaired before the user returns to it.
    const onOnline = () => scheduleRef.current();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);

    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
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
    updateSession({
      userId,
      selectedAgent,
      lastConversationId: currentConversationId,
      isPrivateMode,
    });
  }, [userId, selectedAgent, currentConversationId, isPrivateMode]);
}
