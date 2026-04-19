// Agent switching is serialized because it also clears the current chat and persists the new shell state.
type AgentsCtx = {
  isAgentSwitching: boolean;
  setIsAgentSwitching: (v: boolean) => void;
  setSelectedAgent: (v: string) => void;
  clearChatAndStopThinking: (options?: { preserveAgent?: boolean }) => void;
  persistUIState: () => void;
};

export function createAgentHandlers(ctx: AgentsCtx) {
  const { isAgentSwitching, setIsAgentSwitching, setSelectedAgent, clearChatAndStopThinking, persistUIState } = ctx;

  const handleAgentChange = (value: string) => {
    // Ignore duplicate clicks while the previous switch/reset animation is still running.
    if (isAgentSwitching) return;
    setIsAgentSwitching(true);
    // Preserve the old selection during clearing so the UI does not flash to a fallback agent.
    clearChatAndStopThinking({ preserveAgent: true });
    setTimeout(() => {
      setSelectedAgent(value);
      persistUIState();
      // Release the guard only after the new agent has had time to render.
      setTimeout(() => setIsAgentSwitching(false), 200);
    }, 300);
  };

  return { handleAgentChange };
}
