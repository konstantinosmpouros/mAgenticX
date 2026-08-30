import type {
  Skill,
  ToolMetadata,
  UserPreferences,
  UserProfile,
  UserSkill,
} from "@/shared/lib/types";
import {
  authenticate,
  getAccounts,
  getAgents,
  getConversations,
  getMySkills,
  getSkills,
  getTools,
  getUserPreferences,
  logoutAccount,
  logoutAllAccounts,
  logoutSession,
  switchAccount,
} from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import { sortByUpdatedAtDesc } from "@/shared/lib/utils";
import { saveSession, clearSession, loadSession } from "@/shared/lib/authStorage";
import { setUnauthorizedSuppressed } from "@/shared/lib/consts";
import { CONV_INITIAL_PAGE_SIZE } from "@/shared/lib/consts";

// Auth handlers bridge API auth with local session persistence and a full chat-shell reset.
export type AuthCtx = {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setAvailableTools: (v: ToolMetadata[]) => void;
  setAvailableSkills: (v: Skill[]) => void;
  setMyRegistrySkills?: (v: UserSkill[]) => void;
  setUserPreferences: (v: UserPreferences | null) => void;
  setConversations: (v: any) => void;
  setConversationsLoading: (v: boolean) => void;
  setLoginUsername?: (v: string) => void;
  setLoginPassword?: (v: string) => void;
  setShowUserProfile: (v: boolean) => void;
  clearChatAndStopThinking: () => void;
  persistUIState: () => void;
  toast: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
  loginUsername?: string;
  loginPassword?: string;
  onLoggedOut?: () => void;
  onClearUISnapshot?: (userId: string) => void;
  /** Drives the full-screen switch interstitial owned by the shell. */
  onSwitchStateChange?: (state: {
    active: boolean;
    detail?: string;
    error?: string | null;
  }) => void;
  /** Leave the current conversation route before the identity changes. */
  navigateHome?: () => void;
  /** Clear every per-user slice of the workspace store before a switch. */
  resetWorkspace?: () => void;
  /** Reads the currently-active user id at call time (not at render time). */
  activeUserId?: () => string | null;
};

