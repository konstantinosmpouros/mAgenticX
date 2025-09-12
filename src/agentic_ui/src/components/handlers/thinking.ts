import { useEffect } from 'react';
import type { MessageOut, Agent, ThinkingState } from '@/lib/types';

type ThinkingEffectCtx = {
  thinkingState: ThinkingState | null;
  setThinkingState: (updater: any) => void;
  agents: Agent[];
  selectedAgent: string;
  setMessages: (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
};

export function useThinkingProgressEffect(_ctx: ThinkingEffectCtx) {
  // No-op: real-time streaming updates thoughts and response now.
  useEffect(() => {}, []);
}

export function startThinking(_opts: { setThinkingState: (v: any) => void }) {
  // No-op placeholder to avoid breaking imports.
}
