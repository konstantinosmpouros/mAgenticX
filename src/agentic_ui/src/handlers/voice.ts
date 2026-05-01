type VoiceModeCtx = {
  toast: (opts: { title: string; description?: string; duration?: number }) => void;
};

export function createVoiceModeHandlers(ctx: VoiceModeCtx) {
  const handleVoiceMode = () => {
    ctx.toast({
      title: "Voice mode coming soon",
      description: "Real-time voice conversations will be available in a future update.",
      duration: 3000,
    });
  };

  return { handleVoiceMode };
}
