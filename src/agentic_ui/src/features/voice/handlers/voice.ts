import { transcribeDictation } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type { DictationStatus } from "@/features/chat/components/ChatInputBar";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

type VoiceModeCtx = {
  toast: (opts: { title: string; description?: string; duration?: number }) => void;
  onStartVoiceMode?: () => void | Promise<void>;
};

type VoiceDictationCtx = {
  userId: string | null;
  setCurrentMessage: Dispatch<SetStateAction<string>>;
  setDictationStatus: Dispatch<SetStateAction<DictationStatus>>;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  toast: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
};

export function createVoiceModeHandlers(ctx: VoiceModeCtx) {
  const handleVoiceMode = () => {
    if (ctx.onStartVoiceMode) {
      void ctx.onStartVoiceMode();
      return;
    }
    ctx.toast({
      title: "Voice mode unavailable",
      description: "The voice session controller is not ready.",
      duration: 3000,
    });
  };

  return { handleVoiceMode };
}

export function createVoiceDictationHandlers(ctx: VoiceDictationCtx) {
  const handleDictationStatusChange = (status: DictationStatus) => {
    // Avoid redundant state writes because the recorder can emit the same status repeatedly.
    ctx.setDictationStatus((prev) => (prev === status ? prev : status));
  };

  const handleDictationSubmit = async (audioBlob: Blob) => {
    if (!ctx.userId) {
      ctx.toast({
        title: "Authentication required",
        description: "Please sign in again to continue.",
        variant: "destructive",
      });
      ctx.setDictationStatus("idle");
      return;
    }

    ctx.setDictationStatus("submitting");
    try {
      // Preserve the browser-provided extension when possible so the backend can sniff audio reliably.
      const mime = audioBlob.type || "audio/webm";
      const [, rawExt = "webm"] = mime.split("/");
      const ext = rawExt.split(";")[0] || rawExt || "webm";
      const filename = `dictation-${Date.now()}.${ext}`;
      const transcript = await transcribeDictation(ctx.userId, audioBlob, filename);
      const trimmedTranscript = transcript.trim();

      if (!trimmedTranscript) {
        ctx.toast({
          title: "No speech detected",
          description: "The transcription was empty. Please try recording again.",
          variant: "destructive",
        });
      } else {
        // Append the transcript to any existing draft instead of replacing in-progress typed input.
        ctx.setCurrentMessage((prev) => {
          if (!prev) return trimmedTranscript;
          const needsSeparator = !/\s$/.test(prev);
          return `${prev}${needsSeparator ? " " : ""}${trimmedTranscript}`;
        });
        ctx.textareaRef?.current?.focus();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Voice transcription failed. Please try again.";
      toastError(ctx.toast, "Dictation failed", error, { description: message });
    } finally {
      ctx.setDictationStatus("idle");
    }
  };

  return { handleDictationSubmit, handleDictationStatusChange };
}
