// ------------------------------------------------------
// User Preferences Schemas
// ------------------------------------------------------
// PersonalityId / RealtimeVoice / VoiceModeLanguage are imported from the
// consts LEAF modules directly (never the `../consts` barrel) — the barrel
// pulls in the transforms, which import back from `types/`, so going through it
// would create a module cycle.
import type { PersonalityId } from "../consts/personalization";
import type { RealtimeVoice, VoiceModeLanguage } from "../consts/voice";

// User-authored custom instructions injected into deep-agent system prompts
// while `enabled` is true. Field lengths are capped by CUSTOM_INSTRUCTIONS_LIMITS
// (mirroring the bridge schema).
export type CustomInstructions = {
  enabled: boolean;
  nickname: string;
  occupation: string;
  traits: string;
  about: string;
};

export type UserPreferences = {
  prefersAgenticChat?: boolean;
  suggestionsEnabled?: boolean;
  showMessageTokenUsage?: boolean;
  searchPastConvs?: boolean;
  useMemory?: boolean;
  personality?: PersonalityId;
  customInstructions?: CustomInstructions;
  voiceModeVoice?: RealtimeVoice;
  voiceModeLanguage?: VoiceModeLanguage;
};

// Aggregate token usage for one conversation's active branch (AI messages only),
// computed client-side from message.inputTokens/outputTokens.
export type ConversationUsage = {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  aiMessageCount: number;
  avgInput: number;
  avgOutput: number;
};
