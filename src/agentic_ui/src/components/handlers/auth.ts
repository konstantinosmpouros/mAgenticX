import type { ToolMetadata, UserPreferences, UserProfile } from '@/lib/types';
import { authenticate, getAgents, getConversations, getTools, getUserPreferences } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';
import { saveSession, clearSession } from '@/lib/authStorage';

type AuthCtx = {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setAvailableTools: (v: ToolMetadata[]) => void;
  setUserPreferences: (v: UserPreferences | null) => void;
  setConversations: (v: any) => void;
  setConversationsLoading: (v: boolean) => void;
  setLoginUsername: (v: string) => void;
  setLoginPassword: (v: string) => void;
  setShowUserProfile: (v: boolean) => void;
  clearChatAndStopThinking: () => void;
  persistUIState: () => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  loginUsername: string;
  loginPassword: string;
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
  } = ctx;

  const handleLogin = async () => {
    try {
      const response = await authenticate({ username: loginUsername.trim(), password: loginPassword.trim() });

      if (response.authenticated && response.user && response.user.id) {
        const user = response.user;
        const ttlSeconds = typeof response.tokenTtl === 'number' && response.tokenTtl > 0 ? response.tokenTtl : 3600;
        const ttlMs = ttlSeconds * 1000;
        setTimeout(async () => {
          setIsLoggedIn(true);
          setUserProfile(user);
          setUserId(user.id);
          // Persist session with 1 hour TTL
          saveSession(user, ttlMs);
          setConversationsLoading(true);
          const agentsPromise = getAgents();
          const toolsPromise = getTools();
          const preferencesPromise = getUserPreferences(user.id);
          const conversationsPromise = getConversations(user.id);

          try {
            const agentsList = await agentsPromise;
            setAgents(agentsList);
          } catch (e) {
            console.error("Failed to fetch agents after login:", e);
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

        setLoginUsername('');
        setLoginPassword('');
      } else {
        toast({ title: 'Authentication failed', description: 'Please check your credentials and try again.', variant: 'destructive', duration: 2000 });
      }
    } catch (error) {
      console.error('Authentication error:', error);
      toast({ title: 'Login Failed', description: 'Unable to connect to authentication service', variant: 'destructive' });
    }
  };

  const handleLogoutLocal = () => {
    clearSession();
    setUserProfile(null);
    void fetch("/api/logout", {
      method: "POST",
      credentials: "include",
    }).catch((error) => {
      console.warn("Failed to notify server about logout:", error);
    });
  };

  const handleLogout = () => {
    setShowUserProfile(false);
    setTimeout(() => {
      handleLogoutLocal();
      setIsLoggedIn(false);
      setUserId(null);
      setLoginUsername("");
      setLoginPassword("");
      setAgents([]);
      setAvailableTools([]);
      setConversations([]);
      setConversationsLoading(false);
      clearChatAndStopThinking();
      persistUIState();
    }, 300);
  };

  return { handleLogin, handleLogout };
}
