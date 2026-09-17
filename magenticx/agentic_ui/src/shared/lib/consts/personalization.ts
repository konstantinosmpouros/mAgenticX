/**
 * Personalization catalogs — response-personality presets and the length caps
 * for user-authored custom instructions.
 *
 * Deliberately a LEAF (no imports): `types/preferences.ts` imports
 * `PersonalityId` from here directly rather than through the consts barrel,
 * which would otherwise close a module cycle.
 */

// Personality presets for agent responses (Settings → Personalization),
// mirroring ChatGPT's taxonomy. Ids must match the bridge registry
// (schemas.PERSONALITY_IDS) and the agents runtime/personalization.py —
// both fail closed to "default" on an unknown id, so drift degrades safely.
export const PERSONALITY_PRESETS = [
  { id: "default", label: "Default", description: "The agent's own voice" },
  { id: "professional", label: "Professional", description: "Polished and precise" },
  { id: "friendly", label: "Friendly", description: "Warm and chatty" },
  { id: "candid", label: "Candid", description: "Direct and honest" },
  { id: "quirky", label: "Quirky", description: "Playful and imaginative" },
  { id: "efficient", label: "Efficient", description: "Concise and plain" },
  { id: "cynical", label: "Cynical", description: "Critical and sarcastic" },
  { id: "nerdy", label: "Nerdy", description: "Exploratory and enthusiastic" },
] as const;

export type PersonalityId = (typeof PERSONALITY_PRESETS)[number]["id"];

export const DEFAULT_PERSONALITY: PersonalityId = "default";

// Custom-instructions field caps — mirror the bridge schema's max_length so
// the dialog enforces limits client-side (with counters) and never trips a 422.
export const CUSTOM_INSTRUCTIONS_LIMITS = {
  nickname: 100,
  occupation: 150,
  traits: 1500,
  about: 1500,
} as const;
