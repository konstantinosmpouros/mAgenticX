type AgentsCtx = {
  isAgentSwitching: boolean;
  setIsAgentSwitching: (v: boolean) => void;
  setSelectedAgent: (v: string) => void;
  clearChatAndStopThinking: (options?: { preserveAgent?: boolean }) => void;
};

export function createAgentHandlers(ctx: AgentsCtx) {
  const { isAgentSwitching, setIsAgentSwitching, setSelectedAgent, clearChatAndStopThinking } = ctx;

  const handleAgentChange = (value: string) => {
    if (isAgentSwitching) return;
    setIsAgentSwitching(true);
    clearChatAndStopThinking({ preserveAgent: true });
    setTimeout(() => {
      setSelectedAgent(value);
      setTimeout(() => setIsAgentSwitching(false), 200);
    }, 300);
  };

  return { handleAgentChange };
}
