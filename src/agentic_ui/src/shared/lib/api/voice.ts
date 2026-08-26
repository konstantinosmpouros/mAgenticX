/**
 * Voice API — read-aloud TTS, dictation transcription, and realtime session
 * creation.
 */
import type { RealtimeVoiceSessionRequest, RealtimeVoiceSessionResponse } from "../types";
import { requestBlob, requestJson } from "../http";
import { RealtimeVoiceSessionResponseSchema } from "../schemas";
import { normalizeRealtimeVoice } from "../utils";
import { type RealtimeVoice } from "../consts";
import { SPEECH_BASE_PATH, VOICE_BASE_PATH } from "./paths";

// Generate read-aloud audio for an AI message
export async function generateMessageReadAloudAudio(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<Blob> {
  return requestBlob(`${SPEECH_BASE_PATH}/read-aloud/${userId}/${conversationId}/${messageId}`, {
    method: "POST",
    csrf: true,
    accept: "audio/mpeg,audio/*",
    fallbackMessage: "Failed to generate read-aloud audio",
  });
}

// Generate a short read-aloud preview for a selected voice
export async function generateReadAloudPreviewAudio(
  userId: string,
  voice: RealtimeVoice,
  text = "Hey! I am your AI speaker.",
): Promise<Blob> {
  return requestBlob(`${SPEECH_BASE_PATH}/read-aloud-preview/${userId}`, {
    method: "POST",
    csrf: true,
    accept: "audio/mpeg,audio/*",
    body: { voice: normalizeRealtimeVoice(voice), text },
    fallbackMessage: "Failed to generate read-aloud preview",
  });
}

// Transcribe an audio dictation blob via the backend
export async function transcribeDictation(
  userId: string,
  audio: Blob,
  filename?: string,
): Promise<string> {
  const formData = new FormData();
  const safeName = filename || "dictation.webm";
  formData.append("audio", audio, safeName);

  const data = await requestJson(`${SPEECH_BASE_PATH}/dictation/${userId}`, {
    method: "POST",
    csrf: true,
    body: formData,
    fallbackMessage: "Failed to transcribe dictation",
  });

  if (!data || typeof (data as { text?: unknown }).text !== "string") {
    throw new Error("Invalid dictation response.");
  }

  return (data as { text: string }).text;
}

export async function createRealtimeVoiceSession(
  userId: string,
  payload: RealtimeVoiceSessionRequest,
): Promise<RealtimeVoiceSessionResponse> {
  return requestJson(`${VOICE_BASE_PATH}/realtime/${userId}/session`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: RealtimeVoiceSessionResponseSchema,
    fallbackMessage: "Failed to create realtime voice session",
  });
}
