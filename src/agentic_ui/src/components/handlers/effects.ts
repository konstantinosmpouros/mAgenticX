import { useEffect } from 'react';
import type { Agent, ThinkingState } from '@/lib/types';

export function useAutoScrollEffect(messages: any[], thinkingState: ThinkingState | null, messagesEndRef: React.RefObject<HTMLDivElement>) {
  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, thinkingState]);
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

