import type { ToolMetadata, UserPreferences, UserProfile } from '@/lib/types';
import { authenticate, getAgents, getConversations, getTools, getUserPreferences, logoutSession } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';
import { saveSession, clearSession, loadSession } from '@/lib/authStorage';
import { clearUISnapshot } from '@/lib/uiStateStorage';

// Auth handlers bridge API auth with local session persistence and a full chat-shell reset.
type AuthCtx = {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setAvailableTools: (v: ToolMetadata[]) => void;
  setUserPreferences: (v: UserPreferences | null) => void;
  setConversations: (v: any) => void;
  setConversationsLoading: (v: boolean) => void;
  setLoginUsername?: (v: string) => void;
  setLoginPassword?: (v: string) => void;
  setShowUserProfile: (v: boolean) => void;
  clearChatAndStopThinking: () => void;
  persistUIState: () => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  loginUsername?: string;
  loginPassword?: string;
  onLoggedOut?: () => void;
  onClearUISnapshot?: (userId: string) => void;
};

export function createAuthHandlers(ctx: AuthCtx) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAgents,
    setConversations,
    setAvailableTools,
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
  } = ctx;

  const handleLogin = async () => {
    try {
      // Authenticate first; all follow-up bootstrap requests depend on the user id from this response.
      const response = await authenticate({ username: (loginUsername || "").trim(), password: loginPassword || "" });

      if (response.authenticated && response.user && response.user.id) {
        const user = response.user;
        const ttlSeconds = typeof response.tokenTtl === 'number' && response.tokenTtl > 0 ? response.tokenTtl : 3600;
        const ttlMs = ttlSeconds * 1000;
        setTimeout(async () => {
          // Delay the heavy state swap slightly so the login transition can settle visually.
          setIsLoggedIn(true);
          setUserProfile(user);
          setUserId(user.id);
          // Persist session with 1 hour TTL
          saveSession(user, ttlMs);
          setConversationsLoading(true);
          // Fetch all bootstrap data in parallel; each result can fail independently without blocking login.
          const agentsPromise = getAgents();
          const toolsPromise = getTools();
          const preferencesPromise = getUserPreferences(user.id);
          const conversationsPromise = getConversations(user.id);

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
        }, 600);

        setLoginUsername?.('');
        setLoginPassword?.('');
      } else {
        // The API can reject credentials without throwing, so surface that branch explicitly.
        toast({ title: 'Authentication failed', description: 'Please check your credentials and try again.', variant: 'destructive', duration: 2000 });
      }
    } catch (error) {
      console.error('Authentication error:', error);
      toast({ title: 'Login Failed', description: 'Unable to connect to authentication service', variant: 'destructive' });
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
      setConversations([]);
      setConversationsLoading(false);
      // Reuse the shared chat reset path so logout clears the same transient state as "new chat".
      clearChatAndStopThinking();
      persistUIState();
      onLoggedOut?.();
    }, 300);
  };

  return { handleLogin, handleLogout };
}
