type VoiceModeCtx = {
  toast: (opts: { title: string; description?: string; duration?: number }) => void;
  onStartVoiceMode?: () => void | Promise<void>;
};

export function createVoiceModeHandlers(ctx: VoiceModeCtx) {
  const handleVoiceMode = () => {
    if (ctx.onStartVoiceMode) {
      void ctx.onStartVoiceMode();
      return;
    }
    ctx.toast({ title: "Voice mode unavailable", description: "The voice session controller is not ready.", duration: 3000 });
  };

  return { handleVoiceMode };
}
