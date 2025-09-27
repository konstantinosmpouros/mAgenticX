import type { UserProfile } from '@/lib/types';
import { authenticate, getAgents, getConversations } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';
import { saveSession, clearSession } from '@/lib/authStorage';

type AuthCtx = {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setConversations: (v: any) => void;
  setLoginUsername: (v: string) => void;
  setLoginPassword: (v: string) => void;
  setShowUserProfile: (v: boolean) => void;
  clearChatAndStopThinking: () => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  loginUsername: string;
  loginPassword: string;
};

export function createAuthHandlers(ctx: AuthCtx) {
  const { setIsLoggedIn, setUserId, setUserProfile, setAgents, setConversations, setLoginUsername, setLoginPassword, setShowUserProfile, clearChatAndStopThinking, toast, loginUsername, loginPassword } = ctx;

  const handleLogin = async () => {
    try {
      const response = await authenticate({ username: loginUsername.trim(), password: loginPassword.trim() });

      if (response.authenticated && response.user && response.user.id) {
        const user = response.user;
        setTimeout(async () => {
          setIsLoggedIn(true);
          setUserProfile(user);
          setUserId(user.id);
          // Persist session with 1 hour TTL
          saveSession(user, 60 * 60 * 1000);
          try {
            const [agentsList, conversationsList] = await Promise.all([getAgents(), getConversations(user.id)]);
            setAgents(agentsList);
            setConversations(sortByUpdatedAtDesc(conversationsList));
          } catch (e) {
            setAgents([]);
            setConversations([]);
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
      setConversations([]);
      clearChatAndStopThinking();
    }, 300);
  };

  return { handleLogin, handleLogout };
}