export function createAuthHandlers(ctx: AuthCtx) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAgents,
    setConversations,
    setAvailableTools,
    setAvailableSkills,
    setMyRegistrySkills,
    setUserPreferences,
    setConversationsLoading,
    setLoginUsername,
    setLoginPassword,
    setShowUserProfile,
    clearChatAndStopThinking,
    persistUIState,
    toast,
    loginUsername,
    loginPassword,
    onLoggedOut,
    onClearUISnapshot,
    onSwitchStateChange,
    navigateHome,
    resetWorkspace,
    activeUserId,
  } = ctx;

  const handleLogin = async () => {
    try {
      // Authenticate first; all follow-up bootstrap requests depend on the user id from this response.
      const response = await authenticate({
        username: (loginUsername || "").trim(),
        password: loginPassword || "",
      });

      if (response.authenticated && response.user && response.user.id) {
        const user = response.user;
        const ttlSeconds =
          typeof response.tokenTtl === "number" && response.tokenTtl > 0 ? response.tokenTtl : 3600;
        const ttlMs = ttlSeconds * 1000;
        setTimeout(() => {
          // Delay the heavy state swap slightly so the login transition can settle visually.
          void bootstrapUser(user, ttlMs);
        }, 600);

        setLoginUsername?.("");
        setLoginPassword?.("");
      } else {
        // The API can reject credentials without throwing, so surface that branch explicitly.
        toast({
          title: "Authentication failed",
          description: "Please check your credentials and try again.",
          variant: "destructive",
          duration: 2000,
        });
      }
    } catch (error) {
      toastError(toast, "Login Failed", error, {
        description: "Unable to connect to authentication service",
      });
    }
  };

  /**
   * Load everything a signed-in user needs.
   *
   * Shared by login and by the account switch on purpose: two bootstrap paths
   * would drift, and a switch that quietly stopped loading (say) the skill pool
   * would look like data loss rather than a missing fetch. Every request fails
   * independently so one flaky endpoint cannot strand the session.
   */
  const bootstrapUser = async (user: UserProfile, ttlMs: number) => {
    {
      setIsLoggedIn(true);
      setUserProfile(user);
      setUserId(user.id);
      // Persist session with 1 hour TTL
      saveSession(user, ttlMs);
      setConversationsLoading(true);
      // Fetch all bootstrap data in parallel; each result can fail independently without blocking login.
      const agentsPromise = getAgents();
      const toolsPromise = getTools();
      const skillsPromise = getSkills();
      const mySkillsPromise = setMyRegistrySkills ? getMySkills(user.id) : null;
      const preferencesPromise = getUserPreferences(user.id);
      const conversationsPromise = getConversations(user.id, 1, CONV_INITIAL_PAGE_SIZE);

      try {
        const agentsList = await agentsPromise;
        setAgents(agentsList);
      } catch (e) {
        console.error("Failed to fetch agents after login:", e);
        // Keep the app responsive even if one bootstrap endpoint is temporarily unavailable.
        setAgents([]);
      }

      try {
        const toolsList = await toolsPromise;
        setAvailableTools(toolsList);
      } catch (e) {
        console.error("Failed to fetch tools after login:", e);
        setAvailableTools([]);
      }

      try {
        const skillsList = await skillsPromise;
        setAvailableSkills(skillsList);
      } catch (e) {
        console.error("Failed to fetch skills after login:", e);
        setAvailableSkills([]);
      }

      if (mySkillsPromise && setMyRegistrySkills) {
        try {
          const pool = await mySkillsPromise;
          setMyRegistrySkills(pool);
        } catch (e) {
          console.error("Failed to fetch user skill pool after login:", e);
          setMyRegistrySkills([]);
        }
      }

      try {
        const prefs = await preferencesPromise;
        setUserPreferences(prefs);
      } catch (e) {
        console.error("Failed to fetch preferences after login:", e);
        setUserPreferences(null);
      }

      try {
        const conversationsList = await conversationsPromise;
        setConversations(sortByUpdatedAtDesc(conversationsList));
        persistUIState();
      } catch (e) {
        console.error("Failed to fetch conversations after login:", e);
        setConversations([]);
      } finally {
        setConversationsLoading(false);
      }
    }
  };

  const handleLogoutLocal = () => {
    // Capture current session before clearing so we can wipe persisted UI state.
    const existing = loadSession();
    clearSession();
    setUserProfile(null);
    if (existing?.userId) {
      onClearUISnapshot?.(existing.userId);
    }
    void logoutSession().catch((error) => {
      console.warn("Failed to notify server about logout:", error);
    });
  };

  const handleLogout = () => {
    // A deliberate logout must be silent. Tearing down the session races with
    // any in-flight authenticated requests, which 401 once it's gone and would
    // otherwise fire the global "Session expired" reaction — suppress it for
    // the logout window (a genuine idle expiry still surfaces normally).
    setUnauthorizedSuppressed(true);
    // Close the profile panel first so logout feels immediate before the full shell reset finishes.
    setShowUserProfile(false);
    setTimeout(() => {
      handleLogoutLocal();
      setIsLoggedIn(false);
      setUserId(null);
      setLoginUsername?.("");
      setLoginPassword?.("");
      setAgents([]);
      setAvailableTools([]);
      setAvailableSkills([]);
      setMyRegistrySkills?.([]);
      setConversations([]);
      setConversationsLoading(false);
      // Reuse the shared chat reset path so logout clears the same transient state as "new chat".
      clearChatAndStopThinking();
      persistUIState();
      onLoggedOut?.();
      // Re-arm once trailing in-flight 401s have settled, so a later real expiry still alerts.
      setTimeout(() => setUnauthorizedSuppressed(false), 1500);
    }, 300);
  };

  /**
   * Load the accounts this browser can switch between.
   *
   * A 404 (feature disabled) or 401 (not signed in) is an answer, not a failure,
   * so both degrade to "no switcher" rather than surfacing an error.
   */
  const loadAccounts = async () => {
    try {
      return await getAccounts();
    } catch {
      return { accounts: [], canAddAccount: false, maxAccounts: 0 };
    }
  };

  /**
   * Make a parked account active.
   *
   * The order here is the whole safety argument. The interstitial goes up first
   * so the shell can unmount the workspace: once it is gone, nothing is left
   * mounted that could receive a late response from the account being left and
   * render it under the new identity. Only then is the switch performed, and only
   * after it succeeds is the new user bootstrapped.
   *
   * The previous account's UI snapshot is deliberately NOT cleared — it is keyed
   * by user id, so leaving it means switching back restores their view.
   */
  const handleSwitchAccount = async (accountId: string, label?: string) => {
    onSwitchStateChange?.({
      active: true,
      detail: label ? `Signing in as ${label}` : undefined,
      error: null,
    });
    const startedAt = Date.now();
    try {
      // Leave any conversation route first: the id in the URL belongs to the
      // account we are leaving and must not be re-fetched as the new one.
      navigateHome?.();
      // Then blank every per-user slice. The bootstrap below only *replaces*
      // what it fetches; anything lazily loaded (archived and shared
      // conversations especially) would otherwise still hold the previous
      // account's content and be shown under the new identity.
      resetWorkspace?.();

      const response = await switchAccount(accountId);
      if (!response.authenticated || !response.user?.id) {
        throw new Error("The switch did not return a session.");
      }

      const ttlSeconds =
        typeof response.tokenTtl === "number" && response.tokenTtl > 0 ? response.tokenTtl : 3600;
      await bootstrapUser(response.user, ttlSeconds * 1000);

      // Hold the interstitial briefly so a fast switch reads as a transition
      // rather than a flash of loading chrome.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 400) {
        await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
      }
      onSwitchStateChange?.({ active: false });
      return true;
    } catch (error) {
      // The cookie swap is a point of no return: by the time this fails the old
      // session may already be gone, so the only safe landing is a fresh sign-in.
      console.error("Account switch failed:", error);
      onSwitchStateChange?.({
        active: true,
        error: error instanceof Error ? error.message : "Please sign in again.",
      });
      return false;
    }
  };

  /**
   * Sign out of every account on this browser.
   *
   * Distinct from a plain logout, which ends only the active session and would
   * leave the others switchable — the wrong outcome on a shared machine.
   */
  const handleLogoutAllAccounts = () => {
    // Fire-and-forget, then tear down locally *immediately*. Awaiting the server
    // first made the whole action feel laggy, and it bought nothing: the local
    // teardown is what actually signs this browser out, and the request is
    // already dispatched so it completes regardless of the client-side
    // navigation that follows. This mirrors what a plain logout already does.
    void logoutAllAccounts().catch((error) => {
      console.warn("Failed to notify server about signing out of all accounts:", error);
    });
    // The FULL logout path, not handleLogoutLocal: that one only clears the
    // profile and localStorage, leaving isLoggedIn true and never navigating —
    // which left the user inside the app with a blank profile row.
    handleLogout();
  };

  /**
   * Sign out of one account from the switcher.
   *
   * Three cases, and the middle one is why this is not just an API call:
   *
   * * a **parked** account — revoke it and leave the session alone;
   * * the **active** account with others available — *switch away first*, then
   *   revoke the one just left. It has to be that order: authorising a switch
   *   requires a live session, so ending the current one first would strand the
   *   browser at the login screen with accounts still parked;
   * * the **last** account — a plain logout.
   */
  const handleLogoutAccount = async (
    accountId: string,
    others: { id: string; label?: string }[],
  ) => {
    const isActive = accountId === activeUserId?.();

    if (!isActive) {
      await logoutAccount(accountId);
      return "removed" as const;
    }

    const next = others.find((candidate) => candidate.id !== accountId);
    if (!next) {
      handleLogout();
      return "logged-out" as const;
    }

    const switched = await handleSwitchAccount(next.id, next.label);
    if (!switched) {
      // The switch failed and has already landed the user somewhere safe; do not
      // then revoke the account they may still be using.
      return "failed" as const;
    }
    await logoutAccount(accountId);
    return "switched" as const;
  };

  return {
    handleLogin,
    handleLogout,
    loadAccounts,
    handleSwitchAccount,
    handleLogoutAccount,
    handleLogoutAllAccounts,
  };
}
