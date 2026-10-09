/**
 * User preferences API. (The Usage tab's calls live in `./usage`.)
 */
import { requestJson } from "../http";
import { WireObjectSchema } from "../schemas";
import {
  normalizeCustomInstructions,
  normalizePersonality,
  normalizeRealtimeVoice,
  normalizeVoiceModeLanguage,
} from "../utils";
import { PREFERENCES_BASE_PATH } from "./paths";

// Map the raw preferences payload (mixed camelCase) into the app shape, applying
// the same per-field defaults on both read and write so the two paths cannot
// drift. Tool disable-list entries are passed through verbatim.
function mapUserPreferences(data: unknown) {
  const record = (data ?? {}) as Record<string, unknown>;
  const suggestionsEnabled =
    typeof record.suggestionsEnabled === "boolean" ? record.suggestionsEnabled : true;
  const showMessageTokenUsage =
    typeof record.showMessageTokenUsage === "boolean" ? record.showMessageTokenUsage : false;
  const searchPastConvs =
    typeof record.searchPastConvs === "boolean" ? record.searchPastConvs : false;
  const useMemory = typeof record.useMemory === "boolean" ? record.useMemory : true;
  // Opt-in: anything but an explicit true reads as "not allowed".
  const improveModel = record.improveModel === true;
  const personality = normalizePersonality(record.personality);
  const customInstructions = normalizeCustomInstructions(record.customInstructions);
  const voiceModeVoice = normalizeRealtimeVoice(record.voiceModeVoice);
  const voiceModeLanguage = normalizeVoiceModeLanguage(record.voiceModeLanguage);

  return {
    suggestionsEnabled,
    showMessageTokenUsage,
    searchPastConvs,
    useMemory,
    improveModel,
    personality,
    customInstructions,
    voiceModeVoice,
    voiceModeLanguage,
  };
}

// Fetch user preferences
export async function getUserPreferences(userId: string) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    schema: WireObjectSchema,
    fallbackMessage: "Failed to fetch user preferences",
  });
  return mapUserPreferences(data);
}

// Update user preferences
export async function updateUserPreferences(userId: string, prefs: unknown) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    method: "PUT",
    csrf: true,
    body: prefs,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update user preferences",
  });
  return mapUserPreferences(data);
}
