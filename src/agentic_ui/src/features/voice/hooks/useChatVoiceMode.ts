import { useCallback } from "react";
import type { RealtimeVoice, VoiceModeLanguage } from "@/shared/lib/consts";
import { createVoiceModeHandlers } from "@/handlers/voice";
import { useRealtimeVoiceSession } from "@/features/voice/hooks/useRealtimeVoiceSession";

type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

type UseChatVoiceModeArgs = {
  toast: ToastFn;
  userId: string | null;
  selectedAgent: string;
  voiceModeVoice?: RealtimeVoice;
  voiceModeLanguage?: VoiceModeLanguage;
};

export function useChatVoiceMode({
  toast,
  userId,
  selectedAgent,
  voiceModeVoice,
  voiceModeLanguage,
}: UseChatVoiceModeArgs) {
  const voiceSession = useRealtimeVoiceSession({ toast });

  const handleStartVoiceMode = useCallback(async () => {
    if (!userId) {
      toast({ title: "Authentication required", description: "Please sign in again to use voice mode.", variant: "destructive" });
      return;
    }
    if (!selectedAgent) {
      toast({ title: "No agent selected", description: "Choose an agent before starting voice mode.", variant: "destructive" });
      return;
    }
    if (voiceSession.isActive) return;
    await voiceSession.start({
      userId,
      selectedAgent,
      voice: voiceModeVoice,
      language: voiceModeLanguage,
    });
  }, [selectedAgent, toast, userId, voiceModeLanguage, voiceModeVoice, voiceSession]);

  const { handleVoiceMode } = createVoiceModeHandlers({ toast, onStartVoiceMode: handleStartVoiceMode });

  return {
    voiceSession,
    handleVoiceMode,
  };
}
