import { useEffect } from 'react';
import type { MessageOut, Agent, ThinkingState } from '@/lib/types';

type ThinkingEffectCtx = {
  thinkingState: ThinkingState | null;
  setThinkingState: (updater: any) => void;
  agents: Agent[];
  selectedAgent: string;
  setMessages: (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
};

export function useThinkingProgressEffect(ctx: ThinkingEffectCtx) {
  const { thinkingState, setThinkingState, agents, selectedAgent, setMessages } = ctx;

  useEffect(() => {
    if (!thinkingState?.isActive) return;
    const interval = setInterval(() => {
      setThinkingState((prev: ThinkingState | null) => {
        if (!prev) return null as any;
        if (prev.currentThoughtIndex < prev.thoughts.length - 1) {
          return { ...prev, currentThoughtIndex: prev.currentThoughtIndex + 1 } as any;
        } else if (!prev.isDone) {
          const endTime = Date.now();
          setTimeout(() => {
            const totalTime = Math.round((endTime - prev.startTime) / 1000);
            const agentResponse: MessageOut = {
              id: prev.messageId,
              content: `Hello! I'm your ${agents.find(a => a.id === selectedAgent)?.name}. I'm here to assist you with specialized knowledge and support. How can I help you today?`,
              sender: 'ai',
              type: 'text',
              thinking: prev.thoughts.concat('Done!'),
              thinkingTime: totalTime,
              attachments: [],
              created_at: new Date(),
              updated_at: new Date(),
            } as any;
            setMessages((prevMessages: MessageOut[]) => [...prevMessages, agentResponse]);
            setThinkingState(null);
          }, 1000);
          return { ...prev, isDone: true, endTime } as any;
        }
        return prev as any;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [thinkingState, selectedAgent]);
}

export function startThinking({ setThinkingState }: { setThinkingState: (v: any) => void }) {
  const thinking = [
    "Analyzing the user's query and determining the best approach...",
    'Considering relevant context and domain-specific knowledge...',
    'Cross-referencing with specialized databases and policies...',
    'Formulating a comprehensive and helpful response...',
  ];

  setThinkingState({
    messageId: (Date.now() + 1).toString(),
    thoughts: thinking,
    currentThoughtIndex: 0,
    isActive: true,
    isDone: false,
    startTime: Date.now(),
  });
}

