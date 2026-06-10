type AgentsCtx = {
  setSelectedAgent: (v: string) => void;
  persistUIState: () => void;
};

export function createAgentHandlers(ctx: AgentsCtx) {
  const { setSelectedAgent, persistUIState } = ctx;

  // Per-message agents: switching the picker sets the agent the NEXT message
  // will be sent to, within the same conversation. It no longer clears the
  // chat — each message keeps the agent that produced it.
  const handleAgentChange = (value: string) => {
    setSelectedAgent(value);
    persistUIState();
  };

  return { handleAgentChange };
}
