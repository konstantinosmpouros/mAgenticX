// ------------------------------------------------------
// Voice Mode Schemas
// ------------------------------------------------------
// RealtimeVoice / VoiceModeLanguage come from the consts LEAF module directly
// (never the `../consts` barrel) — see the note in `./preferences`.
import type { RealtimeVoice, VoiceModeLanguage } from "../consts/voice";

// `RealtimeVoiceSessionResponse` is inferred from its Zod schema
// (see `../schemas`).
export type { RealtimeVoiceSessionResponse } from "../schemas";

export type VoiceModeStatus =
  "closed" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

export type RealtimeVoiceSessionRequest = {
  agentId: string;
  conversationId?: string | null;
  sdp: string;
  voice?: RealtimeVoice;
  language?: VoiceModeLanguage;
};

export type RealtimeVoiceConversationEventRequest = {
  conversationId: string;
  role: "user" | "assistant";
  transcript: string;
  itemId?: string | null;
  responseId?: string | null;
  rawEvent?: Record<string, any> | null;
};
