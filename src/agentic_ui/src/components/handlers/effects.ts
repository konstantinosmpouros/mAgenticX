import { useEffect, useRef } from 'react';
import type { Agent, ThinkingState, UserProfile } from '@/lib/types';
import { loadSession, isSessionValid, clearSession, updateSession } from '@/lib/authStorage';
import { saveUISnapshot, loadUISnapshot, UISnapshotSerializable } from '@/lib/uiStateStorage';
import { getAgents, getConversations } from '@/lib/api';
import { sortByUpdatedAtDesc } from '@/lib/utils';

export function useAutoScrollEffect(messages: any[], thinkingState: ThinkingState | null, messagesEndRef: React.RefObject<HTMLDivElement>, shouldAutoScroll: boolean) {
  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  useEffect(() => {
    if (!shouldAutoScroll) return;
    scrollToBottom();
  }, [messages, thinkingState, shouldAutoScroll]);
}

export function useEnsureDefaultAgentEffect(params: {
  isLoggedIn: boolean;
  userId: string | null;
  agents: Agent[];
  selectedAgent: string;
  setSelectedAgent: (v: string) => void;
}) {
  const { isLoggedIn, userId, agents, selectedAgent, setSelectedAgent } = params;

  useEffect(() => {
    if (isLoggedIn && userId && agents.length > 0) {
      const exists = agents.some(a => a.id === selectedAgent);
      if (!exists) setSelectedAgent(agents[0].id);
    }
  }, [isLoggedIn, userId, agents]);
}

export function useAuthRehydrateEffect(params: {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAgents: (v: any) => void;
  setConversations: (v: any) => void;
  setSelectedAgent?: (v: string) => void;
  setCurrentConversation?: (v: any) => void;
  setMessages?: (v: any) => void;
  setIsPrivateMode?: (v: boolean) => void;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
}) {
  const { setIsLoggedIn, setUserId, setUserProfile, setAgents, setConversations, setSelectedAgent, setCurrentConversation, setMessages, setIsPrivateMode } = params;
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const session = loadSession();
    if (!isSessionValid(session)) return;

    setIsLoggedIn(true);
    setUserId(session!.userId);
    const sessionUser = session?.user ?? null;
    setUserProfile(sessionUser);
    Promise.all([getAgents(), getConversations(session!.userId)])
      .then(([agents, conversations]) => {
        setAgents(agents);
        setConversations(sortByUpdatedAtDesc(conversations));
        // Try full UI snapshot first
        if (setSelectedAgent && setCurrentConversation && setMessages) {
          loadUISnapshot(session!.userId)
            .then((res) => {
              if (!res) return; // no snapshot
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
                // messages
                const msgs = (snapshot.messages || []).map((m) => ({
                  ...m,
                  created_at: new Date(m.created_at),
                  updated_at: new Date(m.updated_at),
                }));
                setMessages(msgs);
                if (params.setIsPrivateMode && typeof snapshot.isPrivateMode === 'boolean') params.setIsPrivateMode(snapshot.isPrivateMode);
                if (params.setSelectedAgent && snapshot.selectedAgent) params.setSelectedAgent(snapshot.selectedAgent);
                if ((params as any).setAttachments && attachments) (params as any).setAttachments(attachments);
              } catch {
                // Ignore snapshot parse issues
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        // if we cannot hydrate, clear session
        clearSession();
      });
  }, []);
}

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

// Persist a full UI snapshot on changes (debounced)
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


